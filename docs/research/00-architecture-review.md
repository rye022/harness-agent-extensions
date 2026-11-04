# Architecture — Harness Agent Extensions

This document is the Phase‑0 deliverable: it explains **what the shipped DeepSeek Harness
runtime actually provides**, what it does *not* provide, and how the two plugins in this
monorepo attach to it. Every non-obvious claim carries a `package/file:line` citation back to
the unpacked `app.asar` of the installed desktop build, so the statements can be re-checked
against the real artifact rather than taken on faith.

Two plugins are built here:

| Package | Purpose |
| --- | --- |
| `@harness-ext/time-machine` | Durable, content-addressed **file** checkpoints per turn/tool call, diffs, and conflict-aware restores (undo/redo of the *workspace*). |
| `@harness-ext/context-os` | Three-layer agent memory (L1 active / L2 working / L3 long-term) with FTS5 retrieval, token accounting, and **cooperative** compaction support. |

Both are ordinary Cordis plugins loaded from a profile's `cordis.patch.yml`. Neither modifies
Harness core, neither shadows an existing service name, and both can be disabled
independently without the other or the harness failing to boot.

---

## 1. Runtime baseline

- Desktop runtime: `@deepseek-ai/dsh-desktop-runtime` **0.2.1-rc.5**, placed under
  `…/resources/app.asar/dsh/` (`dsh/package.json`), bundling node 24.21.0 and pnpm 11.28.5
  (`resources/runtime/versions.json`).
- Cordis core: `@deepseek-ai/cordis` **4.0.5**; loaders `cordis-plugin-loader` 1.0.6,
  `cordis-plugin-group` 1.0.5, `cordis-plugin-include` 1.0.10.
- ~307 published `@deepseek-ai/dsh-*` packages ship inside the asar; each publishes real
  `lib/types/*.d.ts` to npm at the same version, so this repository type-checks against the
  true declarations instead of re-declaring them.

## 2. Plugin contract (Cordis)

A plugin is a function, a class, or an object with `apply` (`cordis/src/registry.ts:92-95`); the
metadata that matters here is `{ name?, Config?, inject?, provide? }` (`:100-111`).
Real third‑party plugins in this profile use the function form and export
`name`/`inject`/`Config` next to `apply` (verified on `dsh-token-diet/lib/index.js:30-39`), with
`Config = undefined` and manual normalization of the raw config object
(`dsh-token-diet/lib/index.js:225-231`).

Load gating: `inject` names services; the plugin fibre stays pending until every named service
has a provider, and a service swap forces unload+reload because the dependency epoch is derived
from provider fibre ids (`cordis/src/fiber.ts:614-622`). Disposal runs through
`ctx.effect(fn)` (`fiber.ts:415-417`), whose disposers run in reverse order.

Packaging fields the runtime actually reads (`dsh-app-boot/lib/index.js:279-326,519-531`):

```jsonc
{
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },   // file or list
    "client": { "platform": "web" }                // browser half, optional
  }
}
```

`dsh.compatibility.dshReleases` and `dsh.manifestVersion` are **marketplace metadata only** —
nothing in the shipped runtime reads them. This repository still declares
`dshReleases: { "0.2.1-rc.5": "compatible" }` for the plugin market, and treats it as a label.

Patch rows are `EntryOptions { id, name, config?, group?, disabled?, inject? }`
(`cordis-plugin-loader/src/config/entry.ts:10-23`); a `- insert:` row appends a plugin, and an
existing row overridden **by id** has its config replaced wholesale (no deep merge).

### Consequences for this repo

- We register our tools through `ctx.tools.register(defineTool(...))` and never touch the agent
  loop.
- We never `ctx.provide()` a name the harness already owns. Time Machine provides
  `timeMachine`, Context OS provides `contextOs`; neither name exists in the shipped tree.
- Everything that can be a library (object store, journal, diff, retrieval) is written as a
  framework‑free module first and covered by `node --test`. The Cordis file is a thin adapter,
  so a harness upgrade cannot silently invalidate the core logic.

## 3. State the runtime already keeps (and what we reuse)

### 3.1 Session event log — the only durable record

