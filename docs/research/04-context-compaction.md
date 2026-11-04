# 04 · Context accounting and the compaction pipeline

Read-only research. Runtime: DSH **0.2.1-rc.5** at `C:\Users\LEGION\.dsh\harness-src\@deepseek-ai\`;
prior art: **billion-context 0.1.212** at `C:\Users\LEGION\.dsh\profiles\desktop\node_modules\billion-context\`.
Citations are `<package>/<file>:<line>` relative to those trees (third-party bundles are minified but have
physical lines: `dsh-native.js` 169, `dist/index.js` 7661). Question: how can a `harness-context-os` plugin
**measure** context, **cooperate** with DSH compaction instead of competing, and **retrieve** compressed content?

## 0. Summary

| Layer | Thing | Entry point | Verdict |
|---|---|---|---|
| Measurement | provider-anchored meter + 3 projections | service `tokenMeter`, `measure(session, header?)` | use it, never re-count |
| Compaction seam | abstract `compaction`, concrete `compaction-basic` | `compactIfNeeded` / `compactNow` / `compactRegion` | observe, don't replace |
| Pre-request hook | `agent/pre-step` waterfall | `{messages,turn,step,signal}` → `{kind:"enter"\|"reject"}` | safe read/append |
| Wire hook | `llm/stream` waterfall | `(options, next) => AsyncIterable` | how bili rewrites context |
| Prompt | `systemPrompt.section()/context()` | `ctx.systemPrompt` | safe additive |
| Tools | `ctx.tools.register(defineTool(...))` | service `tools` | safe additive |
| Retrieval | SQLite **FTS5** over session history | service `sessionQuery` | yes, but off by default |
| Compressed originals | shadowed events stay in the session log | `compaction/summary.shadowedSeqs` | our L2/L3 substrate |

Load-bearing fact: **DSH compaction never deletes history** — it shadows surface nodes and appends a
`compaction/summary` event (`dsh-compaction-basic/lib/index.js:634`). Retrieval therefore does not need
billion-context's out-of-band ledger; it needs `sessionQuery` over the same log.

## 1. How token usage is measured and exposed

`dsh-token-meter/lib/index.js:687-692`:

```js
var TokenMeter = class extends Service {
  static Config = z.object({});
  static inject = ["sessionProjections"];
  constructor(ctx, ...) { super(ctx, "tokenMeter"); ... }
```

- Service name **`tokenMeter`**. Config rejects every key:
  `TokenMeterConfig: unknown key "<key>" (no settings are supported)` (`:684`).

API (`dsh-token-meter/lib/index.js:722-765`, result `deepFreeze(structuredClone(...))`):

```
measure(session, requestHeader?) -> { logRevision,
  baseline: { kind: "usage"|"estimated"|"none", tokens, usage? }, surfaceDeltaTokens,
  totalTokens: Math.max(0, baseline.tokens + surfaceDeltaTokens), surfaceTokens, nodes }
```

The optional 2nd arg substitutes a not-yet-logged request envelope — that is how a plugin prices a
*hypothetical* next request. `totalTokens` is request+response pressure; `surfaceTokens` = sum of
`nodes[].tokens`; the snapshot is detached and immutable (`dsh-token-meter/README.md:36`).

| Piece | Priced by | Line |
|---|---|---|
| system prompt | `Math.ceil(chars/4)+4` per system-role message | `:65` |
| messages / tool results | content estimator `+4` | `:75` |
| tool schemas | `JSON.stringify(header.tools).length/4 + 4` | `:85` |
| provider numbers | `input + cacheRead + cacheWrite + output` | `:675` |

`CHARS_PER_TOKEN = 4` (`:16`), `BLOCK_OVERHEAD = 4` (`:18`). Tool results are ordinary message content to
the meter — only the pruner makes them cheaper. Provider usage is an *anchor*, not the source of truth:
reused only when `optionalHeaderEquals(anchor.header, header) && usageTokens(usage) >=
estimatedAnchorTokens` (`:731-743`), else `baseline.kind === "estimated"`. Folds `image/offload`,
`request/header`, `step/start`, `step/end`, `assistant/message` (`:811-866`).

Projections registered at `:694-696`:

| Key | ver | Carries | Line |
|---|---|---|---|
| `tokenUsage` | 2 | `uncachedInputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens` | `:393-395` |
| `contextPressure` | 5 | `pressureTokens` (newest provider prompt size), `projectedTokens`, `contextWindow` | `:448-450` |
| `contextBreakdown` | 6 | heuristic `systemTokens`/`toolsTokens`/`messageTokens` | `:199-201` |

Read via the projection registry, not by recomputation:
`ctx.sessionProjections.stateOf(session, "contextPressure")` (`dsh-session-projection/lib/index.js:126`),
`snapshot(session, [...])` (`:141`). Keys are globally unique; a `stateVersion` mismatch throws (`:91`).
Accuracy: CJK and JSON schemas are badly underpriced at 4 chars/token, and these are **not billing
records** (`dsh-token-meter/README.md:68-69`).

## 2. The compaction pipeline

### 2.1 Seam

`var CompactionEngine = class extends Service { constructor(ctx) { super(ctx, "compaction"); } };` —
abstract, no runtime methods on the base (`dsh-compaction/lib/index.js:169-172`). Operations exist on the
concrete engine and in types: `compactIfNeeded(agent, "pressure"|"context-overflow", signal)`,
`compactNow(agent, signal, sourceCommandId)`, `compactRegion(start, end, agent, signal)`
(`dsh-compaction-basic/README.md:78`). Manual failures are `ManualCompactionError(code, …)` with
`"busy"`/`"cancelled"` (`dsh-compaction/lib/index.js:146-159`). The lock is the durable pair
`compaction/start` … `compaction/end`, shared by every entry point (`dsh-compaction-basic/README.md:47`).
`/compact` = `dsh-command-compact` (`inject = ["commands","compaction"]`,
`ctx.compaction.compactNow(agent, signal, commandId)`; `dsh-command-compact/lib/index.js:9`, `:55`, `:93-95`).

### 2.2 Engine and config

`static inject = ["llm","tokenMeter","sessions"]` (`dsh-compaction-basic/lib/index.js:800-805`); config
keys (`:806-818`, unknown keys rejected `:60`): `thresholdRatio, headroomTokens, retainRatio,
retainTokens, summarizationProvider, summarizationModel, maxTokens, compactionRetries,
maxOverflowRetries, auto`, plus `modelPolicies: [{ provider, model, <same policy keys> }]` (policy shape
`:779-791`).

Defaults: threshold `0.8` (`:15`), retain `0.16` (`:17`), headroom `65536` (`:63`),
`maxTokens ?? headroomTokens` (`:64`), retries `1` (`:82`), overflow retries `1` (`:83`), `auto ?? true`
(`:85`). Budget math `resolveCompactSpec` (`:124-147`):

```js
messageBudgetTokens  = contextWindow - reservedCompletionTokens
pressureBudgetTokens = messageBudgetTokens - headroomTokens
thresholdTokens      = floor(min(contextWindow * thresholdRatio, pressureBudgetTokens))
retainTokens         = floor(messageBudgetTokens * retainRatio)
reservedCompletionTokens = requestHeader()?.config.maxTokens ?? defaultMaxTokens ?? 0   // :757
```

`TargetPressureConfigError` when `retainTokens >= thresholdTokens` or the pressure budget is
non-positive — a window smaller than `headroomTokens` can never auto-compact.

### 2.3 Automatic triggers

`_registerAutomaticCompaction()` (`:834-888`) registers four listeners; the first is the real trigger:

```js
ctx.on("agent/pre-step", async ({ agent, signal }, next) => {      // :839-852
  if (!signal.aborted) try { await this.compactIfNeeded(agent, "pressure", signal) } catch {}
  return next() })
ctx.on("agent/status", ({agent,status}) => status === "idle" && this.overflowRetries.delete(agent))  // :853
ctx.on("session/event", (session, event) => { if (event.type !== "assistant/message") return; ... })  // :856
ctx.on("agent/request-error", async ({agent,failure,signal}, next) => { if (failure.code !==
  CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next(); ... return { kind: "retry" } })      // :861-887
```

`compactIfNeeded` (`:914`): `tokenMeter.measure(session)` → below `spec.thresholdTokens` return `null` →
**prune** → re-measure → select range → `compactRegion` (owner `"current-turn"`, stability
`"whole-surface"`, `:971`).

### 2.4 Ordering: basic → pruner → summarise; image-offload is out of band

1. `compaction-basic` confirms pressure/overflow.
2. `const prune = this.ctx.get("toolResultPruner"); prune.pruneSession(session)` then re-measure
   (`dsh-compaction-basic/lib/index.js:926`, `:942-946`). Pruner: service **`toolResultPruner`**
   (`dsh-compaction-tool-result-pruner/lib/index.js:71`, injects `tokenMeter` `:62`), config
   `thresholdChars 8192 / headChars 4096 / tailChars 1024` (`:11`, `:63-64`), `pruneSession(session)`
   `:137`, appends `compaction/prune` before replacement `:159`. It runs only "when a compaction trigger
   qualifies … before it selects what to condense" (`dsh-compaction-tool-result-pruner/README.md:60`);
   originals stay in the log (`:44`).
3. Range selection + `ctx.llm.stream()` summarisation.
4. `compaction/summary` + checkpoint user message; `compaction/end` closes the lock.
5. **Image offload is reactive**, not in the chain: on `agent/request-error` with
   `IMAGE_OFFLOAD_REQUIRED_CODE` (`dsh-compaction-image-offload/lib/index.js:141`) and on
   `compaction/summary-error` (`:146`), appending `image/offload {targets}` (`:42`).

### 2.5 Durable events a plugin can observe

| Event | Payload highlights | Line |
|---|---|---|
| `compaction/start` | `{compactionId, sourceCommandId?, turn}` | `dsh-compaction-basic/lib/index.js:469` |
| `compaction/summary` | `{compactionId, summary, shadowedRange:{start,end}, shadowedSeqs, shadowedTokenCount, provider, model, maxTokens, usage, checkpointMessage}` | `:634` |
| `compaction/end` | lifecycle, or lifecycle + `error` | `:484`, `:495` |
| `compaction/prune` | replacement record | `dsh-compaction-tool-result-pruner/lib/index.js:159` |
| `image/offload` | `{targets:[{seq, imageIndexes}]}` | `dsh-compaction-image-offload/lib/index.js:42` |

Observe with `ctx.on("session/event", (session, event) => …)` — what `compaction-basic` itself uses at
`:856`. **This is the cheapest cooperation point**: we learn which seqs were shadowed without owning
anything. The only *contribution* waterfall is recovery (`:1013-1024`):
`recover: (error, agent, sourceEventSeqs, signal) => this.ctx.waterfall("compaction/summary-error",
{ session: agent.session, sourceEventSeqs, error, ...signal }, () => false)`.

### 2.6 Which row is live (matters for patching)

- Host plane: `- id: compaction-basic` with no config (`dsh-base/cordis.patch.yml:351-352`),
  `command-compact` (`:356-357`).
- Web profile **disables** those host rows (`dsh-web-app/cordis.patch.yml:544-551`).
- The live instance is per preset, inside a nested group with
  `isolate: {compaction: true, toolResultPruner: true}` (`dsh-web-app/presets/cordis.patch.yml:65-81`).

A patch layer cannot address those rows by id — the same finding billion-context records at
`dsh.bundle.patch.yml:6`.

## 3. How `billion-context` integrates

### 3.1 Patch rows (file is `dsh.bundle.patch.yml`, **not** `cordis.patch.yml`)

```yaml
- insert: [ {id: bili-native, name: billion-context},
            {id: bili-compaction-gate, name: billion-context/dsh-compaction-gate} ]   # :21-25
- id: compaction-basic
  config: { auto: false }                                                             # :26-28 host row
- id: preset-standard
  inject: [biliBasicCompactionPolicy]                                                 # :32-39 (+ptc/minimal/cordis)
- id: llm-deepseek
  config: { retryPolicy: { retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, MALFORMED_RESPONSE] } }  # :46-55
```

Load-bearing comments: `:6` — host `compaction-basic` is disabled in Web profiles and the live rows are
nested preset rows "no patch layer can address by id", so preset gate rows make each preset wait for the
load-time overlay. `:14` — the gate is its own always-on entry so that disabling `bili-native` leaves the
gate alive and presets fall back to stock compaction "instead of pending forever". `:29` — patch entry
`inject` lists are **replaced**, not concatenated.

### 3.2 The gate (whole plugin, 2.5 KB) — `dist/agent/dsh-compaction-gate.js:3`

```js
function disableBasicCompaction(rows) {
  return rows.map(row => {
    if (row.name === "@deepseek-ai/dsh-compaction-basic"
     || row.name === "@deepseek-ai/dsh-command-compact") return { ...row, disabled: true };
    if (row.group && Array.isArray(row.config)) return { ...row, config: disableBasicCompaction(row.config) };
    return row;
  });
}
function registerCompactionDisable(ctx) {
  ctx.on("internal/config", function (_raw, next) {
    const resolved = next();
    if (!isDshCompactionActive()) return resolved;              // globalThis.__BILI_DSH_COMPACTION_VERDICT__
    if (countCompactionRows(config.plugins) === 0) return resolved;
    noteGateCoverage(entryName.slice(0,120), compactionRows, entryName === "@deepseek-ai/dsh-agent-preset");
    return { ...config, plugins: disableBasicCompaction(config.plugins) };
  }, { global: true });
  ctx.reflect?.provide?.("biliBasicCompactionPolicy",
    Object.freeze({ owner: "billion-context", issue: "#3354" }));
}
var name = "bili-compaction-gate"; var inject = []; function apply(ctx) { registerCompactionDisable(ctx); }
```

- Hooks cordis' **internal** `internal/config` resolution hook with `{global:true}` and rewrites resolved
  rows structurally (recursing into groups) — no ids needed.
- Acts only when `globalThis.__BILI_DSH_COMPACTION_VERDICT__ === "active"`, declared by the main plugin:
  `function declareDshCompactionActive() { globalThis[DSH_COMPACTION_VERDICT_KEY] = "active" }`
  (`dist/agent/dsh-native.js:129`, called in `apply()` at `:161`).
- Provides an empty frozen **marker service** `biliBasicCompactionPolicy` purely so preset rows that
  `inject` it wait for the gate to load (race prevention between preset mount and overlay install).
- Coverage telemetry on `globalThis.__BILI_DSH_COMPACTION_GATE_TELEMETRY__`; the main plugin reports gaps
  via `detectCompactionOverlayGap(ctx)` → `"no-config-hook" | "no-service-provide" | null` (`:129`, `:161`).

### 3.3 How a second auto-compaction loop is prevented

1. **Config layers**: `auto: false` on the host row + the gate disabling `compaction-basic` *and*
   `command-compact`, including nested preset rows, while bili is active.
2. **A global verdict flag**, so nothing is disabled when bili failed to load (patch comment `:14`).
3. **Wire-level refusal** (`#1729`) for compaction calls still routed through bili — explicitly *not*
   sufficient (`dsh-native.js:161`):
   > "bili's wire-level refusal (#1729) refuses routed compaction calls but CANNOT stop dsh writing its
   > checkpoint locally, so a landed checkpoint will destroy the compression substrate and surface later
   > as a 'compression conflict' banner."

   Recommended fallback there: the `#2474` full-snapshot override of `preset-standard` in
   `cordis.patch.yml` (a partial snippet "silently drops everything not restated").

So bili's answer is: **turn DSH compaction off and own the trunk.** That is the design we should
deliberately not copy (§7).

### 3.4 Tools, and where summaries live

bili defines no tools locally. `apply()` starts/attaches a proxy (`bin: bili`/`bili-proxy` →
`dist/index.js`), then (`dsh-native.js:155`, manifest at `:128`):
`const tools = await fetchManifest(base, "anthropic"); for (const tool of tools) { try {
target.tools.register(toolDefinition(tool)) } catch (err) { if (!errMessage(err).includes("already
registered")) throw err } }` — execution is forwarded with
`await forwardTool(base, sid, tool.name, args, exec.signal, true)`. Manifest route
`GET /__bili/plugin/manifest` (`dist/index.js:7262`). Triggering is dual-mode: besides native tool calls
the proxy parses assistant **text markers** (`dist/index.js:934`):

```js
const triggers = [
  { name: "compress",       open: ACP_TEXT_OPEN,       close: ACP_TEXT_CLOSE,       requirePayload: true  },
  { name: "acp_status",     open: ACP_STATUS_OPEN,     close: ACP_STATUS_CLOSE,     requirePayload: false },
  { name: "search_context", open: ACP_SEARCH_OPEN,     close: ACP_SEARCH_CLOSE,     requirePayload: true  },
  { name: "decompress",     open: ACP_DECOMPRESS_OPEN, close: ACP_DECOMPRESS_CLOSE, requirePayload: true  }
];
```

Storage: per-conversation JSON + a SQLite ledger —
`%USERPROFILE%\.local\share\billion-context\sessions\anthropic\<host>_<hash>.json` and `sessions\index.db`
(WAL, 17.7 MB observed 2026-11-04). Ledger rows are `{seq, msg}`; each summary block owns a set of seqs.
Restore rebuilds the outgoing view and drops covered rows, leaving an anchor (`dist/index.js:1039`):

```js
for (const { blockId, seqs: blockSeqs } of blockSeeds) {
  let maxCover = -1; for (const seq of blockSeqs) maxCover = Math.max(maxCover, seq);
  let at = d; for (let i = 0; i < d; i++) { if (rows[i].seq > maxCover) { at = i; break } }
  anchors.push({ at, msg: { id: `acp_summary_${blockId}`, role: "system", contentType: "text", text: "" } });
}
...
if (coveredSeqUnion.has(rows[i].seq)) continue;      // covered originals are omitted from the wire
```

Reserved prefix `acp_summary_` is validated so host message ids can never collide (`dist/index.js:1235`).
Compression is therefore **wire-level**: the DSH session log still holds everything, and bili's ledger is
the only thing that knows what to hide — which is exactly why a landed DSH checkpoint "destroys the
substrate".

### 3.5 Wire interception — `dist/agent/dsh-native.js:161`

`ctx.inject(["llm"], () => onEvent("llm/stream", (options, next) => { const sid = options?.sessionId;
const scope = { sid, msgIds: hostMsgIdsOf(options?.messages) }; pfCaptureIds(sid,
pfSlotIdsOf(options?.messages)); return dispatchScope.run(scope, () => wrapScopedIterable(next(), scope))
}))` — the returned chunk stream is wrapped, so bili can substitute the visible history.

Other DSH surfaces it touches: `webserver/index-inject`, `session/created`, `session/event`
(`session/title`), `webServer.register` for `/bili/origin` and `/__bili/*`, and
`ctx.inject(["sessions","sessionTitle"])` (`:155`, `:161`). It registers **no** `systemPrompt` section
(0 hits in `dsh-native.js`) — prompt text is rewritten on the wire instead.

## 4. Session query: the retrieval backend

Service `super(ctx, "sessionQuery")` (`dsh-session-query/lib/index.js:1048`); concrete backend
`dsh-session-query-sqlite`. Operations (`dsh-session-query/README.md:34-43`): `listSessions()`,
`readSession(id)`, `filterSessions(filters)`, `filterEvents(id, filters)`, `readTitleSnapshots(ids)`,
`listEvents(id)`, `readSurface(id)`, `readEvent(request)`, `traceSession(id)`, `traceEvent(request)`,
`searchSessions(request)`, `searchEvents(request)`. `readEvent` returns one full event plus a bounded
raw-log window; `readSurface` returns the complete current model surface (`README.md:39-40`). SQLite
implements `searchSessions(request, exec)` / `searchEvents(request, exec)`
(`dsh-session-query-sqlite/lib/index.js:537`, `:558`).

**FTS5 is available**: `CREATE VIRTUAL TABLE IF NOT EXISTS persisted_docs USING fts5(` (`:106`; live
shadow `temp.live_docs` `:136`), driver `await import("node:sqlite")` (`:50`) — Node's built-in SQLite,
no `better-sqlite3`. Caller text is quoted into **one literal FTS5 phrase** so `OR`/`NEAR`/`*` are data;
ranking is deterministic (highlight spans, doc length, then event time/session/seq); snippets bounded by
`snippetChars`; pages use an opaque `SessionSearchCursor` that goes stale (`SESSION_QUERY_STALE_CURSOR`)
when the corpus changes; outer predicates are budgeted at 14 (13 within one session) (`:167`;
`dsh-session-query-sqlite/README.md:59-61`).

Config (`:478-493`): `path` required, `openAt: "startup"|"first-search"|"never"`, `snippetChars` default
240. Shipped default is **off**:
`- id: session-query-sqlite / name: '@deepseek-ai/dsh-session-query-sqlite' / config: { path:
':memory:', openAt: never }` (`dsh-base/cordis.patch.yml:157-161`; comment `:149-156` says a later patch
layer may override `openAt` with a durable `path`).

Storage: session log root `dshHomePath('sessions')` (`dsh-base/cordis.patch.yml:141`) →
`C:\Users\LEGION\.dsh\sessions\<mangled-cwd>\…` (verified present). The FTS database is a **separate
derived index** that never opens the persistence store, one owning process per path
(`dsh-session-query-sqlite/README.md:87`, `:108`).

**L2/L3 verdict: yes**, with two constraints. Shadowed events stay searchable — *"All `current`,
`shadowed`, and `log-only` events are searchable by default"* (`README.md:59`), so post-compaction
originals are findable. But restore is per event (`readEvent`) / per surface (`readSurface`), not per
compaction block; the summary→source mapping must come from `compaction/summary.shadowedSeqs`
(`dsh-compaction-basic/lib/index.js:634`). No arbitrary SQL, no provider registry, no cross-session joins
(`dsh-session-query/README.md:150`).

## 5. What a plugin can safely add

**Prompt** (`dsh-system-prompt/lib/index.js`, service `systemPrompt` `:226`): `section({ name, order,
text | text(context), interpolate?, complete? })` (`:253`), `context({ name, order, text | text(context)
})` (`:279`), `variable(name, provider)` (`:310`), `suppressRuntimeContext()` (`:289`),
`tools(provider)` (`:299`), `assemble(context = {})` (`:356`). `order` is mandatory; registration is
scoped to the calling `ctx` and returns effect disposers; a scoped registration shadows a global one and
duplicates in one layer throw (`:203-205`); only one section may be `complete: true` (`:382`); every
change emits `system-prompt/change` (`:222`). `dsh-tools` injects `systemPrompt`
(`dsh-tools/lib/index.js:2761`) because tool schemas are part of the assembled prompt — so registering
tools changes what the meter prices.

**Tools**: `ctx.tools.register(defineTool({name, description, parameters, …}))`
(`dsh-tools/lib/index.js:2974`; `defineTool` `:838`; service `tools` `:2798`). In-tree example:
`dsh-tool-session-query/lib/index.js:955-999` registers `session_search`, `session_event_search`,
`session_trace`, `session_event_trace`, `session_event_read`.

**Pre-request hooks** (exact shapes):

| Hook | Kind | Payload | Return | Line |
|---|---|---|---|---|
| `agent/pre-step` | waterfall | `{messages, turn, step, signal}` | `{kind:"enter",messages}` / `{kind:"reject"}` | `dsh-agent-loop/lib/index.js:902-927` |
| `agent/request` | waterfall | `{turn, step, signal}` | `{provider, model, reasoningEffort?, maxTokens?}` | `:1191-1197` |
| `agent/request-error` | waterfall | `{turn, step, provider, failure, retryPolicy, signal}` | `{kind:"retry"}` | `:1136-1146` |
| `llm/stream` | waterfall | `(options, next)` | `AsyncIterable` of chunks | `dsh-llm/lib/index.js:2397` |
| `agent/status` | emit | `{agent, status}` | — | `dsh-agent-loop/lib/index.js:798` |
| `session/event` | emit | `(session, event)` | — | used at `dsh-compaction-basic/lib/index.js:856` |
| `compaction/summary-error` | waterfall | `{session, sourceEventSeqs, error, signal}` | recover handler | `dsh-compaction-basic/lib/index.js:1013-1024` |

`preStep` assembles the prompt first, then runs the waterfall, then appends the runtime-context block
(`dsh-agent-loop/lib/index.js:902-927`) — so a listener sees the final message list and may replace
`messages` wholesale.

**Cooperative forcing**, if ever needed: `ctx.compaction.compactIfNeeded(agent, "pressure", signal)` is
the same entry the automatic hook uses and is a no-op below threshold (`return null`). Do not call it
from `agent/pre-step` unguarded — `compaction-basic` is already registered there and the second call
would queue behind the `compaction/start`…`compaction/end` lock.

## 6. Budget information available at runtime

`async resolveModelInfo(provider, model, signal)` (`dsh-llm/lib/index.js:2111`, normalize `:2119-2141`)
returns `{ provider, id, name, context?: { contextWindow }, defaultMaxTokens?, ... }`; `contextWindow`
must be a positive integer or `LlmError(..., "INVALID_MODEL_CONTEXT")` (`:2123`); `defaultMaxTokens` →
`"INVALID_MODEL_MAX_TOKENS"` (`:2130`).

The window actually used is recorded per request as a durable event (`dsh-agent-loop/lib/index.js:1262-1271`):

```js
const requestContext = { provider: config.provider, model: config.model,
  ...(contextWindow === void 0 ? {} : { contextWindow }),
  ...(systemPromptUpdate === void 0 ? {} : { systemPromptUpdate }) };
session.append("request/context", requestContext);
```

`contextWindow` comes from `preparedCall?.context?.contextWindow`; `contextPressure.contextWindow` folds
the newest such record (`dsh-token-meter/lib/index.js:448-450`). Per-request usage rides on assistant
messages: `...live.usage === void 0 ? {} : {usage: live.usage}` (`dsh-agent-loop/lib/index.js:1156-1162`)
and becomes `tokenUsage` / `baseline.usage`.

Gap: there is **no API returning the compaction budget** (threshold/retain). NOT FOUND: a public
"remaining tokens before compaction" query.

## 7. Risks, and the guardrails

1. **Double counting.** `measure()` already adds `surfaceDeltaTokens` on provider usage
   (`dsh-token-meter/lib/index.js:722-765`); a second estimator diverges, especially on CJK/JSON
   (`README.md:68-69`). Guardrail: read `measure()`/projections only; never register a projection with an
   existing key (`dsh-session-projection/lib/index.js:91` throws on `stateVersion` mismatch).
2. **Fighting automatic compaction.** `compaction-basic` runs on `agent/pre-step` under the
   `compaction/start`…`compaction/end` lock and asserts surface stability
   (`dsh-compaction-basic/lib/index.js:470`). Guardrail: in `agent/pre-step`, append a prompt context; do
   not rewrite `messages` while a compaction lock is open.
3. **Disabling DSH compaction (bili's choice).** Works only because bili owns the whole wire
   (`auto:false` + `internal/config` overlay + proxy) and is explicitly version-sensitive: the overlay
   rides cordis' internal hook, and a landed checkpoint "will destroy the compression substrate"
   (`dsh-native.js:161`). Guardrail: keep auto-compaction on; subscribe to `compaction/summary`.
4. **Losing user requirements.** The default summariser is a structured template with a mandatory
   "Primary Request and Intent" section and explicit preservation rules — *"Preserve exact file paths,
   commands, error strings, identifiers, numeric values, function signatures"*, *"Capture user feedback
   and explicit instructions faithfully, especially corrections"*
   (`dsh-compaction-basic/lib/index.js:246-277`), framed as established background by `CHECKPOINT_PREAMBLE`
   (`:280`). Residual risk: output is model-generated and unverifiable, and only `retainRatio` (16% of
   the message budget) survives verbatim (`:17`). Guardrail: keep a deterministic index of user-authored
   turns and re-surface them through a tool, not through summarisation.
5. **Retrieval gaps.** FTS5 is off by default (`openAt: never`, `path: ':memory:'`); `searchEvents` fails
   with `SESSION_QUERY_SEARCH_DISABLED` (`dsh-session-query-sqlite/lib/index.js:594-595`). Guardrail: ship
   our own derived index or patch that row with a durable path; read full text with `readEvent` (snippets
   cap at 240 chars).
6. **Preset isolation.** `compaction`/`toolResultPruner` are isolated per preset group
   (`dsh-web-app/presets/cordis.patch.yml:65-81`); a host-plane `ctx.compaction` is a different instance
   from the agent's. Guardrail: resolve per `agent.ctx`.

## 8. Gaps / NOT FOUND

- NOT FOUND: runtime methods on the abstract `compaction` service — the base is `super(ctx,"compaction")`
  only (`dsh-compaction/lib/index.js:169-172`).
- NOT FOUND: any in-summary hook except `compaction/summary-error` and subclassing via
  `summarize(input, agent, signal)` (`dsh-compaction-basic/lib/index.js:899`, "the sole subclass
  customization hook").
- NOT FOUND: public API for the compaction threshold/retain budget.
- NOT FOUND: a model-facing compaction tool (`dsh-compaction-basic/README.md:159`).
- NOT FOUND: `cordis.patch.yml` in billion-context (it is `dsh.bundle.patch.yml`).
- NOT FOUND: SQLite FTS5 inside billion-context (`fts5`/`CREATE VIRTUAL` = 0 hits in `dist/index.js`); it
  uses a JSON ledger + `index.db` (node:sqlite/better-sqlite3); FTS5 lives in DSH's `dsh-session-query-sqlite`.

## 9. Recommended shape for `harness-context-os`

1. **Measure**: inject `tokenMeter`, call `measure(session)`, read `contextPressure`/`contextBreakdown`; persist no competing counter.
2. **Cooperate**: leave `auto: true`; index `compaction/summary` (`shadowedSeqs`, `shadowedRange`, `summary`) plus `compaction/prune` and `image/offload` from `session/event`.
3. **Retrieve**: back L2/L3 with `sessionQuery` (`searchEvents` → `readEvent`/`readSurface`), enabled by a profile patch with a durable `path` and `openAt: first-search`; map summary → sources via the `compaction/summary` record.
4. **Add**: one `systemPrompt.context()` line (visible budget), one tool group, and at most one `agent/pre-step` listener that appends prompt context and never rewrites the surface under a lock.
