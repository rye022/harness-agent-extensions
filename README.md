# Harness Agent Extensions

Independent, open-source plugins for DeepSeek Harness. The repository contains two
installable Cordis plugins and a shared library: a file-level time machine for agent
edits, and a layered context store that keeps requirements and decisions alive across
compaction. The plugins attach to existing Harness extension points; no Harness core
file is modified. They can be installed into a profile, tested without a running
Harness, and removed without leaving foreign data in the Harness databases.

## What problem this solves

Agents edit files quickly and without a durable undo. A bad refactor or an
accidental delete usually has no checkpoint that survives the turn, and session
history does not contain the previous bytes. Time Machine records file images in a
content-addressed store and exposes a conflict-aware restore path.

Context compression is lossy in a different way: the transcript may survive, but
the requirement, the accepted interface contract, or the reason for a decision often
does not. Context OS captures those facts as records with layers, scopes, and expiry,
then renders a bounded brief when the context is under pressure.

Both plugins solve these problems from the outside. Time Machine reads session events
and the filesystem; Context OS reads session events and writes its own SQLite database.
Neither one changes the Harness core, starts a second compaction loop, or writes into
another plugin's data.

## Packages

| Package | What it does | Tools | Service |
| --- | --- | --- | --- |
| `@harness-ext/time-machine` | Content-addressed file checkpoints, per-turn auto checkpoints, diffs, and safe restore. | `tm_checkpoint`, `tm_list`, `tm_diff`, `tm_restore`, `tm_status` | `ctx.timeMachine` |
| `@harness-ext/context-os` | Layered memory (L1/L2/L3), SQLite FTS5 recall, token-budget decisions, and bounded briefs. | `co_remember`, `co_recall`, `co_brief`, `co_status`, `co_forget` | `ctx.contextOs` |
| `@harness-ext/shared` | Hashing, path policy, ignore rules, line diff, JSONL journals, fs helpers, token estimates, and a typed event bus. Used by both plugins; not a plugin itself. | None | None |

The two plugins do not depend on each other. Context OS optionally listens to Time
Machine events when `ctx.timeMachine` is present.

## Automatic mode

Once the bundles are mounted, both plugins do their main work without a tool call:

- **Time Machine** registers the `fs/write-intent` and `fs/edit-intent` waterfalls.
  Every agent write or edit is captured before the mutation runs, deduplicated by
  SHA-256, and committed as an `auto-turn` checkpoint when the turn ends. Nothing is
  asked of the model. Shell commands are not captured: `pwsh` has no such waterfall,
  so an edit made through a shell script leaves no image.
- **Context OS** subscribes to `session/event`. User messages, goals, failing tool
  results, touched file paths, compaction summaries and session titles become memory
  records on their own, scoped to the session, the workspace or the global namespace,
  and pruned on turn end.
- **Context OS can also inject a brief on its own.** When context pressure crosses the
  mode threshold, `agent/pre-step` appends one short `[Context OS brief]` user message
  holding the requirements, open errors, decisions and in-flight files that a
  compaction would otherwise drop. This is `inject.enabled`; it is off by default
  because it rewrites the model request.

To enable the automatic brief in a profile, add id-targeted rows to
`$DSH_HOME/profiles/<name>/cordis.patch.yml`. That layer is applied after every bundle
layer, so it replaces the bundle defaults:

```yaml
- id: harness-ext-time-machine
  name: "@harness-ext/time-machine"
  config:
    enabled: true
- id: harness-ext-context-os
  name: "@harness-ext/context-os"
  config:
    enabled: true
    mode: conservative # triggers at 85 % of the window
    windowTokens: 131072
    inject:
      enabled: true
      minSteps: 3 # never touch the first steps of a turn
```

The modes trade safety for tokens: `conservative` triggers at 85 % of the window with
a 25 % retain floor and a 1.2 % brief cap, `balanced` at 70 % / 20 % / 0.9 %, `saver`
at 50 % / 15 % / 0.6 %. The retain floor always wins, so no mode fires when the free
room is smaller than the budget it must keep. Removing a bundle stops all of it:

```bash
dsh plugin --profile desktop remove @harness-ext/time-machine @harness-ext/context-os
```

The budget is measured against the window the harness actually reports (`contextPressure.contextWindow`), not the configured `windowTokens` default — a stale default makes every pressure decision wrong. Every decision is appended to `$DSH_HOME/context-os/decisions.jsonl`, so "why was no brief injected?" is answerable after the fact.

## Use it on another computer

Signing in to the same DeepSeek account on another machine does **not** carry the
plugins over. Only model credentials follow the account; profiles, bundles and both
stores are plain files under `$DSH_HOME` (`~/.dsh`). A second machine starts without
them.

