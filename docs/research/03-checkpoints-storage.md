# 03 — Checkpoints, file-change tracking, storage, observation policy (DSH 0.2.1-rc.5)

Scope: what DSH already ships for checkpoints, file-change tracking, undo/restore, observation policy and plugin persistence, so a `harness-time-machine` plugin reuses instead of re-implementing.
Method: read-only inspection of the unpacked runtime at `C:\Users\LEGION\.dsh\harness-src\@deepseek-ai\` (shipped `lib/*.js` has no `.d.ts` for most packages, so behavior is read from JS plus the package README). Citations are `<package>/<file>:<line>` with the `@deepseek-ai/` prefix omitted; `:a-b` is an inclusive range. Absent capabilities are marked **NOT FOUND**.

## 0. Verdict table

| Capability | Exists? | Package | Persisted? |
|---|---|---|---|
| Durability barrier before model request / top-level tool / agent step | yes | `dsh-session-checkpoint-policy` | session log only; **no file data** |
| Per-turn changed-file list with `+/-` counts | yes | `dsh-workspace-changes` | **no** — per Host process, in memory |
| Before/after comparison text for a changed file | yes, on demand | `dsh-workspace-changes` (`diff`) | **no** |
| Read-before-write / no-clobber enforcement | yes | `dsh-fs-observation-policy` | no (WeakMap, per session, per process) |
| File-level undo / restore / rollback API | **NOT FOUND** | — | — |
| Session truncate / rewind | **NOT FOUND**; `fork()` branches | `dsh-session` | append-only log, never rewritten |
| Durable KV for plugin data | yes | `dsh-storage` + `dsh-storage-domain` + `dsh-storage-json` | yes, under `dshHomePath('storages')` |
| Atomic single-file write + cross-process lock | yes (library) | `dsh-atomic-write` | yes, but no `fsync` |
| Changed-files card + review tab UI | yes | `dsh-client-ui-deliverables` | reads the live service |
| Raw session-log export | yes | `dsh-session-log-export` | writes an export file |

Search evidence for the missing row: the `@deepseek-ai` package list contains no `dsh-undo*`, `dsh-history*`, `dsh-snapshot*`, `dsh-revert*` or `dsh-restore*` package; a directory-name scan for `undo|history|checkpoint|snapshot|revert|restore|backup|version` matched only `dsh-session-checkpoint-policy`. This is **NOT FOUND**, not an alias.

## 1. `dsh-session-checkpoint-policy` — durability barriers, not file checkpoints

Identity and config: plugin name is `"session-checkpoint-policy"` (`dsh-session-checkpoint-policy/lib/index.js:9`), it exports only `{ apply, inject, name }` (`:78`), declares `inject = ["llm", "sessionPersistence", "sessions", "tools"]` (`:11-16`), and has **no config schema at all**. README: "The package has no configuration and adds no prompt or tool schema" (`README.md:12`).

What it does — exactly three listeners (`lib/index.js:60-76`):

1. `llm/stream` — resolve `options.sessionId`; unknown session or no session id delegates untouched; otherwise `afterCheckpoint` wraps the downstream generator so the logged request prefix is flushed before the first model chunk (`:61-65`, `:26-31`):
   ```js
   function afterCheckpoint(ctx, session, next) {
     return (async function* () { await ctx.sessions.flush(session); yield* next(); })();
   }
   ```
2. `tools/execute` — only top-level calls (`exec.agent === void 0 || exec.parent !== void 0` delegates); `await ctx.sessions.flush(exec.agent.session)`, and if `exec.signal.aborted` after the flush it returns the synthesized abort result instead of dispatching (`:66-71`). The synthesized result is `content: [{type:"text", text:"Error: tool call aborted before dispatch"}]`, `isError: true`, `error.info.name: "AbortError"`, `error.info.code: TOOL_ABORTED_BEFORE_DISPATCH` (`:32-48`).
3. `agent/pre-step` — flushes the agent's session before every step (`:72-75`).

What "flush" means: `ctx.sessions.flush(session)` dispatches the `session/flush` event to persistence callbacks with `Promise.allSettled`, throws the first failure, and reports whether any listener participated (`dsh-session/lib/index.js:1951-1968`). The session-log backend writes and `fsync`s the batch before `append` resolves (`dsh-session-persistence-jsonl/README.md:77`). So a checkpoint is a durable log barrier, not a filesystem snapshot.

What is stored: this package stores nothing itself — no service, no route, no domain, no temp files. Semantics documented as "Durable execution intent, not exactly-once effects" and "No checkpoint inside an active model attempt" (`README.md:114-115`). Checkpoint rejection is fail-closed: the adapter or tool body is not invoked (`lib/index.js:18-19`, `:55-56`).

Time-machine implication: do **not** reuse this as the snapshot hook. Equivalent hooks that run before side effects exist and are cheap to observe: `tools/pre-execute` (used by `workspace-changes`, below) and `agent/pre-step`.

## 2. `dsh-workspace-changes` — per-turn changed files from git tree snapshots (ephemeral)

Purpose: for each top-level turn, record which files changed and by how many lines, and serve a per-file before/after comparison while the Session lives in this Host process.

Service (public API), provided in `apply` (`dsh-workspace-changes/lib/index.js:1019-1022`):
```js
ctx.provide("workspaceChanges", {
  summary: (sessionId, seq) => byId.get(sessionId)?.summary(seq),
  diff: (sessionId, seq, index, signal) => byId.get(sessionId)?.diff(seq, index, signal) ?? Promise.resolve(void 0)
});
```
`seq` is the sequence number of the turn's `workspace/changes` event, `index` the file's index in `summary.files`.

Data model. The durable event carries only the turn number:
```js
this.session.append("workspace/changes", { turn: state.turn }); // :871
this.records.set(event.seq, { summary: { turn, cwd, files, total, added, deleted }, sources }); // :873-884
```
The summary keeps `{ turn, cwd, files, total, added, deleted }` with one entry per file `{ path, display, added, deleted, binary?, oversized? }` (`:924-933`). `path` is relative to the turn cwd when inside it, else absolute; `display` is the slash-separated relative/`../`/`~/`/absolute form. `cwd` is dropped by the HTTP summary route served to the browser (see §6), but present in the service object.

`diff()` returns, while the Host still holds the session (`:717-750`):
```js
{ kind: "text", path, display, before: boolean, after: boolean, hunks, coarse }
{ kind: "refusal" | "binary" | "oversized", path, display }
```
Note `before`/`after` are presence flags, **not text** (`:741-742`); an absent side is `null` in `readSide` (`:798-814`). Hunk text comes from `compareText(before, after, env.diffTimeoutMs)` (`:736`), bounded by `diffTimeoutMs` and `maxFileBytes`; the same semantics are stated from the consumer side in `README.md:48` (three context lines, `binary` on NUL/binary side, `oversized` above `maxFileBytes`, `coarse` when the line comparison exceeds `diffTimeoutMs`).

Config (schemastery, defaults): `{ timeoutMs: 30000, outputMaxBytes: 8*1024*1024, maxFiles: 500, maxFileBytes: 2*1024*1024, diffTimeoutMs: 100 }` (`:951-957`); every field must be a positive safe integer or `apply` throws `workspace-changes requires a positive integer ${field}` (`:998-1004`). `inject = ["subprocess", "fs"]` (`:949`), name `workspace-changes` (`:947`).

When it records:
- `turn/start` → new `TurnRecorder`, baseline git tree snapshot queued (`:1056-1058`).
- `fs/write-intent` / `fs/edit-intent` → registered with `{ prepend: true }`, call `next()` first, then `capture()` the pre-edit file and `await recorder.settled()` (`:1070-1085`). Capture is copy-on-write **before** the mutation, once per path per turn.
- `tool/result` → `observe(event)` records `lastToolResultSeq` so a turn only announces changes when a tool actually ran (`:1061`).
- `agent/turn-stopping` → `stopping(turn)` (`:1067-1069`).
- `turn/end` → `end(turn)` records if the last tool result came after the last agent attempt (`:1062`).
- `session/disposed` → dispose recorder (`:1064-1066`).

How: with git available, it locates the enclosing repo (`git rev-parse --show-toplevel --absolute-git-dir --git-path objects`, `:233-260`) and redirects `GIT_OBJECT_DIRECTORY` to a private scratch directory with read-only alternates, so snapshots never write into the user's object store; `snapshotTree` copies the index into scratch, runs `git add --all --ignore-errors` and `git write-tree` (`:272-311`), and the two trees are compared with `git diff-tree -r -M -z --numstat`. Scratch directory is `mkdtemp(join(tmpdir(), "dsh-workspace-changes-"))` (`:782`, `tempRoot: tmpdir()` at `:1042`); pre-edit copies go under `<scratch>/captures`. Without git, only file-tool edits are listed: `ctx.logger.info("workspace-changes: git is unavailable; only file-tool edits are summarized")` (`:1027`).

Eligibility: no recorder unless the session has a cwd and is not a subagent session — `origin === "subagent"` or `delegationDepth > 0` are skipped (`:958-961`).

Persistence: **none**. Records live in a `Map` on the recorder; `dispose()` aborts, clears records and removes the scratch tree (`:755-763`). README:86 states it plainly: "Summaries, snapshot trees, and captured copies live only as long as their Session in this Host process; earlier turns of a conversation reopened after a Host restart have no card and no comparison."

Known gaps (README): shell-only edits outside git snapshot coverage are absent; `/tmp` and platform temp paths excluded; files above `maxFileBytes` are listed with `oversized` and no counts; binary files listed with `binary`; nested repos/submodules appear as gitlinks; subagent sessions are not recorded; `core.splitIndex` and git-lfs may write into the repo's own `.git`.

## 3. `dsh-fs-observation-policy` — read-before-write/edit gate

Event-only plugin: no `inject`, no service, no filesystem I/O; it operates purely on its own `WeakMap` and three `fs/*` listeners (`dsh-fs-observation-policy/lib/index.js:80-95`). One instance per `apply()`, cleared on disposal for HMR safety (`:85-89`, `:43-46`).

State: `observed = new WeakMap()` keyed by owner (weakly held) → `Map(targetKey → observation)`, where an observation is `{ kind: "present", version }` or `{ kind: "absent" }` (`:15-22`). Owner is derived from the opaque event actor: `owner(actor) { return actor?.agent?.session }` (`:29-31`) — i.e. the agent session that performs a tool call.

Decisions:
- `writeIntent(target, actor)`: seen + present → `{ kind: "replaceIfVersion", version }`; unseen or confirmed absent → `{ kind: "createIfAbsent" }` (`:47-58`).
- `editIntent(target, actor)`: no owner or no prior observation → throws `new FsError('edit requires reading "${target.displayPath}" first', "FS_NOT_OBSERVED")`; prior absent → `FS_NOT_FOUND`; present → `{ version }` (`:59-70`).
- `observe(target, observation, actor)` records an authoritative presence/absence observation (`:71-75`).

Hooking: listeners on the waterfalls `fs/write-intent` and `fs/edit-intent`, plus the event `fs/observed` (`:90-94`). The policy only derives the guard; the fs provider performs the atomic freshness/no-clobber check and raises `FS_STALE_VERSION` itself (`dsh-fs/README.md:36`, `:72`). Tools may still mutate unconditionally when the policy is not composed.

What it does not do: no cross-session memory, no persistence across resume/restart, no content hashing. Direct `ctx.fs` reads do not emit `fs/observed`; only tool reads do, so a plugin that reads through `ctx.fs` must either publish its own observation or accept unguarded writes. The fs contract is text-only, with no delete/rename/copy operation (`dsh-fs/README.md:114-115`).

## 4. Restore / undo / rollback — NOT FOUND; closest primitives

No shipped package implements undo, revert, restore-to-checkpoint or rollback for files or sessions. Evidence: package inventory scan (§0); the fs contract has no undo and no delete (`dsh-fs/README.md:114-115`); the session log is append-only and "Committed events are never rewritten" (`dsh-session-persistence-jsonl/README.md:77`); "Nothing deletes session files — logs accumulate under `root` until removed externally; the seam has no deletion API" (`:167`); "No session tree beyond fork" (`dsh-session/README.md:205`).

Session-level branching does exist: `ctx.sessions.fork(source, boundary, childSessionId)` rejects an existing child id (`SESSION_ALREADY_EXISTS`), seeds a fresh child from the resolved event prefix, records `meta.parentSession` and `isSeeded: true`, and leaves the source untouched (`dsh-session/lib/index.js:2006-2021`); `_forkBoundary` rejects non-integer/out-of-range boundaries with `INVALID_BOUNDARY` (`:2022-2038`). This branches history; it does not roll the workspace back.

Closest primitives a time-machine can compose (all of them must be driven by the plugin):

1. `ctx.workspaceChanges.summary(sessionId, seq)` and `.diff(sessionId, seq, index, signal)` — file list and hunk-level comparison for a live turn; reverse-applicable only while the Host holds the session.
2. **Durable hunk diffs in the session log.** The `write` tool projects `presentationMeta` as `{ operation, path, diffs: [{ path, oldText, newText }] }` from `computeHunkDiffs` (`dsh-tool-fs/lib/index.js:593-601`); the `edit` tool projects `{ path, diffs: [...] }` the same way (`:738-745`). `createSuccessResult` projects and freezes it as `meta` (`dsh-tools/lib/index.js:3637-3667`), and `appendToolResult` persists it inside the `tool/result` event (`dsh-agent-loop/lib/index.js:691-707`). This survives restarts as long as the log exists, but it is changed hunks only — never a full-file snapshot.
3. Guarded restore through the fs contract: `ctx.fs.writeText(target, content, expected, signal)` where `expected` is `{ kind: "replaceIfVersion", version }` or `{ kind: "createIfAbsent" }` (`dsh-fs-local/lib/index.js:864-882`); the version is stat identity `` `${dev}:${ino}:${size}:${mtimeNs}:${ctimeNs}` `` (`:146`), so any other writer invalidates it and the write fails `FS_STALE_VERSION`. Re-read, recompute the guard, retry.
4. `str_replace_editor` (optional tool, not in any shipped bundle) for in-place reverse hunks: `view`/`create`/`str_replace`/`insert`, re-reads the file and CAS-checks the observed version when no policy supplies a guard, `maxOutputChars` default 16000 (`dsh-tool-str-replace-editor/README.md:12, :69, :120`).
5. `create_worktree({ name?, from? })` from the experimental Git Worktrees bundle (off in every shipped profile) — the closest shipped "snapshot the workspace" primitive: returns canonical `path`, new `branch`, pinned `baseCommit`, source `repositoryRoot`, and switches the Session cwd; leaving is `working_directory({ cd: path })` (`dsh-experimental-tool-worktree/README.md:28, :37, :47`).
6. `ctx.sessions.fork` + resume a child session: conversation-level branching only.

Re-appending a `tool/result` is not an undo: `session.append` only appends (`dsh-session/lib/index.js:1517`), and replaying a tool call would mutate files again. Undo must be a new forward action (write restored bytes), never a log rewrite.

## 5. Storage APIs for a plugin's own persistent data

Three layers, all shipped and already mounted in the default profile:

**Hub** — `ctx.storage` (`class Storage extends Service`) holds the backend registry and form map; `ctx.storage.<form>` resolves a mounted data form, and the domain form is additionally exposed as `ctx.storageDomain` (`dsh-storage/README.md:51`). Mount errors are loud: `backend-not-found`, `form-not-mounted`, `duplicate-backend`, `duplicate-mount` (`:56-58`). The only backend facet is `kv`; the `log` facet is deferred (`:79`, `:130`). Backend unit contract: versioned, globally-singleton schema handle, each call atomic and durable once resolved, **no serialization of concurrent writes** (ordering is the caller's job), and a stored version differing from the descriptor rejects `version-mismatch` with **no migration** (`:79`).

**Domain form** — `defineDomain` at module load, then open a handle from the plugin (`dsh-storage-domain/README.md:36-58`):
```js
const spec = defineDomain({ name: 'workspace', version: 1,
  tables: { workspaces: domainTable(workspaceRecordSchema) } });
const domain = await ctx.storageDomain.open(spec);
await domain.table('workspaces').put(id, { path: '/work/demo' });
domain.table('workspaces').get(id);            // synchronous, from memory
domain.table('workspaces').update(id, r => ({ ...r, path: newPath }));
domain.close();                                 // caller owns lifecycle
```
Validation rules enforced at module load: `name` matches `/^[a-z][a-z0-9_]*$/`, `version` is a non-negative integer, `compatibleVersions` entries are non-negative integers below `version`, `layout` is `"single"` or `"per-record"`, `invalidRecords` is only `"backup-and-skip"`, table names match, and `global.schema` must not accept `null` (null is the medium's "never written" sentinel) (`dsh-storage-domain/lib/index.js:64-71`; `README.md:36`). Runtime rules: memory is authoritative, **one write chain per domain**, each write awaits backend durability before mutating memory, then emits `domain/changed` `{ domain, table, key, operation, value? }` (`README.md:88`); `close()` rejects new writes with `DomainError("closed")`, drains, closes. No cross-table transactions, no secondary indexes, no multi-segment keys, and no data migration — a stored version differing from the spec rejects at open with `version-mismatch`, so changing a schema requires migrating the stored data by hand (`README.md:148`). Opening errors: `already-open`, `facet-unsupported`, `invalid-record`, `missing-key`, `closed` (`README.md:73`; open sequence `:94`).

Domain form config: `backend` is the required default backend name and `routes` (`{}`) overrides it per domain name — routing is decided by the domain plugin's config, never by the hub (`dsh-storage-domain/README.md:62-67`). The shipped profile routes everything to `json` (`dsh-base/cordis.patch.yml:179-190`).

**On-disk layout** (`dsh-storage-json`; config is only `root`, required; backend registers as `json`):
- Shipped root: `root: !!js dshHomePath('storages')` (`dsh-base/cordis.patch.yml:185`) → `C:\Users\LEGION\.dsh\storages\`. Live examples: `storages/schedule.json`, `storages/workspace.json`, `storages/session_projcache/sessions/<id>.json`.
- Namespacing: one unit per domain (the domain `name`, which must match the regex) with tables and record keys inside it; there is no per-tenant or per-workspace namespace beyond the domain name, and a domain cannot be created at runtime — it must be declared at module load. A time machine should therefore put the workspace/session id in record keys, or declare one domain per concern (`snapshots`, `manifests`, `tombstones`).
- `single` layout: `<root>/<unit>.json` holding `{ unit: { name, version }, global, tables }`; whole unit rewritten per write (`dsh-storage-json/README.md:12`, `:72`, `:140`).
- `per-record` layout: `<root>/<unit>/<table>/<key>.json` with `{ version, record }`, plus `<root>/<unit>/global.json` (`:88`); keys must match `[a-zA-Z0-9_-]+`, unsafe keys are rejected before any file operation (`:56`); malformed or out-of-range-version documents read as absent, so one bad document does not reject the unit (`:56`).
- Bootstrap: an empty `per-record` tree can initialize from a legacy `<root>/<unit>.json` when the name matches and the version is current/compatible; the source file is left untouched (`:58`).

**Atomicity and limits:** each write uses a temporary file opened `"wx"` mode `0o600`, write, fsync, atomic `rename()`, then a parent-directory fsync on POSIX (`README.md:74`; `src/atomic.ts`). Guarantees stop there: **no cross-process write locking** — two processes writing the same unit can interleave, last-completion wins (`:141`); on Windows the rename relies on libuv (`MoveFileExW`) with no explicit write-through (`:142`); `single` rewrites the whole unit on every write and costs grow with record size (`:140`). No per-record transaction, no multi-record atomicity.

**Large blobs (file contents) — use `dsh-atomic-write` instead of a KV record:** `writeFileAtomic(path, content, { mode })` and `withFileLock(path, async () => ..., { waitMs })` are exported library primitives with cross-process writer serialization, bounded Windows retry on `EACCES/EBUSY/EPERM`, fresh-inode replacement and permission narrowing (`dsh-atomic-write/README.md:12`, `:28-57`). Caveat: "it does not provide ... crash durability because it does not call `fsync`" (`:12`). Recommended split for snapshots: small JSON metadata/manifests in a `per-record` domain (one record per snapshot, per file entry), blob contents under a plugin-owned directory written with `dsh-atomic-write` + `withFileLock`, keeping each JSON record tiny.

## 5.5 Session-log format and migrations (reading file-change history)

`dsh-session-format` is a pure library, not a Cordis plugin (`dsh-session-format/README.md:2`, `:30`). Persistence composes it rather than parsing raw JSONL:
```js
const catalog = createSessionFormatCatalog({ currentVersion, codecs, currentEncoder,
  migrations, restoreCurrent, restoreTransformedCurrent, restoreCurrentHeader }) // :35
const descriptor = catalog.readHeader(physicalHeader)   // current | migration-required | unsupported | malformed
const restore = catalog.createRestore(physicalHeader, { recovery: 'recoverable', validation: 'transformed' }) // :37
restore.decodeRow(row); ...; const current = restore.finish() // :44
```
`readHeader()` classifies without reading events; the chain validates unique gap-free adjacent ordering at construction; one row decoder plus stateful adjacent transformers are composed, and only the caller decides whether to publish the result (`README.md:44`, `:58`). Production historical reads use `recovery: 'recoverable'` + `validation: 'transformed'`; `strict` + `current` is for workers and fixtures (`dsh-session-format-catalog/README.md:46`).

Shipped migration edges: `dsh-session-format-v0-to-v1`, `-v1-to-v2`, `-v2-to-v3`, `-v3-to-v4`. The catalog restores V0–V3 and binds child evidence to V3→V4 (`dsh-session-format-catalog/README.md:12`, `:50`); V3→V4 "lifts tool results, renames message sources, closes evidenced interrupted turns, and appends missing parent catalog facts" (`dsh-session-format-v3-to-v4/README.md:12`). The live profile therefore stores `session.v4.jsonl.zstd`: write-open migrates and publishes a successor without overwriting, read-open migrates without publishing, and the source stays byte-identical (`dsh-session-persistence-jsonl/README.md:87`). A plugin that reads history must go through this catalog (or accept only current V4 files) — handmade JSONL parsing will mis-handle retired shapes — and everything it extracts is post-migration: `tool/result.meta` hunks survive, full-file snapshots never existed.

## 6. How the shipped UI obtains file-change info

The changed-files surface is owned by `dsh-client-ui-deliverables`, **not** by `dsh-client-ui-trajectory`.

Node half: `inject` includes `"workspaceChanges"` (`dsh-client-ui-deliverables/lib/index.js:246-255`) and registers authenticated routes through Connection's auth fence (`:48-99`):
```js
ctx.connection.fetch.register({ path, methods, requestBody: "buffered", fetch: (request) => ... })
```
Routes: `/api/changes.summary` GET (`:4`), `/api/changes.diff` GET (`:6`), `/api/changes.open` GET/POST (`:8`). Handlers:
- `handleChangesSummary` returns `{ turn, files, total, added, deleted }` from `ctx.workspaceChanges.summary(id, seq)` and deliberately omits the Host `cwd` (`:170-185`, `:177-184`); 404 body `"Change summary unavailable."`.
- `handleChangesDiff` returns the raw `diff()` object, 404 `"Change comparison unavailable."` (`:200-212`).
- `handleChangesOpen` resolves `workspaceFiles.stat({ sessionId, workspaceRoot: changes.cwd }, file.path, signal)` and then `openVerified` for desktop open/reveal (`:213-236`).

Browser half: `deliverablesDefinition` folds the latest validated `workspace/changes` announcement per turn into `DeliverablesTurnData.changes`; the card is registered in `conversation.chat.turnTail`; each row opens the review tab at `dsh-resource://changes-review/session/<sessionId>/<seq>/<turn>` via `ctx.sidebarRight.openResource`, tab type registered at the `builtin` band with its body under `sidebar.right.pane.tab` (`dsh-client-ui-deliverables/README.md:67`, `:49`, `:45`). The card is absent when the Host no longer serves the summary (restart, plugin removed, no files) (`:28`). Review comparisons are the turn snapshot, not current content (`:49`); the route serves the full hunk text, including ignored files and files outside the workspace root (`:119`); rendering stops at 5,000 lines.

Trajectory is a different concern: a pure projection of session events (turn-aware ledger, tool calls, tokens, timing) with no file-change surface (`dsh-client-ui-trajectory/README.md:12`, `:56`, `:70`). It does retain raw tool presentation metadata/structure errors (`:58`), but it does not render changed files.

Event vocabulary: `workspace/changes` is a first-party known session event (`dsh-session/lib/types/known-event-types.js:83`), appended with only `{ turn }` (`dsh-workspace-changes/lib/index.js:871`). Session-log tooling exists separately: `dsh-session-log-export` (raw log export) and `dsh-client-ui-settings-session-log` (settings page).

For a new UI: fastest path is to reuse the deliverables routes (`/api/changes.summary|diff`) for live turns; anything persisted must be exposed through new authenticated `ctx.connection.fetch.register(...)` routes plus a plugin-registered tab seat, since the deliverables card is turn-tail-only and reads the live service.

## 7. Risks and design constraints for the time-machine plugin

1. **Nothing durable exists to lean on.** Captures/comparisons are per Host process (`dsh-workspace-changes/README.md:86`); a plugin must own snapshot persistence. Persisted `tool/result.meta` hunks (§4.2) are the only restart-surviving file-change trace, and they are partial.
2. **Concurrent writers.** fs versions are stat identity (`dsh-fs-local/lib/index.js:146`), not content hashes; any editor/build/agent write between read and restore yields `FS_STALE_VERSION`. storage-json has no cross-process lock (`dsh-storage-json/README.md:141`); two Hosts sharing `~/.dsh/storages` is last-completion-wins. Use `withFileLock` for RMW cycles and always re-read before a guarded restore.
3. **Capture cost and size caps.** Whole-file copies up to `maxFileBytes` (2 MiB) per first mutation per path per turn, up to `maxFiles` 500; memory + temp growth; `diffTimeoutMs` 100 ms degrades to "all lines replaced" (`coarse`); oversized/binary content is not captured at all. A time machine needs its own size policy and back-pressure.
4. **Ignored/expensive trees and `.git`.** `.git`, `node_modules`, build output, nested repos (gitlinks), git-lfs and `core.splitIndex` can touch the user's `.git`; the built-in tracker redirects object storage to scratch but still runs `git add --all` on a copied index; shell-only edits outside git coverage are invisible (e.g. `rm`, `mv`, `git checkout`, `npm install`).
5. **Deletions have no tombstone store.** The fs contract has no delete (`dsh-fs/README.md:114-115`); deletions surface only as an absent diff side or git numstat. A time machine must record deletes itself (path + hash + timestamp), otherwise restore of a deleted file is impossible.
6. **Secrets.** `tool/result.meta` hunk text and scene comparisons can carry `.env` values, tokens, private paths; storage JSON is plaintext under `~/.dsh`; there is no encryption primitive shipped. Redact/exclude by path pattern and avoid persisting full contents by default.
7. **Subagent writes are not tracked.** `workspace-changes` skips `origin === "subagent"` and `delegationDepth > 0` (`dsh-workspace-changes/lib/index.js:958-961`), yet subagents mutate files through the same `ctx.fs`. Decide explicitly whether snapshots cover delegated writes.
8. **No session rollback, ever.** Log is append-only, no truncate/delete API (`dsh-session-persistence-jsonl/README.md:77`, `:167`); `fork` only copies a prefix (`dsh-session/lib/index.js:2006-2021`). "Undo" must be modeled as a new action + new events.
9. **Observation policy is session-scoped and non-persistent.** After a Host restart a restore write needs its own read first (`FS_NOT_OBSERVED` on edit) or an unguarded `writeText`; bypassing the gate is the unsafe path, so prefer read → guard → write.
10. **Windows/line-ending edges.** storage-json rename has no write-through on Windows (`dsh-storage-json/README.md:142`); `read`/`edit` normalize line endings (`restoreLineEndings`, `dsh-fs-local/lib/index.js:891`), so byte-identical restore needs explicit byte-level handling; case-insensitive paths can alias.
11. **Do not call the flush policy a checkpoint.** `dsh-session-checkpoint-policy` flushes logs only; naming a file-snapshot feature after it would mislead operators during recovery.

## 8. Reuse map (concrete)

- Snapshot hook: `tools/pre-execute` (`exec` → `exec.agent.session`, `exec.arguments`) and/or `agent/pre-step`; snapshot before side effects, not after.
- Tracked-data source of truth: copy of `ctx.workspaceChanges.summary(...)` / `.diff(...)` when live; persisted snapshot manifests elsewhere.
- Path/read primitives: `ctx.fs.processPath(target)`, `ctx.fs.stat(target, signal)`, `ctx.fs.readText`, `ctx.fs.readBytes(target, signal, maxBytes)` (`dsh-fs-local/lib/index.js:802-848`).
- Restore write: `ctx.fs.writeText(target, content, { kind: "replaceIfVersion", version }, signal)`; on `FS_STALE_VERSION` re-read and retry; on `FS_NOT_OBSERVED` read first.
- Persistence: `defineDomain({ name: 'time_machine', version: 1, layout: 'per-record', tables: {...} })` + `ctx.storageDomain.open` for metadata; `writeFileAtomic`/`withFileLock` for blobs.
- UI: reuse `/api/changes.summary|diff` for live turns (deliverables), or register own routes with `ctx.connection.fetch.register` and a `sidebar.right.pane.tab` seat.
- UI projection (if log-derived): `ctx.sessionProjections.register(definition)` (`dsh-session-projection/README.md:58-63`); state schemas are checkpointed by `session-projection-cache` (`:69`), so keep it small and versioned.

## 9. Not found / open

- File-level undo, restore, revert, rollback: **NOT FOUND**.
- Session truncate/rewind or event deletion: **NOT FOUND** (fork only).
- Persisted per-turn diffs from `workspace-changes`: **NOT FOUND** (in-memory only).
- Tombstone/deletion store for files: **NOT FOUND**.
- Cross-process locking in `storage-json`: **NOT FOUND** (`dsh-storage-json/README.md:141`); use `dsh-atomic-write` `withFileLock`.
- Storage schema migration: **NOT FOUND** (version mismatch rejects; plugin must migrate itself).
- Storage SQLite backend: **NOT FOUND** in this unpack (README references it as an alternative; not in the shipped package set).
- `dsh-client-ui-session-log` as a separate package: **NOT FOUND**; only `dsh-client-ui-settings-session-log` (settings page) ships.