`SessionEvent` records are `{ type, seq, time, data, surfaceOp?, sourceEventSeqs?, ignorable? }`
(`dsh-session/lib/types/index.js:127`), with a closed vocabulary of 62 types
(`dsh-session/lib/types/known-event-types.js:21-84`). Records appended by plugins must carry
`ignorable: true` (`:394`, `:358`), which is also the forward‑compatibility mechanism.

Tool activity is exactly two event types:

- `tool/call` `{ turn, step, callId, name, arguments: string }` (`dsh-agent-loop/lib/index.js:682`)
- `tool/result` `{ turn, step, message, error?, meta? }` with `sourceEventSeqs:[callSeq]`
  (`:697-706`)

For `write`/`edit`/`read` the result also carries `meta = { path, before, after, diffs }`
(`dsh-tool-fs/lib/index.js:593,738`). Shell tools carry only `{ cwd }`
(`dsh-tool-pwsh/lib/index.js:626`) and `str_replace_editor` publishes no meta — so **file
changes made by arbitrary shell commands are not reconstructable from the event log**. That is
why Time Machine both (a) records observed intents and (b) can take an explicit workspace
snapshot.

Sessions live at `~/.dsh/sessions/<projectKey(cwd)>/<sessionId>/session.v4.jsonl.zstd`
(`dsh-session-persistence-jsonl/lib/index.js:908-932`), format version 4.

### 3.2 `dsh-session-checkpoint-policy` is *not* a file checkpoint

Its three listeners (`llm/stream`, `tools/execute`, `agent/pre-step`) flush the session store to
disk and fail closed if the flush fails (`dsh-session-checkpoint-policy/lib/index.js:26-75`). It
has no configuration, no service and no file content. Time Machine is therefore not duplicating
it, but the name collision is real and is called out in the READMEs.

### 3.3 `dsh-workspace-changes` — closest shipped feature

Per turn it snapshots the git working tree into a private scratch repo and copies every
file‑tool edit *before* the mutation (`maxFileBytes` 2 MiB, `maxFiles` 500), exposing
`ctx.workspaceChanges.summary(sessionId, seq)` / `.diff(sessionId, seq, index, signal)`
(`dsh-workspace-changes/lib/index.js:1019-1022`). Three hard limits drove our design:

1. Its captures live in memory: after a Host restart the change cards are gone
   (`dsh-workspace-changes/README.md:86`).
2. The `workspace/changes` session event carries only `{ turn }` (`lib/index.js:871`).
3. It produces **hunks for display**, not restorable images, and it excludes subagent sessions
   (`:958-961`).

Time Machine therefore persists full pre/post images in its own store, keyed by content hash,
with an append‑only journal. It hooks the *same* waterfalls (`fs/write-intent`,
`fs/edit-intent`) rather than reimplementing mutation interception.

### 3.4 Storage, settings, jobs

- `ctx.storageDomain.open(defineDomain({name, version, tables}))` gives small JSON tables with
  atomic rename, no transactions, no migrations (`dsh-storage/lib/index.js`). Suitable for
  settings‑like records, **not** for file blobs. Time Machine keeps its own filesystem store
  under `$DSH_HOME/time-machine/`.
- Config fields marked `.volatile()` become editable settings sections, and edits are written
  back to the profile's `cordis.patch.yml` (`dsh-settings/lib/index.js:413-501`). We keep our
  configuration plain so it can be edited either way.
- `ctx.jobs.start({...})` exists but is in‑process only and needs the jobs controller; long
  restores are therefore synchronous, cancellable through the tool's `exec.signal`.

### 3.5 Filesystem API and its guards

`ctx.fs` resolves a path to an `FsTarget { targetKey, displayPath }` (`dsh-fs/lib/types/types.d.ts:52-60`)
and performs guarded writes (`createIfAbsent` / `replaceIfVersion`), with the observation policy
supplying the version (`dsh-fs-observation-policy/lib/index.js:51-75`). `displayPath` may be
relative, absolute, or a remote URI — so our hooks resolve it defensively and skip non‑local
targets instead of guessing.

Restores do **not** go through `ctx.fs`: they must be able to write files the agent never read
(and must work when the target lies outside the watched roots), so they use an atomic
write‑temp‑rename of our own, then re‑hash what was written.

## 4. Context, tokens, compaction