Two ways to set them up there:

1. **Release assets.** Download the three tarballs plus `install.ps1` / `install.sh`
   from the latest release into one folder and run the installer. It copies the
   shared tarball into the profile, writes the `overrides:` entry pnpm needs, and adds
   both bundles:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile desktop
   ```

   ```bash
   ./install.sh --profile desktop
   ```

2. **From source.** Clone the repository, run `pnpm install`, `pnpm build`, `pnpm pack`
   for the three packages, and follow the tarball steps above.

The target machine needs DeepSeek Harness desktop `0.2.1-rc.5`: the bundle patches
declare compatibility with that release only, and a different build may reject or
ignore the rows.

Optional: to keep the history, copy `$DSH_HOME/time-machine/` (checkpoint journal and
object store) and `$DSH_HOME/context-os/context.db`. Quit DeepSeek Harness first and
copy the `context.db-wal` / `context.db-shm` siblings along with the database,
otherwise the most recent writes stay behind.

## Requirements

- DeepSeek Harness desktop `0.2.1-rc.5`. The bundle patches declare compatibility
  with that release only.
- Node.js `>=22.12.0` for the installed plugins.
- pnpm `11.28.5` for development. The root `package.json` pins it through
  `packageManager`.
- Node.js 24 is recommended for development. The test script runs TypeScript files
  directly and relies on Node's type stripping; there is no test transpiler.

The repository contains only TypeScript and Node built-ins. There is no native
build step and no bundler.

## Quick start (development)

```bash
pnpm install
pnpm test
pnpm build
pnpm typecheck
```

`pnpm test` runs every `packages/*/test/**/*.test.ts` file with `node --test`. It
executes the TypeScript sources directly, so use Node 24 for the test suite. At the
time of writing the suite contains 73 tests and all of them pass. `pnpm build` writes
`lib/` for each package with `tsc -b`; `pnpm typecheck` runs the same project build
with verbose output. Use `pnpm clean` to remove the build output.

## Install into a DeepSeek Harness profile

Clone the repository anywhere and work from that checkout:

```bash
git clone https://github.com/rye022/harness-agent-extensions.git
cd harness-agent-extensions
pnpm install
pnpm build
```

Everything below is relative to that checkout. The desktop profile is managed by the
Electron app. Install into it from tarballs built in this repository, then restart the
app. The examples use a profile named
`desktop`; substitute your profile name.

### 1. Build and pack

Build first: the published entry point is `lib/index.js`, and `pnpm pack` includes
`lib/`. Each `pack` command prints the tarball it wrote; by default the tarball is
created in the package directory.

```bash
pnpm install
pnpm build
pnpm --filter @harness-ext/shared pack
pnpm --filter @harness-ext/time-machine pack
pnpm --filter @harness-ext/context-os pack
```

The shared tarball is named `harness-ext-shared-0.1.0.tgz`; the plugin tarballs are
`harness-ext-time-machine-0.1.1.tgz` and `harness-ext-context-os-0.1.1.tgz`.

### 2. Make the shared package resolvable

The plugin tarballs depend on `@harness-ext/shared@0.1.0`. That package is not
published, so pnpm cannot fetch the transitive dependency from a registry. Point it
at the local tarball with an `overrides:` entry in the profile's
`pnpm-workspace.yaml`. pnpm 11 reads overrides from this file; it ignores
`pnpm.overrides` in `package.json`.

Copy the shared tarball into the profile directory first:

```bash
cp packages/shared/harness-ext-shared-0.1.0.tgz "$DSH_HOME/profiles/desktop/"
```

`$DSH_HOME` defaults to `~/.dsh` when it is not set. Then append the override to
`$DSH_HOME/profiles/desktop/pnpm-workspace.yaml`:

```yaml
overrides:
  '@harness-ext/shared': 'file:./harness-ext-shared-0.1.0.tgz'
