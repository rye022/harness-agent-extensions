# Architecture — Harness Agent Extensions

Status: **Phase 0 complete, V0.1 implemented and tested** (see [Verification](#verification)).

This document is the contract between the two plugins and DeepSeek Harness. Every
claim about the Harness is cited against the shipped source
(`…/resources/app.asar/dsh/node_modules/@deepseek-ai/*`, extracted to
`~/.dsh/harness-src` for reading); the research notes it is distilled from are in
[`docs/research/`](research/).

Target runtime: **DSH desktop 0.2.1-rc.5**, Node **24.21.0**, Cordis **4.0.5**,
pnpm 11.28.5. The desktop app boots a *profile* — a directory with
`cordis.patch.yml`, `package.json` and `pnpm-workspace.yaml`, managed by
pnpm — and mounts every bundle listed in `package.json#dsh.profile.bundles`.

## 1. What a plugin is allowed to do

A DSH plugin is an ordinary Cordis plugin: a function, class, or object with
`apply(ctx, config)` (`cordis/src/registry.ts:92-95`), optionally carrying
`{ name, Config, inject, provide }` metadata (`:100-111`). Cordis loads it from a
`cordis.patch.yml` row:

```yaml
- insert:
    - id: harness-ext-time-machine
      name: '@harness-ext/time-machine'
      config: { … }
```

Row shape is `{ id, name, config?, group?, disabled?, inject? }`
(`cordis-plugin-loader/src/config/entry.ts:10-23`); `config` is replaced
wholesale by the row, and `!!js` values are evaluated against the plugin context
(`cordis-plugin-loader/src/config/utils.ts:5-9`). `ctx.effect(fn)` registers
disposers that run in reverse order on unload (`cordis/src/fiber.ts:415-417,676`).

Three consequences drive every design decision in this repository:

1. **Plugins are not sandboxed.** They are plain ESM and may `require('node:fs')`.
   Not touching another plugin's data is a convention we follow, not something
   the loader enforces. Both plugins therefore own a private directory under
   `$DSH_HOME` and never write into `~/.dsh/sessions`, `~/.dsh/storages` or a
   profile.
2. **The core is off limits.** No row, service or file inside `app.asar` is
   patched by this project. Everything here rides documented extension points
   (services, waterfalls, events) or writes files the core never opens.
3. **Disposers must be honest.** A plugin that fails to release tools or
   timers leaves the profile in a half-broken state after `plugin remove`, so
   both packages register every handle through `ctx.effect`.

```mermaid
flowchart LR
  subgraph Harness["DeepSeek Harness (unmodified)"]
    Loop["agent loop<br/>tool calls · turns"]
    FS["ctx.fs<br/>write-intent · edit-intent"]
    Log[("session log<br/>session.v4.jsonl.zstd")]
    Meter["tokenMeter service"]
    Loop --> Log
    Loop --> FS
  end

  subgraph TM["@harness-ext/time-machine"]
    Cap["capture<br/>(waterfall hooks)"]
    Store[("objects/ + checkpoints.jsonl")]
    Tools1["tm_* tools"]
    Cap --> Store
    Tools1 --> Store
  end

  subgraph CO["@harness-ext/context-os"]
    Ingest["ingest<br/>(session/event)"]
    DB[("context.db<br/>SQLite + FTS5")]
    Brief["budget → brief"]
    Tools2["co_* tools"]
    Ingest --> DB
    Tools2 --> DB
    DB --> Brief
  end

  FS -->|write/edit intent| Cap
  Log -->|session/event| Ingest
  Meter -.->|measure()| Brief
  Store -->|checkpoint/created · restored| DB
```

Arrows into a plugin are the only coupling: the Harness never knows these
packages exist, and the two plugins know each other only through an optional
event bus.

## 2. Session events — the capture surface

The event vocabulary is a closed set of 62 types
(`dsh-session/lib/types/known-event-types.js:21-84`) and each record carries
`{ type, seq, time, data, surfaceOp?, sourceEventSeqs?, ignorable? }`
(`dsh-session/lib/types/index.js:127`). Tool activity is exactly two events:

- `tool/call` — `{ turn, step, callId, name, arguments }` where `arguments` is
  the raw JSON **string** (`dsh-agent-loop/lib/index.js:682`);
- `tool/result` — `{ turn, step, message, error?, meta? }` appended with
  `sourceEventSeqs: [callSeq]` (`:697-706`).

For `write`/`edit`/`read` the resolved path and the before/after text also appear
in `result.data.meta = { path, before, after, diffs }`
(`dsh-tool-fs/lib/index.js:593,738`). For `pwsh` the meta is only `{ cwd }`
(`dsh-tool-pwsh/lib/index.js:626`), and `str_replace_editor` emits no
presentation metadata at all — **shell-mediated edits are not reconstructable
from the event stream.** This is the single most important limitation of a pure
event-replay checkpoint system, and the reason both plugins also intercept the
file-intent waterfalls (§3).

Subscribe with `ctx.on('session/event', (session, event) => …)`; live sessions
are only reachable through `ctx.sessions.get/list`
(`dsh-session/lib/index.js:1980,1987`), cold logs through
`readColdSessionLog` (`dsh-session-query/lib/index.js:34`). Logs live at
`~/.dsh/sessions/<projectKey>/<sessionId>/session.v4.jsonl.zstd`, one multi-frame
zstd stream with one JSON event per line
(`dsh-session-persistence-jsonl/lib/index.js:908-932`).

Plugin-specific records are allowed but must be marked `ignorable: true`
(`dsh-session/lib/types/index.js:394,684`). Neither plugin appends to the session
log in V0.1: the log belongs to the session, and a checkpoint is our own record.

## 3. What already exists (and is therefore reused, not reimplemented)

| Capability | Shipped package | How we reuse it |
| --- | --- | --- |
| Per-turn change tracking | `dsh-workspace-changes` | Same two hooks (`fs/write-intent`, `fs/edit-intent`) and the same `workspaceChanges` service shape (`lib/index.js:1019,1055-1094`). We persist images; it keeps temp copies for the UI card. |
| Durable session flush | `dsh-session-checkpoint-policy` | Untouched. **Name collision only**: its "checkpoint" is a store flush before a model request, not a file checkpoint. |
| Token accounting | `dsh-token-meter` (`tokenMeter.measure`, `lib/index.js:687,722-765`) | Read-only. When a provider usage anchor exists we report `basis: 'usage'`, otherwise `'estimated'`. |
| Compaction | `dsh-compaction-basic` (or `billion-context`, which structurally replaces it) | Never started, never bypassed. Context OS only contributes bounded text. |
| Full-text session search | `dsh-session-query` + `node:sqlite` FTS5 (`dsh-session-query-sqlite/lib/index.js:50,106`) | Same engine, our own database. |
| Client UI transport | `window.__ModuleLoader__.load({ id, factory })`, `dsh.client` field | Only if a client panel is added; V0.1 ships tools + host routes. |

Nothing in either package re-implements change tracking, token counting,
compaction or session search.

## 4. Agent Time Machine

### 4.1 Data model

```
$DSH_HOME/time-machine/
  objects/<aa>/<hash>…        content-addressed blobs (sha256, text and binary)
  checkpoints.jsonl           append-only journal of CheckpointRecord
  tmp/                        write-then-rename staging
```

`CheckpointRecord` (`packages/time-machine/src/core/types.ts`):

```ts
{ schema: 1, id, createdAt, createdAtMs, origin: 'auto-tool'|'auto-turn'|'manual'|'pre-restore',
  label?, sessionId?, turn?, step?, tool?, parentId?, workspaceRoot?, cwd?,
  files: [{ path, before, after?, sizeBefore?, sizeAfter?, kind, tool? }],
  tests?: [{ callId?, command, status, exitCode?, summary?, at }],
  error?, stats? }
```

`before`/`after` are content hashes (`null` = file absent). `undefined` distinguishes
"never captured" from "captured as deleted", which is what makes a restore plan
sound. `origin` encodes why a checkpoint exists; `parentId` chains checkpoints of
one session.

### 4.2 Capture

Two sources, in this order of trust:

1. **File intents** (authoritative). `fs/write-intent` / `fs/edit-intent` are
   waterfalls: `async (target, actor, next)` where `actor` is the `ToolExecution`
   (`dsh-fs` → `dsh-fs-sandbox` → `writeText`, `dsh-fs-sandbox/lib/index.js:53,125,139`).
   We read the pre-image *after* `next()` returned but before the write happens,
   and attribute it to `actor.name` / `actor.callId`.
2. **Turn boundary** (coverage). `turn/start` may snapshot the workspace
   (`scanWorkspace`), so files changed by a shell command are still recoverable
   as a coarse turn-level checkpoint. This is opt-in (`capture.workspaceSnapshotOnTurnStart`)
   because a scan costs a full hash pass.

`turn/end` finalizes the buffered turn into one `auto-turn` checkpoint and emits
`checkpoint/created`. A failed `tool/result` becomes a `CheckpointTestResult` so a
checkpoint can answer "was this tested?".

First-touch-wins per path per turn: restoring the *first* pre-image of a turn is
the only useful semantics (the last one would restore a half-edited file).

### 4.3 Restore safety

`planRestore` builds the plan without writing anything:

- for every entry, compute the current image and classify
  `write | delete | unchanged | unverifiable`;
- **conflict** when the current hash is neither the target nor the image the
  checkpoint left behind (`expected`) — i.e. somebody edited the file since;
- report `safe` only when there are no conflicts and no missing blobs.

`applyRestore` refuses a non-safe plan unless `force: true`, writes via
temp-file+rename, then **re-hashes every written file** and returns
`{applied, failed, verified}`; the plugin throws when `verified` is false, so a
silent partial restore cannot be reported as success.

Before any restore the plugin creates a `pre-restore` checkpoint of the affected
paths, and the tool returns its id so the restore itself is undoable.

### 4.4 Tools

`tm_checkpoint`, `tm_list`, `tm_diff`, `tm_restore`, `tm_status`
(`packages/time-machine/src/tools.ts`). `tm_restore` is the only mutating tool and
it is the only one that requires `force` for an unsafe plan.

### 4.5 What Time Machine does not do

- It never reverts a database, a network request, an external service or a
  shell command's side effects — only file contents inside the workspace.
- It does not restore model context. Restoring files and rolling back a session
  are different operations; see §6.
- It does not capture files above `maxFileBytes` (2 MiB) or files matching the
  ignore policy (`.git`, `node_modules`, `.env`, keys). Those entries are
  recorded as `oversized`/ignored, never silently dropped.

## 5. Context OS

### 5.1 Layers and scopes

| Layer | Content | Scope | Lifetime |
| --- | --- | --- | --- |
| L1 | user request, open errors, files in flight | session | TTL (12 h), dropped on prune |
| L2 | goals, todos, decisions, contracts, progress, checkpoints | workspace | until superseded |
| L3 | compaction summaries, session digests, long-term notes | global | TTL (30 d) |

Every record stores `layer`, `kind`, `scope`, `source {kind, ref}`, `importance`,
`createdAt`, `updatedAt`, `expiresAt?`, `stale?`, `contentHash`. The `source.ref`
is the session sequence number, which is what makes "re-read the original" (§5.4)
possible.

Scope ids are derived, not configured: `ws_<sha256(cwd)[0..12]>` for a workspace,
`s_<sessionId>` for a session, `global` for global. L1 is deliberately
session-scoped so a parallel session in the same workspace does not inherit
another task's transient state.

### 5.2 Store

`node:sqlite` `DatabaseSync` at `$DSH_HOME/context-os/context.db`:

```sql
memories(id PK, layer, kind, scope_kind, scope_id, title, body, tags,
         source_kind, source_ref, importance, created_at, updated_at,
         expires_at, stale, content_hash)
UNIQUE(content_hash, scope_kind, scope_id)      -- de-duplication
memories_fts USING fts5(memory_id UNINDEXED, search_text,
                        tokenize='unicode61 remove_diacritics 2')
```

The FTS row is rewritten by hand on every write (no triggers): the plugin is the
only writer, and explicit reindexing is easier to reason about than trigger
ordering. Chinese has no spaces, so `toSearchText` emits one token per CJK
character and `toMatchQuery` turns a CJK run into a quoted phrase — that keeps
`unicode61` usable without a segmentation dictionary.

Ranking: `bm25()` (negated) × importance boost × recency boost; expired ×0.2,
stale ×0.5. If the MATCH expression is malformed the store falls back to a
`LIKE` scan — a recall must never break a turn.

### 5.3 Budget

`conservative | balanced | saver` differ in *when* a brief is contributed and
how large it may be (`packages/context-os/src/core/budget.ts`):

| mode | threshold | brief cap | retain floor |
| --- | --- | --- | --- |
| conservative | 85 % | 1.2 % of window | 10 % |
| balanced | 70 % | 0.9 % | 20 % |
| saver | 50 % | 0.6 % | 15 % |

The retain floor is capped at half of the remaining room
(`reserve = min(retainTokens, floor(free / 2))`), so a brief that fits can still be
contributed at high pressure instead of being locked out by a floor larger than
`free`. A brief is refused when the usable space (`free - reserve`) is < 80 tokens,
or when the window is already exhausted (pressure ≥ 100 %, `free ≤ 0`). This is the
mechanism against the classic failure mode of "compress until the turn breaks": the
brief never takes more than half the headroom, and the decision always explains
itself in `co_status`, `budget/decided` and `$DSH_HOME/context-os/decisions.jsonl`.

### 5.4 Brief composition

`buildBrief(store, { scope: [session, workspace, global], query?, maxTokens })`
adds sections in priority order — Request → Open errors → Files in flight →
Decisions & contracts → Progress & todos → Recalled — and stops adding lines when
the budget runs out, marking `truncated`. A tiny budget therefore yields the most
important section, not a truncated salad. Records keep their `source.ref`, so the
original events can be re-read (`readColdSessionLog` / `SessionQueryEngine`).

### 5.5 Injection (off by default)

The model actually *seeing* a brief requires appending to the pre-step message
list: `agent/pre-step` waterfall payload `{ messages, turn, step, signal }`,
default result `{ kind: 'enter', messages }` (`dsh-agent-loop/lib/index.js`,
`dsh-compaction-basic/lib/index.js:302-308,839`). It is the one place a plugin can
break a turn, so:

- `inject.enabled` defaults to **false**;
- when enabled, the plugin prepends, checks for the `[Context OS brief]` marker,
  injects at most once per turn, and swallows every error back to the original
  result;
- `co_brief` offers the same text on demand without touching the message list.

### 5.6 Tools

`co_remember`, `co_recall`, `co_brief`, `co_status`, `co_forget`
(`packages/context-os/src/tools.ts`).

### 5.7 What Context OS does not do

- It never starts, schedules or replaces a compaction loop. `compaction-basic`
  or `billion-context` stays the owner; if `billion-context` is installed it
  disables `compaction-basic` structurally and takes over the wire — Context OS
  merely contributes text.
- It does not summarise the transcript (compaction already does).
- It does not use an embedding API or a vector index. An adapter is a possible
  later addition, never a requirement.
- It does not index assistant prose (largest, least reusable part of a
  transcript).

## 6. Interoperability

Optional, one-directional, and safe when either side is absent:

```
Time Machine ──checkpoint/created──▶ Context OS  (records "checkpoint cp_… covering N files")
             ──checkpoint/restored─▶ Context OS  (marks file/decision/contract/progress stale)
```

Wiring uses `ctx.inject(['timeMachine'], …)`, so Context OS simply never runs the
callbacks when Time Machine is not installed. Context OS never blocks on Time
Machine, and Time Machine has no dependency on Context OS.

**File restore ≠ session restore ≠ context rebuild.** A restored checkpoint makes
file-derived memories unreliable; it does not rewrite history, and the model's
context is rebuilt only by compaction or by the user. Marking memories `stale`
(rank ×0.5, never deleted) is the honest representation of that.

## 7. UI extension

Harness client plugins are lazy CJS bundles registered through
`dsh.client` + `window.__ModuleLoader__.load({ id, factory })`
(`dsh-client-modules/lib/client.js:1-6`) and mount into named slots via
`ctx.slots.register`. A client bundle requires the app's React/primitives
toolchain, which is not part of this repository yet.

V0.1 therefore ships the **host interface** — five Time Machine tools, five
Context OS tools, two services (`ctx.timeMachine`, `ctx.contextOs`) and two event
buses — which is usable from chat today and is the prerequisite for a client
panel tomorrow. A read-only web panel served from `ctx.webServer.register`
(a small HTML page over the service API) is the planned intermediate step; it
needs no core change and no React build.

## 8. Verification

Proven by the repository's own tests (`pnpm test`, Node 24 runs the TypeScript
directly — **76 tests, all passing**):

- 10 shared tests (diff engine, ignore policy, hash, tokens, JSONL, atomic write);
- 9 Time Machine core tests (object store, index damage tolerance, capture,
  restore conflict detection, re-hash verification, concurrent-modification guard
  between plan and apply);
- 4 Time Machine plugin tests against a fake context (mount, waterfall capture,
  tool restore, disposal) and 4 against the real Cordis runtime;
- 11 Context OS store tests (dedupe, CJK recall, scopes, TTL, stale, prune, LIKE
  fallback, v0→v1 migration, refusal of a newer schema);
- 11 Context OS budget/brief/ingest tests;
- 8 Context OS plugin tests (mount, capture, tools, disposal, bad config);
- 2 compaction-retention tests (request, goal, open error and file in flight
  survive a summary; recall still reaches the original request);
- 3 interop tests (both bundles in one real Cordis context, disjoint tool names,
  checkpoint mirrored into a memory, independent disposal);
- 10 packaging tests (manifest fields, bundle patch, peer ranges, unique ids,
  built entry exports a Cordis plugin).

Proven by `pnpm bench` (reproducible fixtures, assertions in the runner):

- a 2.4 MiB / 800-file workspace scans in ~0.12 s, snapshots in ~2.4 s, and a
  20-file turn capture in ~0.1 s; a forced restore of 20 files applies and
  re-verifies in <0.1 s;
- 40 unique-token queries over 1 240 memories: hit@1 1.00, hit@5 1.00, MRR 1.00,
  p50 0.21 ms, zero cross-workspace leaks;
- a brief capped at 900 tokens keeps 8/8 critical records at a 29× compression
  ratio, built in ~2–3 ms.

Proven by `pnpm bench:scale` (10 000 files, 11.9 MiB, opt-in):

- scan 1 069 ms (0.107 ms/file), full snapshot 12 851 ms (0.92 MiB/s, capped at the
  default `maxFiles` 5 000), turn capture 26 ms per 20-file turn independent of
  repository size, 5 000-entry restore plan 1 885 ms, 50-file restore 499 ms;
- the shape matters more than the numbers: capture cost is per touched file, while
  snapshot and plan cost scale with the tree.

Proven by a live Harness boot:

- both packages install into a real profile (`dsh plugin --profile tmv1 add …`) and
  appear in `dsh --profile tmv1 --dump-config` with their patch rows and full
  config blocks;
- both plugins mount inside a real DSH process: the web build served
  `http://127.0.0.1:3312/` (200 with token, 401 without) and Context OS created
  `$DSH_HOME/context-os/context.db` with the `memories` + FTS5 schema;
- an earlier headless run created `$DSH_HOME/time-machine/{objects,tmp}`.

Not proven (honest gaps):

- a full agent turn with capture+restore inside the desktop app (a headless run
  needs a provider credential; the desktop account grant is not usable from the
  CLI);
- exclusive-fullscreen/browser-fullscreen behaviour of any UI panel (no panel yet);
- Windows path edge cases beyond the workspace root (junctions, UNC paths).

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| A restore overwrites work done after the checkpoint | Conflict detection + `force` required; pre-restore checkpoint; dry-run first |
| Store growth (objects × files) | Content addressing + `keep.maxCheckpoints` compaction + GC of unreferenced blobs |
| A broken plugin config takes the profile down | `normalizeConfig` never throws; store-open failure disables features instead of failing the mount |
| Brief injection breaks a turn | Off by default, marker-checked, once per turn, errors swallowed |
| Two plugins fighting over compaction | Context OS never compacts; it only contributes text |
| Privacy: memories contain user text | Store stays in `$DSH_HOME`, no network, no embedding API; `co_forget` and TTLs exist |

## 10. Open questions

1. Should `tm_restore` be an approval-gated tool (it mutates files)? Today it
   requires `force` for unsafe plans but is not approval-gated.
2. Session-level restore (fork + replay) is out of scope for V0.1; the Harness
   has `buildForkSeed`/`fork`, so a later version could offer "restore files *and*
   fork the session at the checkpoint's turn".
3. How aggressive should turn-boundary workspace snapshots be by default? Today
   they are opt-in precisely because they cost a full hash pass per turn.