- `tokenMeter` (`dsh-token-meter/lib/index.js:687`) is the authoritative measure:
  `measure(session, requestHeader?)` → `{ logRevision, baseline, surfaceDeltaTokens, totalTokens,
  surfaceTokens, nodes }` (`:722-765`). Provider usage is used as an anchor only when the request
  header matches; otherwise a `chars/4` heuristic applies. It also publishes the
  `tokenUsage` / `contextPressure` / `contextBreakdown` projections.
- `compaction-basic` is the concrete compactor (`dsh-compaction-basic/lib/index.js:800-818`):
  threshold `floor(min(window*.8, window - reservedCompletion - headroom))`, triggered from
  `agent/pre-step` and related events (`:839-887`). The only contribution waterfall is
  `compaction/summary-error` (`dsh-compaction/lib/index.js:1013-1024`).
- Third‑party `billion-context` replaces that loop entirely: its `dsh.bundle.patch.yml` sets
  `compaction-basic: {auto:false}`, inserts `bili-native` + `bili-compaction-gate`, and rewrites
  the `inject` lists of the presets. It exposes tools such as `compress`/`decompress`/
  `search_context`/`acp_status` through a remote manifest, and intercepts `llm/stream` to rebuild
  the wire view.

Design rule taken from this: **Context OS never starts a second automatic compaction loop.**
It observes `compaction/*` events, contributes optional *inputs* (retrieved memory, budget
advice) and exposes tools the model can call. If `billion-context` is installed, Context OS
still works against the post‑compaction surface through projections and the event log.

## 5. UI/client surface

Client halves are declared as `dsh.client { platform, inject?, external?, immediately? }`
(`dsh-client-modules/lib/index.js:62-76`); the bundle path is `exports["./client"]` and must be
a `window.__ModuleLoader__.load({...})` factory, not an ES module (`lib/client.js:1-6`).
Slot names are fixed, e.g. `main`, `sidebar.panellist`, `conversation.view`,
`settings.section` (`dsh-client-ui-*`).

Phase 1 ships **tools first** and no client bundle: the `settings.section` / `main` slots are
documented here but only used after the tool layer is stable, exactly as the brief requires
(no UI work that forces core changes).

## 6. Plugin composition in a profile

```
$DSH_HOME/profiles/<profile>/cordis.patch.yml
  - insert:
      id: harness-ext-time-machine
      name: '@harness-ext/time-machine'
      config: { ... }
  - insert:
      id: harness-ext-context-os
      name: '@harness-ext/context-os'
      config: { ... }
```

Both packages ship `dsh.bundle.patch`, so `dsh plugin add`/`remove` in a profile wires and
unwires them without editing composition by hand. Independent disable is tested: each plugin's
`apply()` registers its own disposers and tolerates the other being absent.

## 7. Safety model

1. **Nothing is written during a plan.** `planRestore` only hashes the current files.
2. **Conflicts block writes.** A file whose current hash differs from the hash the checkpoint
   left behind is a conflict; `applyRestore` refuses before touching disk unless `force` is
   passed explicitly by the model *and* the user has confirmed in the same tool call.
3. **A pre‑restore checkpoint is always created first**, so undoing an undo is possible.
4. **Secrets are never captured**: path patterns and directory rules (`.env*`, `*.pem`, `*.key`,
   `.git/`, `node_modules/`, …) are excluded by policy, and oversized/binary files are recorded
   as `oversized`/`binary` without content.
5. **Failure is visible**: the journal records `error`/`note` per entry, `verify()` re-hashes
   objects, and the tools report `verified: false` instead of claiming success.
6. **No rollback of irreversible operations**: only file content is restored. Commands,
   network calls and database writes are explicitly out of scope and are reported as
   "unverifiable" when they are the only evidence of a change.

## 8. Known limits

| Limit | Why | Mitigation |
| --- | --- | --- |
| Shell-driven edits are not attributed per file | tool/result meta is `{cwd}` only | per‑turn workspace snapshot (`capture.mode: 'turn'`) or explicit `tm_checkpoint` |
| Remote FS backends unsupported | `displayPath` may be a URI | target skipped and noted; local workspace checkpoints still work |
| No cross‑process locking | storage has none; two Hosts may share a home | journal appends are atomic per file and validated on read; ambiguity is reported, never silently merged |
| Restored files ≠ restored model context | the context is a separate substrate | Context OS marks affected memory records stale after a restore |
| No UI yet | client bundles need platform modules | tools + JSON output; UI planned after v0.1 |
