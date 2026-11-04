# 02 — Session event/log model: what a plugin can observe about turns and tool calls

DSH 0.2.1-rc.5. Source of truth: the unpacked runtime at
`C:\Users\LEGION\.dsh\harness-src\@deepseek-ai\<package>\`. Every claim cites
`<package>/<file>:<line>` with the real minimal signature. READ-ONLY investigation;
nothing was executed against a live session.

## 1. Canonical event vocabulary
`dsh-session/lib/types/known-event-types.js` is a generated, closed catalog (header
comment `:1-20`): produced by `scripts/gen-persistence-catalog.ts`, and the persistence
read path refuses a type outside the set unless the event carries `ignorable`. The set
opens at `:21`, closes at `:84`. Verbatim, with a line gutter:

```js
21  export const KNOWN_SESSION_EVENT_TYPES = new Set([
22    'agent-preset/selected',
23    'agent/inbox/spliced',
24    'approval/asked',
25    'approval/decided',
26    'approval/policy',
27    'assistant/attempt',
28    'assistant/message',
29    'command/done',
30    'command/run',
31    'compaction/end',
32    'compaction/prune',
33    'compaction/start',
34    'compaction/summary',
35    'deliverables/presented',
36    'developer/message',
37    'feedback/message-delete',
38    'feedback/message-put',
39    'feedback/record',
40    'goal/change',
41    'hook/invoked',
42    'hook/result',
43    'image/offload',
44    'job/registered',
45    'job/settled',
46    'llm/retry',
47    'llm/retry-started',
48    'model/selection',
49    'permission/preset',
50    'plan/mode',
51    'request/context',
52    'request/header',
53    'sandbox/mode',
54    'schedule/change',
55    'session-log-deepseek/delivery-accepted',
56    'session/end-seed',
57    'session/title',
58    'session/title-llm-request',
59    'step/end',
60    'step/start',
61    'subagent/catalog',
62    'subagent/descriptor',
63    'subagent/model-selection-policy',
64    'system/message',
65    'team/member',
66    'team/message/delivered',
67    'team/message/queued',
68    'team/task',
69    'todo/write',
70    'tool-workflow/agent-end',
71    'tool-workflow/agent-start',
72    'tool-workflow/run-end',
73    'tool-workflow/run-start',
74    'tool/call',
75    'tool/ptc-dispatch',
76    'tool/ptc-dispatch-start',
77    'tool/result',
78    'turn/end',
79    'turn/start',
80    'user/message',
81    'web/deepseek-search-llm-request',
82    'working-directory/change',
83    'workspace/changes',
84  ]);
```

`dsh-session/lib/types/known-event-types.js:86`
`export const MESSAGE_PROJECTION_EVENT_TYPES = new Set([` holds only `'image/offload'`
(`:87`) — every other type reaches the transcript through a registered projection.

### 1.1 The event record
Exact TS type (declaration blob `dsh-api-session-controller/lib/typert.host.js:2807`;
byte-identical copies ship inside ~12 packages):

```ts
interface SessionEvent { type: string; seq: SessionSeq; time: number; data: unknown;
  surfaceOp?: 'append' | { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq };
  sourceEventSeqs?: readonly SessionSeq[]; ignorable?: true }
```

Guard: `dsh-session/lib/types/index.js:127`
`function assertSessionEventEnvelope(value, index)` — allows exactly `'type'`,
`'seq'`, `'time'`, `'data'`, `'surfaceOp'`, `'sourceEventSeqs'`, `'ignorable'`
(`:135-141`, else `seed event at index ${index} has an invalid event envelope`);
string type, non-negative safe-integer `seq`, integer `time`, `data !== undefined`,
`ignorable` only `true` (`:150-156`). Branded scalars and version:
`dsh-session/lib/types/types.js:7` `SessionId(id)`, `:15` `SessionSeq(value)`,
`:26` `SessionLogOffset(value)`, `:54` `export const SESSION_FORMAT_VERSION = 4;`.

Production: `dsh-session/lib/index.js:1517` `append(type, data, ...opts)` — snapshots
`data` (`:1523`; rejects non-JSON with
`session event "${type}" carries non-JSON-serializable data`, `:1524`), mints
`seq: SessionSeq(this.log.length)` + `time: Date.now()` (`:1530-1531`), freezes,
validates (`:1535`), commits, and **returns the event** (`:1537`).

Five types require a `surfaceOp` (`dsh-session/lib/index.js:157-163`):
`SURFACE_EVENT_TYPES = {'system/message','developer/message','user/message','assistant/message','tool/result'}`;
`isSurfaceEvent` `:177`, `isAppendSurfaceEvent` `:192`, `isReplacementSurfaceEvent` `:202`.
**`tool/call` is not a surface event** — raw log structure; only `tool/result` enters
the replayable transcript.

## 2. Tool calls and results
Two types only: **`tool/call`** and **`tool/result`**. No `tool/start`, `tool-call`,
or `tool/status` exists anywhere in the catalog.

### 2.1 `tool/call` — appended before dispatch
`dsh-agent-loop/lib/index.js:681` `function appendToolCall(session, turn, step, block)`:

```js
return session.append("tool/call", {
  turn, step, callId: block.id, name: block.name, arguments: block.arguments
}).seq;                                              // :682-688
```

| field | type | meaning |
|---|---|---|
| `data.turn` / `data.step` | number | owning turn and step |
| `data.callId` | `ToolCallId` | model-side tool-call id |
| `data.name` | string | `read`, `write`, `edit`, `read_image`, `str_replace_editor`, `pwsh`, `bash`, … |
| `data.arguments` | **string** | raw JSON argument text as the model emitted it (`:687`) — never parsed |

Names are registered literally: `dsh-tool-fs/lib/index.js:251` `name: "read"`, `:549`
`name: "write"`, `:690` `name: "edit"`, `:986` `name: "read_image"`;
`dsh-tool-str-replace-editor/lib/index.js:267` `name: "str_replace_editor"`;
`dsh-tool-pwsh/lib/index.js:466` `name: "pwsh"`; `dsh-tool-bash/lib/index.js:493`
`name: "bash"`.

**File paths live inside that `arguments` string.** `write` uses `file_path`
(`dsh-tool-fs/lib/index.js:659` rejects a blank one); `edit` uses `file_path` +
`old_string` + `new_string` + `replace_all` (`:662-667`); `str_replace_editor` uses
`path`. A plugin must `JSON.parse(event.data.arguments)`; the log never stores the
object.

### 2.2 `tool/result` — appended after settle, linked to its call
`dsh-agent-loop/lib/index.js:691`
`function appendToolResult(session, turn, step, block, result, callSeq)` builds the
message via `createToolResultMessage({ callId: block.id, content: result.content,
isError: result.isError })` (`:692-696`) and appends:

```js
session.append("tool/result",
  { turn, step, message,
    ...result.error?.info ? { error: result.error.info } : {},
    ...result.meta !== void 0 ? { meta: result.meta } : {} },
  { surfaceOp: "append", sourceEventSeqs: [callSeq] });   // :697-706
```

`sourceEventSeqs: [callSeq]` is the canonical persisted call→result pairing;
`dsh-session/lib/types/seq-ranges.js:11` `encodeSeqRanges(values)` / `:34`
`decodeSeqRanges(value, maxEntries)` keep long lists compact in JSONL.

| field | type | meaning |
|---|---|---|
| `data.message.toolCallId` | `ToolCallId` | which call this answers |
| `data.message.source.callId` | `ToolCallId` | same id, read by recovery at `dsh-session/lib/index.js:839` |
| `data.message.content` | `ContentBlock[]` | model-facing output |
| `data.message.isError` | `boolean?` | failure flag |
| `data.error` | `{name, code, reason?}` | only on failure (`:701`) |
| `data.meta` | `JsonValue?` | **opaque per-tool metadata — paths and diffs live here** |

`ToolResultMessage` (`dsh-api-session-controller/lib/typert.host.js:3167`):
`export interface ToolResultMessage extends MessageBase { readonly role: 'tool';
readonly source: ToolMessageSource; readonly toolCallId: ToolCallId;
readonly isError?: boolean; }`

`meta` is the tool's `presentationMeta` projection, snapshotted by the tool layer
(`dsh-tools/lib/index.js:3649-3657`: `projected = tool.output.presentationMeta(exec.arguments, value)`
→ `meta = snapshotProjection(tool.name, "presentationMeta", projected)`; attached at
`:3664`, `:3675`, `:3690`). Per shipped tool:

- `write` — `dsh-tool-fs/lib/index.js:593` `presentationMeta: (_args, value) => ({ path: value.path, before, after, diffs: … })`; hunks from `computeHunkDiffs` (`:596`, helper `:404`).
- `edit` — `dsh-tool-fs/lib/index.js:738`, same shape (`:740`).
- `read` — `dsh-tool-fs/lib/index.js:320` → `{path, offset, lines, totalLines, lang?}` (consumer `:358-371`).
- `read_image` — `dsh-tool-fs/lib/index.js:1007` `({ path: value.path })`.
- `pwsh` — `dsh-tool-pwsh/lib/index.js:626` `presentationMeta: (_args, value) => ({ cwd: value.cwd })` — **cwd only, no file list**.
- `str_replace_editor` — no `presentationMeta` in `dsh-tool-str-replace-editor/lib/index.js` → no `meta`; only `arguments.path`.

Replay reads it back defensively: `dsh-tool-fs/lib/index.js:440`
`function diffsFromMeta(meta)` and `:451` `function pathFromMeta(meta)` ("Read the
operation's file path even when the applied diff is empty").

### 2.3 Adjacent tool-ish events
`approval/asked` `{id, toolName, callId?, reason?}`; `tool/ptc-dispatch-start` /
`tool/ptc-dispatch` for `run_code` sub-calls (`dsh-tools/lib/index.js:1424`, `:1400`,
data `{rootCallId, parentCallId, subCallId, name, arguments, isError, error?, content, meta?}`)
— a watcher of `tool/call` alone misses these; `tool-workflow/*` run boundaries;
`command/run` / `command/done` for slash commands (not shell).

## 3. How a plugin subscribes
1. **`session/event`** — per appended event. Cordis catalog signature
   (`dsh-tool-cordis/lib/types/api-catalog.js:4380-4382`):
   `'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void`.
   Emitted at `dsh-session/lib/index.js:1587` with per-listener containment
   (`invokeContainedSessionObservers(entry.emitCtx, "session/event", entry.id, callbackArgs, callbacks)`, `:1592`).
   Seed events never publish (`:1349`).
2. **`session/created`** / **`session/disposed`** — lifecycle (`:1925`; a registry
   subscribes at `dsh-session-projection/lib/index.js:53`).
3. **`session/flush`** — durability barrier: `dsh-session/lib/index.js:1950`
   `async flush(session)` collects listeners with
   `collectSessionCallbacks(this.ctx, [carrier, "session/flush", session])` (`:1953-1957`),
   awaits `Promise.allSettled` (`:1958`), returns `callbacks.length > 0` (`:1966`) —
   "whether at least one durability listener participated" (`:1946`).

Subscribers found by searching `harness-src` for `'session/event'`:
`dsh-session-projection/lib/index.js:64`, `dsh-workspace-changes/lib/index.js:1055`,
`dsh-session-persistence-jsonl/lib/index.js:421`, `dsh-session-telemetry/lib/index.js:75`,
`dsh-acp/lib/index.js:1142`, `dsh-agent-loop/lib/index.js:319` and `:976`,
`dsh-api-session-controller/lib/types/history.js:158`,
`dsh-session-title/lib/index.js:251`, `dsh-token-meter/lib/index.js:697`,
`dsh-subagent/lib/index.js:1089`.

The shipped **tool-activity subscriber**, verbatim
(`dsh-workspace-changes/lib/index.js:1055-1063`):

```js
ctx.on("session/event", (session, event) => {
  if (event.type === "turn/start") {
    const cwd = eligible(session);
    if (cwd !== void 0) recorderFor(session, cwd).start(event.data.turn);
    return;
  }
  if (event.type === "tool/result") recorders.get(session)?.observe(event);
  else if (event.type === "turn/end") recorders.get(session)?.end(event.data.turn);
});
```

Same plugin: `:1067` `ctx.on("agent/turn-stopping", async ({ agent, turn }) => { await recorders.get(agent.session)?.stopping(turn); })`
and `:1086` `ctx.on("tools/pre-execute", async (exec, next) => {…})` (§7.3).
Services: `sessions` (`dsh-session/lib/index.js:1739` `super(ctx, "sessions")`),
`sessionPersistence` (`dsh-session-persistence/lib/index.js:265`),
`sessionProjections` (`dsh-session-projection/lib/index.js:52`).

### 3.1 Session / SessionStore (`dsh-session/lib/index.js`)
`class Session` `:406`; `constructor(id, seed, header, mode="snapshot",
suppliedInheritedEventCount, projections=[])` `:1399`; `eventAt(seq)` `:1439`;
`snapshotEvents(fromSeq = SessionLogOffset(0), toSeqExclusive = this.seq)` `:1452`;
`ownEvents()` `:1465`; `isOwnSeq(seq)` `:1473`; `append` `:1517`; `requestHeader()` `:1612`;
`requestContext()` `:1627`; `toolHistory()` `:1643`; `deriveMessages()` `:1672`;
`deriveEventMessage(event)` `:1694`; `registerMessageProjection` `:1729`.
`class SessionStore` `:861`; `create(id, options)` `:1772` (`seed` / `meta` /
`inheritedEventCount`; mints `session-<n>`); header at `:1799` `{version: 4, id,
createdAt, cwd?, parentSession?, isSeeded, origin?, delegationDepth?, agentPreset?}`;
`enter` `:1853`; `announce` `:1901`; `emitDisposed` `:1925`; `flush` `:1950`;
`liveEntryFor` `:1970`; `get(id)` `:1980` (**live only**); `list()` `:1987`
(**live only**); `fork` `:2006`.
Plugin records: `:381` `appendPluginRecord(session, type, data)` and `:392`
`pluginRecordOf(event)` — a type outside the catalog must be appended with
`ignorable: true` or the read path refuses it
(`dsh-session-persistence/lib/index.js:182` `validateStoredEvents`).

## 4. Reading a log, and how logs are stored
### 4.1 Persistence seam
`dsh-session-persistence/lib/index.js:261` `var SessionPersistence = class extends Service`
(`:265` `super(ctx, "sessionPersistence")`), abstract; backends supply handles.
Contract `:242-260`: events contiguous from seq 0, never rewritten, torn tail
truncated before the first append, `append` best-effort, `flush` is the durability
barrier. Helpers exported at `:269` (`assertContiguous` `:229`, `assertStoredId` `:157`,
`assertVersion` `:165`, `materializeAppendBatch` `:218`, `materializeCreateHeader` `:204`,
`sessionFormatVersionRefusal` `:137`, `validateStoredEvents` `:182`); error classes at
`:24`–`:114`, from `SessionPersistenceNotFoundError` through
`SessionFormatUnsupportedError` (`SessionReadOnlyError` `:54`,
`SessionPersistenceCorruptionError` `:97` are the ones a reader must catch).

### 4.2 The canonical read recipe
`dsh-session-query/lib/index.js:34`
`async function readColdSessionLog(persistence, sessionId, signal)` — "Read one
complete stored session log without taking ownership or mutating storage" (`:24-25`):
`persistence.open(sessionId, "read", options)` (`:36`), `handle.read(0, void 0, options)`
(`:39`), `handle.close()` (`:46`), returning `{eventState, header: handle.header,
inheritedEventCount: handle.inheritedEventCount, events: [...events,
...interruptedTurnClosers(events)]}` (`:48-53`).
Engine: `dsh-session-query/lib/index.js:1042` `var SessionQueryEngine = class extends Service`
with `listSessions(signal)` `:1072`, `readSession(sessionId)` `:1081`,
`listEvents(sessionId)` `:1143`, `readSurface(sessionId)` `:1168`,
`traceSession(sessionId, signal)` `:1184`, `readEvent(request, signal)` `:1210`;
live-preferred corpus at `:70` (`listSessions` `:95`, "newest-first order"). SQLite
variant: `dsh-session-query-sqlite/lib/index.js:476`
`var SqliteSessionQueryEngine = class extends SessionQueryEngine`. Model-facing tools
`session_search` `:956`, `session_trace` `:974`, `session_event_read` `:999` in
`dsh-tool-session-query/lib/index.js`.

### 4.3 Disk layout
Observed here:
`C:\Users\LEGION\.dsh\sessions\--C-Users-LEGION-.dsh-whale-work--\bili-whale\session.v4.jsonl.zstd`
(621 525 bytes), matching `dsh-session-persistence-jsonl/lib/index.js`:

```js
if (cwd === void 0) return join(root, "_no-cwd");           // :908
return join(root, projectKey(cwd));                          // :909
return join(projectDir(root, cwd), encodeSegment(id));       // :920
return join(sessionDir(root, cwd, id), generationLogFilename(version, compression)); // :932
```

i.e. `~/.dsh/sessions/<projectKey(cwd)>/<encodedSessionId>/session.v<N>.jsonl[.zstd]`.
Encoding `:750` (`.jsonl.zstd` for Zstandard, `.jsonl` for plaintext), `:756`
`return compression === "zstd" ? ".zstd" : "";`. **No `storage.json`, no per-event
frame**: one zstd stream (possibly multi-frame) wraps one JSON object per line for the
whole session — `:952` `return events.map(eventLine).join("\n");` (doc `:949`: "the
writer adds the final newline"), torn tails tolerated (`:1003`, `:1123`), frames
decoded by `NodePrivateZstdFrameDecoder` (`:1162`) which throws
`` `corrupt Zstandard session log: frame at byte ${frame.start} failed validation` ``
(`:1198`); one writer per session via a lease file (`:672` `join(dir, LEASE_FILENAME)`).
Backend surface: `create` `:2465`, `open(id, access, options)` `:2488`, `stat` `:2570`,
`list(options)` `:2603`; handle `read(offset = 0, length = Number.MAX_SAFE_INTEGER, options)` `:63`.
Filename grammar and migrations: `dsh-session-format/lib/index.js:464`
`` const CANONICAL_LOG_FILENAME = /^session(?:\.v([1-9][0-9]*))?\.jsonl$/u; ``,
`:472` `sessionFormatLogFilename(version)`, `:483` `parseSessionFormatLogFilename(filename)`,
`:93` `defineSessionFormatMigration(migration)`, `:104` `createSessionFormatChain(options)`,
`:284` `createSessionFormatCatalog(options)`; exports at `:491`. Generations upgrade
through `dsh-session-format-v0-to-v1` … `dsh-session-format-v3-to-v4`; current
version `4` (`dsh-session/lib/types/types.js:54`).

## 5. Projections
`dsh-session-projection/lib/index.js:44`
`var SessionProjectionRegistry = class extends Service`, mounted as
`sessionProjections` (`:52`). Seeds on `ctx.on("session/created", …)` (`:53`,
`def.init(session.header, session.inheritedEventCount)`), folds via
`ctx.on("session/event", (session, event) => this.drive(session, event))` (`:64-66`).

| member | line | note |
|---|---|---|
| `register(definition)` | `:68` | effect-scoped, returns a disposer |
| `onChanged(listener)` | `:109` | `listener(session, key, value, event.seq)` |
| `stateOf(session, key)` | `:126` | current state, `undefined` when unregistered |
| `snapshot(session, keys)` | `:141` | `{ asOfSeq: cursorBefore(session.seq), values }` |
| `cachedSnapshot(session, keys)` | `:164` | reuse while the cursor is unchanged |
| `checkpoint(session)` | `:195` | `{ [key]: { ver, seq, val } }` |
| `restore(checkpoint, events, baseSeq, header, inheritedEventCount)` | `:286` | → `{ snapshot, checkpoint }` |
| `hydrate(session, checkpoint, events, baseSeq)` | `:329` | no replay from 0 |
| `drive` | `:401` | eager; notifies only when `!Object.is(views[0], views[1])` |

**No `getProjection` method exists — NOT FOUND.** Read via `stateOf` / `snapshot`.
Definition contract (erased in JS at `:70-80`): `{ key, stateSchema,
init(header, inheritedEventCount), apply(state, event), wire?: { viewSchema,
view(state) }, stateVersion }`. Two author-visible rules: the *whole-value rule*
(`:16-19` — a state-carrying event carries complete post-change state, never a
delta) and duplicate-key rejection (`:91`, same `key` at a different `stateVersion`).
A late registration folds `init` over the in-memory log on first touch (`:33`).
Durability: `dsh-session-projection-cache/lib/index.js:293` subscribes to
`session/event` and persists `(sessionId, key, ver, seq, val)` rows.

## 6. Fork
`dsh-session/lib/types/fork.js:18` `export function buildForkSeed(events, boundary)`:

```js
const prefix = events.slice(0, boundary + 1);                        // :19 inclusive
{ type: 'session/end-seed', seq: SessionSeq(boundary + 1),
  time: events[boundary].time, data: { inherited: true } }           // :20-25
return prefix.concat(openTurnClosers(prefix, { kind: 'forked' }));   // :26
```

`openTurnClosers` is from `dsh-session/lib/types/repair.js:5`; the tool branch is
`repair.js:111` `case 'tool/call': {` — an open call at the boundary gets a synthetic
`forked` result so the child transcript is balanced. Store-level:
`dsh-session/lib/index.js:2006` `fork(source, boundary, childSessionId)` creates the
child with `{ seed, inheritedEventCount: SessionLogOffset(boundary + 1), meta: { cwd:
liveSource.header.cwd, parentSession: liveSource.id, isSeeded: true } }` (`:2012-2020`);
`_forkBoundary` (`:2022`) throws `SessionForkError` codes `INVALID_BOUNDARY`,
`SESSION_NOT_FOUND`, `SESSION_NOT_LIVE`, `SESSION_ALREADY_EXISTS`.

## 7. Reconstructing "files written/edited during a turn" — and where it breaks
### 7.1 Sufficient from the log alone
1. `turn/start` `{turn}` … `turn/end` `{turn, reason}` delimit the window.
2. `tool/call` gives `data.turn`, `data.step`, `data.name`, raw `data.arguments`
   (`file_path` / `path`).
3. `tool/result` gives `data.message.isError`, `data.error`, and — for
   `write`/`edit`/`read`/`read_image` — `data.meta` with the absolute `path` and, for
   mutations, `before`/`after` plus `diffs` (`dsh-tool-fs/lib/index.js:593`, `:738`).
4. `sourceEventSeqs: [callSeq]` pairs call↔result (`dsh-agent-loop/lib/index.js:705`).

That answers "which files changed this turn, and what changed" for `write`/`edit`
**without re-interception**.

### 7.2 Missing
- **Shell-created files.** `pwsh` publishes `meta: {cwd}` only
  (`dsh-tool-pwsh/lib/index.js:626`); `bash` (`dsh-tool-bash/lib/index.js:493`) has no
  file metadata. `git commit`, `npm install`, generators, `Remove-Item` in a shell
  never put a path in the log.
- **`str_replace_editor`.** No `presentationMeta` (`dsh-tool-str-replace-editor/lib/index.js`)
  → no `meta.path`, no before/after text; only `arguments.path`.
- **Aborted / never-dispatched calls.** `appendSkippedToolCall`
  (`dsh-agent-loop/lib/index.js:663`) writes `tool/call` + a synthetic error
  `tool/result`, so the pair exists but says nothing about the filesystem; a crash
  between call and result leaves an unmatched call, reconciled by `ToolCallRecovery`
  (`dsh-session/lib/index.js:833-843`), not by the log.
- **Non-tool mutation.** Plugin code, hooks, PTC sub-calls, and anything writing
  outside a tool produce other event types or nothing.
- **`workspace/changes` carries no file list.** `dsh-workspace-changes/lib/types/recorder.js:282`
  `const event = this.session.append('workspace/changes', { turn: state.turn });`
  then `:284-295` `this.records.set(event.seq, { summary: { turn, cwd, files, total,
  added, deleted, snapshot? }, sources })`, served by `summary(seq)` `:128` and
  `diff(seq, index, signal)` `:139`, dropped by `dispose()` `:167`. Reading the log
  after the session is gone **cannot** recover `files[]`.

### 7.3 Why the shipped implementation intercepts instead
Pre-images must be captured *before* a mutation, and shells are opaque
(`dsh-workspace-changes/lib/index.js`):

```js
ctx.on("fs/write-intent", async (target, actor, next) => {   // :1076
  const intent = await next(); await capture(target, actor); return intent;
}, { prepend: true });
ctx.on("fs/edit-intent", …);                                  // :1081
ctx.on("tools/pre-execute", async (exec, next) => { … });     // :1086
```

Those intents are raised by the fs tools themselves
(`dsh-tool-fs/lib/index.js:607` `ctx.waterfall("fs/write-intent", target, exec, () => void 0)`,
`:753` for `fs/edit-intent`; `dsh-tool-str-replace-editor/lib/index.js:145`, `:162`,
`:195`). The recorder pairs them with a per-turn git baseline
(`recorder.js:50` `start(turn)`, `:75` `capture(path)`, `:227` `record(state, signal)`,
`:241` `diffTrees(…)`).
**Practical rule:** derive turn-scoped changes from `tool/call` + `tool/result.meta`
for `write`/`edit`; treat `str_replace_editor` as argument-only; mark shell-driven
changes as not observable from the log. For exact fidelity register
`fs/write-intent` / `fs/edit-intent` / `tools/pre-execute` as `dsh-workspace-changes`
does — live-only, not replayable from history.

## 8. Quick reference
| need | call |
|---|---|
| watch everything | `ctx.on('session/event', (session, event) => …)` |
| durability barrier | `ctx.on('session/flush', async (session) => …)` |
| live sessions | `ctx.sessions.list()` / `get(id)` (`dsh-session/lib/index.js:1987`, `:1980`) |
| stored sessions | `ctx.sessionPersistence.list()` (`dsh-session-persistence-jsonl/lib/index.js:2603`) or `readColdSessionLog(ctx.sessionPersistence, id, signal)` (`dsh-session-query/lib/index.js:34`) |
| rich history | `ctx.sessionQuery.listSessions()` / `readSession(id)` / `traceSession(id)` (`dsh-session-query/lib/index.js:1072`, `:1081`, `:1184`) |
| derived view | `ctx.sessionProjections.register({ key, stateSchema, init, apply, stateVersion })` (`dsh-session-projection/lib/index.js:68`) |
| read derived view | `stateOf(session, key)` `:126` / `snapshot(session, keys)` `:141` — *not* `getProjection` (NOT FOUND) |
| fork | `ctx.sessions.fork(source, boundary, childId)` (`dsh-session/lib/index.js:2006`) |
| custom record | `appendPluginRecord(session, type, data)` (`dsh-session/lib/index.js:381`) |

Open question: whether `tool/result.data.meta` is size-capped before it reaches the
JSONL (large `write` hunks are inlined); `snapshotJsonValue` at
`dsh-session/lib/index.js:1523` checks JSON-ness only, not size.