```

The profile already has a `packages:` list and other pnpm settings; add the
`overrides:` block rather than replacing the file. The path is relative to the
profile directory.

### 3. Add the plugins and restart

```bash
dsh plugin --profile desktop add packages/time-machine/harness-ext-time-machine-0.1.1.tgz
dsh plugin --profile desktop add packages/context-os/harness-ext-context-os-0.1.1.tgz
```

If the tarballs were written somewhere else, pass their actual paths. Restart the
DeepSeek Harness desktop app after both commands; the desktop profile is loaded by
the Electron app at startup, and a restart is required for the new bundles to mount.

## Usage

The tools are model-facing. In a chat, the agent calls them; a user can also ask for
a specific operation. The examples below are illustrative: ids and line counts are
shortened, and the exact rendered text depends on the Harness tool renderer.

### Time Machine: inspect, dry-run, restore

After a turn that edited files, the agent can list the automatic checkpoint:

```text
tm_list { "origin": "auto-turn", "limit": 5 }
```

A shortened result:

```text
cp_01j9m2...  auto-turn  2026-...  3 files  turn 12
cp_01j9k8...  auto-turn  2026-...  1 file   turn 11
```

Restore is always planned first. A dry run reports what would change and whether the
current files still match the checkpoint:

```text
tm_restore { "id": "cp_01j9m2...", "side": "before", "dry_run": true }
```

```json
{
  "dryRun": true,
  "safe": true,
  "writes": 2,
  "deletes": 0,
  "unchanged": 1,
  "unverifiable": 0,
  "conflicts": []
}
```

When the plan is safe, apply it. Applying creates a `pre-restore` checkpoint of the
affected paths before it writes, so the restore itself can be undone:

```text
tm_restore { "id": "cp_01j9m2...", "side": "before" }
```

```json
{
  "dryRun": false,
  "applied": 2,
  "failed": [],
  "safetyCheckpoint": "cp_01j9n1..."
}
```

If a file changed since the checkpoint, the plan reports a conflict. The restore is
refused unless `force: true` is passed. Use `tm_diff` to inspect the difference
before forcing, and `tm_list` to find the right checkpoint or its parent.

### Context OS: recall and brief

`co_recall` searches the current workspace scope plus global memories. Omitting the
query lists the most important records instead of using full-text search:

```text
co_recall { "query": "retry policy", "scope": "workspace", "limit": 5 }
```

```text
- [L2/decision] Retry policy is capped at three attempts (score 0.91)
  The HTTP client retries only idempotent requests; 429 and 503 are retried...
- [L2/contract] HttpClient.send must keep its AbortSignal parameter (score 0.84)
  ...
```

`co_brief` renders the memory that should survive compaction, trimmed to a token
budget. It is useful after a compaction or when the conversation feels lossy:

```text
co_brief { "query": "HTTP client refactor", "max_tokens": 900 }
```

The text follows the section order described in
[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md): request, open errors, files in
flight, decisions and contracts, progress and todos, then optional long-term recall.
The `query` argument is optional. In V0.1 it is only used for the long-term recall
section; it is not inferred from the latest user message.

### A short session flow

1. The user asks for a refactor and states a constraint: keep the public
   `HttpClient.send` signature.
2. The agent records the constraint with `co_remember` and edits two files. Time
   Machine captures the pre-images and closes an `auto-turn` checkpoint at turn end.
3. A compaction removes the earlier discussion. The agent calls `co_brief` and
   `co_recall` to recover the constraint and the open error.
4. A later edit breaks a test. The agent calls `tm_list`, then `tm_restore` with
   `dry_run: true`, then applies the safe plan. The pre-restore checkpoint remains
   available if the undo was the wrong move.

## Safety model

- **Content-addressed storage.** File images are SHA-256 objects under
  `$DSH_HOME/time-machine/objects/`; identical content is stored once. A checkpoint
  holds hashes, not copies of the whole tree.
- **Ignore policy.** Built-in rules skip VCS directories, `node_modules`, caches,
  common secret files (`.env`, `*.pem`, `*.key`, SSH keys, credentials), and
  symlinks. Files above `maxFileBytes` (2 MiB by default) are recorded as oversized
  metadata without content, so they cannot be restored.
- **Plan before write.** `tm_restore` computes a plan without touching the
  filesystem. It classifies each path as write, delete, unchanged, unverifiable, or
  conflicting, and refuses a conflicting plan unless `force: true` is set.
- **Pre-restore checkpoint.** Before applying any write or delete, Time Machine
  snapshots the affected paths into a `pre-restore` checkpoint.
- **Re-hash verification.** Every file written by a restore is hashed again. A
  restore with an unverified write is reported as failed, not as done.
- **Scope.** Snapshots scan the workspace root. A restore writes only the paths
  named in the checkpoint and its plan; there is no background scan or mutation of
  other directories, profile data, or the Harness session stores.
- **Local only.** Neither plugin makes network requests. Context OS uses SQLite FTS5;
  there are no embeddings, no vector index, and no external model calls.
- **No core mutation.** The plugins do not modify Harness core files, do not append
  to Harness session logs, and do not write other plugins' storage.

## Limitations

- **Shell-mediated edits are not reconstructable from events.** `pwsh` results carry
  only a working directory, and `str_replace_editor` emits no file metadata. Time
  Machine's event capture covers `write` and `edit` intents. The opt-in
  `capture.workspaceSnapshotOnTurnStart` adds a coarse turn-start snapshot that can
  restore the whole workspace, but it is a full scan per turn and is off by default.
- **No client GUI in V0.1.** The shipped surface is the five `tm_*` tools, the five
  `co_*` tools, the two Cordis services, and the event buses. A read-only client panel
  is planned; it is not implemented.
- **Restoring files is not restoring model context.** Time Machine can put file bytes
  back. It cannot rewind the conversation, the session log, or the model's context.
  Context OS can mark related memories stale after a restore, but it does not rebuild
  a session or replay a turn.
- **Read-only with respect to the Harness and other plugins.** Neither plugin edits
  Harness core code, session logs, profile files, or another plugin's database. A
  file restore can of course change files that other tools also use; that is the
  intended effect.
- **No session-level restore.** Checkpoints are file-level. There is no supported way
  to restore an entire session or a conversation transcript.
- **Platform edges.** Symlinks and Windows junctions are not captured. UNC paths and
  Windows junction/reparse-point edge cases are not covered by the test suite.
- **Synthetic benchmarks only.** The benchmark corpus is generated; it is not a
  production trace and the numbers are machine-dependent.

## Testing and benchmarks

Run the test suite from the repository root:

```bash
pnpm test
```

The runner is `node --test`. The current suite has 73 tests:

| Area | File | Tests | Coverage |
| --- | --- | --- | --- |
| Shared primitives | `packages/shared/test/diff.test.ts` | 10 | line diff, hunks, edge cases |
| Time Machine core | `packages/time-machine/test/core.test.ts` | 9 | object store, garbage collection, turn capture, first-touch-wins, ignore policy, restore plan, delete restore, damaged journal, concurrent-modification guard |
| Time Machine plugin | `packages/time-machine/test/plugin.test.ts` | 4 | mount, capture at turn end, `tm_restore`, conflict refusal, `ctx.effect` disposal, with a fake Cordis context |
| Time Machine Cordis | `packages/time-machine/test/cordis.test.ts` | 4 | mount under real Cordis 4.0.5, `fs/write-intent` capture, tool round-trip, disposal |
| Context OS store | `packages/context-os/test/store.test.ts` | 11 | remember/stats, dedupe, Chinese FTS recall, scope isolation, expiry, stale marking, forget, prune, malformed MATCH fallback, v0 migration, newer-schema refusal |
| Context OS core | `packages/context-os/test/core.test.ts` | 11 | budget profiles, threshold, retain floor, 80-token refusal, overrides, live request preference, section ordering, truncation, ingest mapping, ignored events |
| Context OS plugin | `packages/context-os/test/plugin.test.ts` | 8 | service and tools, L1 capture, L2 goals, open errors, remember/recall round-trip, brief cap, disposal, bad config |
| Compaction retention | `packages/context-os/test/compaction.test.ts` | 2 | request/goal/error/file survive a summary; recall still reaches the original request |
| Two plugins together | `tests/interop.test.ts` | 3 | both bundles in one real Cordis context, disjoint tool names, checkpoint mirrored into memory, independent disposal |
| Packaging | `tests/packaging.test.ts` | 10 | manifest fields, `dsh.bundle.patch` shape, compatibility note, peer ranges, built entry exports |
| Tool pipeline | `tests/tool-runtime.test.ts` | 1 | every tool executed through the real `ToolRuntime` of `@deepseek-ai/dsh-tools`: text blocks, JSON round-trip, no error results |

After `pnpm build`, the compiled `lib/` output is what `pnpm pack` ships and what a
profile loads; the test suite always runs the TypeScript sources, so it needs no
build step. The root `tsconfig.base.json` uses project references, so build order is
handled by `tsc -b`.

### Benchmarks

```bash
pnpm bench
```

`pnpm bench` runs `node benchmarks/run-all.ts`. It executes three synthetic
benchmarks and writes `benchmarks/results/latest.json` and `latest.md`:

- `bench-checkpoint.ts` builds an 800-file workspace of about 3 KiB per file and
  measures a workspace scan, a full snapshot, five turns of 20 edited files, restore
  planning (including a conflicting plan), a forced restore with verification, a
  diff of a 120k-character rewrite, and the resulting object-store and journal
  footprint.
- `bench-recall.ts` seeds 1200 filler records and 40 unique-token targets (Latin and
  Chinese) and measures seed time, hit@1, hit@5, mean reciprocal rank, recall latency
  p50/p95, and cross-workspace scope leaks. It asserts minimum hit rates and a zero
  leak count.
- `bench-brief.ts` seeds 8 critical records and 600 filler records and measures
  critical-record coverage at 300, 900, and 3000 token budgets, brief build latency
  p50/p95, and an unbounded-budget build. It also prints the budget decision for
  each mode at 25%, 50%, 70%, and 92% pressure.

Pass a suite name to run only that suite:

```bash
node benchmarks/run-all.ts brief
```

The runner exits non-zero when a benchmark's assertion fails. Results are
machine-dependent and are not a compatibility promise. `benchmarks/probe-sqlite.cjs`
is an environment probe for Node, SQLite, FTS5, and tokenizer availability; it is not
part of `pnpm bench`.

### Large repository benchmark

```bash
pnpm bench:scale
```

`pnpm bench:scale` is the opt-in large-repository run (about a minute on an NVMe
laptop). It writes 10 000 files (11.9 MiB) into a temporary workspace and measures the
two paths that touch every file:

| Step | Measured (Node 24, NVMe, Windows) | Scale |
| --- | --- | --- |
| workspace scan | 1 069 ms for 10 000 files | 0.107 ms/file, linear |
| full snapshot (default `maxFiles` 5 000) | 12 851 ms, 0.92 MiB/s | linear in bytes |
| turn capture, 20 files | 26 ms median | proportional to files touched, not repo size |
| restore plan vs 5 000 entries | 1 885 ms (50 writes, 4 950 unchanged) | one hash per entry |
| restore apply, 50 files | 499 ms, verified | per file |

Two consequences worth knowing before pointing Time Machine at a monorepo:

- Turn capture is the cheap mode and is the default: 26 ms per turn regardless of
  repository size, because only the files a turn touched are hashed.
- Full snapshots are size-bound (`maxFiles` defaults to 5 000, `maxFileBytes` to 2 MiB,
  and both are configurable). On a 10 000-file repository the default snapshot covers
  half the tree; raise `maxFiles` deliberately and expect roughly 1 MiB/s.
- A plan is rebuilt by hashing every entry, so plan cost grows with the checkpoint, not
  with the number of drifted files. Restore the smaller of `before`/`after` side, or
  narrow the checkpoint with `onlyPaths`, when a 100 000-file tree matters.

Set `BENCH_SCALE_FILES` to change the file count, for example `BENCH_SCALE_FILES=2000
node benchmarks/bench-scale.ts`. Nothing in this run is asserted: absolute numbers
depend on the disk far more than on the code.

## Repository layout

```text
harness-agent-extensions/
├── packages/
│   ├── shared/                 # hashing, ignore policy, diff, JSONL, fs, tokens, bus
│   ├── time-machine/           # plugin, tools, checkpoint store, restore, scan
│   └── context-os/             # plugin, tools, SQLite store, budget, brief, ingest
├── benchmarks/                 # synthetic checkpoint, recall, and brief benchmarks
├── docs/
│   ├── CONFIGURATION.md        # every configuration key for both plugins
│   └── research/               # design notes and upstream API research (00-06)
├── ARCHITECTURE.md             # design rationale, limitations, verification matrix
├── CONTRIBUTING.md             # development and review workflow
├── README.md                   # this file
├── README.zh-CN.md             # Chinese translation of this file
├── LICENSE                     # MIT
├── package.json                # pnpm workspace root and scripts
├── install.ps1                 # installer for a DSH profile (Windows)
├── install.sh                  # installer for a DSH profile (macOS/Linux)
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md): design rationale, extension points, data
  models, safety rules, limitations, and the verification matrix.
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md): every configuration key, budget
  mode, normalisation rule, and data location.
- [CONTRIBUTING.md](CONTRIBUTING.md): setup, conventions, adding a tool or test, and
  the review checklist.
- [README.zh-CN.md](README.zh-CN.md): Chinese translation of this README.
- Design notes: [00-architecture-review.md](docs/research/00-architecture-review.md),
  [01-cordis-core.md](docs/research/01-cordis-core.md),
  [02-session-events.md](docs/research/02-session-events.md),
  [03-checkpoints-storage.md](docs/research/03-checkpoints-storage.md),
  [04-context-compaction.md](docs/research/04-context-compaction.md),
  [05-tools-permissions-config.md](docs/research/05-tools-permissions-config.md),
  [06-ui-client.md](docs/research/06-ui-client.md).

## Status and license

V0.1.0. The packages are not published to npm; install them from tarballs as shown
above. The host API is usable, but the client panel is still planned.

MIT. See [LICENSE](LICENSE). Contributions are welcome; read
[CONTRIBUTING.md](CONTRIBUTING.md) first.
