# 05 · Agent tools, permissions, settings & persistence (DSH 0.2.1-rc.5)

Read-only inspection of the unpacked runtime at `C:\Users\LEGION\.dsh\harness-src\@deepseek-ai\<package>\`.
Citations are `<package>/<file>:<line>`; `NOT FOUND` means the name/API does not exist in the inspected runtime.
Runtime observed: DSH home `C:\Users\LEGION\.dsh`, profile `web`, sandbox `danger-full-access`, approvals disabled.

Packages inspected: `dsh-tools`, `dsh-tool-fs`, `dsh-tool-str-replace-editor`, `dsh-tool-fs-search`, `dsh-fs`,
`dsh-fs-local`, `dsh-fs-sandbox`, `dsh-fs-observation-policy`, `dsh-sandbox`, `dsh-sandbox-policy`,
`dsh-sandbox-local`, `dsh-sandbox-windows-acl`, `dsh-user-approval`, `dsh-permission-presets`, `dsh-settings`,
`dsh-storage`, `dsh-storage-domain`, `dsh-storage-json`, `dsh-jobs`, `dsh-jobs-local`, `dsh-workspace`,
`dsh-workspace-changes`, `dsh-working-directory`, `dsh-util-workspace-path`. There is **no** `dsh-approval*`
and **no** `dsh-permission*` package other than `dsh-permission-presets`.

---

## 1. Registering an agent tool

### 1.1 API
Registration is `defineTool(...)` + the `ctx.tools` registry (`ctx.tools.define` is NOT FOUND):

```js
export const inject = ["tools", "fs"];              // dsh-tool-str-replace-editor/lib/index.js:329
// apply(ctx) { ctx.tools.register(defineTool({ ... })) }
```

- `defineTool(options)` — `dsh-tools/lib/types/schema.js:274`. Options: `name`, `description`, `parameters`,
  `output { schema, render, presentationMeta? }`, `execute(args, exec)`, `timeoutMs`, `deferLoading`,
  `projectContent`, `finalizeContent`, `presentCall`, `presentResult`, `isConcurrencySafe`. `parameters` is a small
  schema DSL (`string|number|integer|boolean|null|array|object|json|oneOf` + `required`/`enum`/`default`) converted
  to JSON Schema at `:295`; `output.schema` at `:296`. Args are validated before `execute`; failures throw
  `ToolArgsError` code `INVALID_ARGS`, message `invalid arguments: <violations>` (`:315-320`).
- `ctx.tools.register(definition)` — `dsh-tools/lib/index.js:2974`: requires `output.render` and a supported JSON
  schema, rejects the reserved tool name `run_code`, returns a disposer. Registry errors `UNKNOWN_TOOL`, `ABORTED`,
  `ABORTED_BEFORE_DISPATCH` (same file).
- Agent-scoped filtering: `ctx.tools.restrict({ allow?, deny? })` (`:2991`) requires a scoped (`agent.ctx`) context;
  empty filter or unknown name throws; cannot name `run_code`. Real use: `dsh-subagent/lib/index.js:395`
  (`childCtx.tools.restrict(composition.toolFilter)`). Monotonic denial: `ctx.tools.guard(fn)` (`:3017`) — a sync
  guard returning a string denies with that reason.
- Model projection: `ctx.tools.schemas(scope)` (`:3119`) → `{ name, description, parameters, deferLoading? }` via
  `schemaOf` (`:3135`); `get(name, scope)` (`:3091`), `resolveExecution(name, scope, nested)` (`:3107`), `view(scope)`
  (`:3055`).
- Pipeline (`ctx.tools`): `tools/pre-execute` waterfall → `{kind:"allow"|"deny"|"ask"}` (default allow `:3321`;
  `ask` → `serviceAsk` `:3535`) → registered guards → `tools/execute` → `tools/post-execute` waterfall
  (`accept`/`block`, `:3600`) → `finalizeContent` → `tools/result`. `ask` requires an approval service and an agent;
  outcomes map `allowed-once`→allow, `rejected`→deny `the user rejected tool "<name>"`, `cancelled`→deny,
  `unavailable`→deny (`:3535`).

### 1.2 Real definition (abridged from source)
`dsh-tool-str-replace-editor/lib/index.js:266-327`:

```js
defineTool({
  name: "str_replace_editor",
  description: DEFAULT_DESCRIPTION,
  parameters: {
    command: { type: "string", required: true, enum: [/* view, create, str_replace, insert, undo_edit, ... */] },
    path: { type: "string", required: true },
    file_text: { oneOf: [{ type: "string" }, { type: "null" }] },
    // old_str / new_str / insert_line ...
  },
  output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
  async execute(args, exec) { /* returns a string; throws on failure */ },
  presentCall(args) { /* UI card */ },
});
```

Same plugin's `Config` (`:331-334`): `z.object({ maxOutputChars: z.number().default(16e3), description: z.string().default(DEFAULT_DESCRIPTION) })`.

### 1.3 Result and error surface
`execute` returns a value validated against `output.schema`, converted to model content by `output.render(args, value)`
(e.g. one text block); `finalizeContent` may rewrite the content array and `tools/post-execute` can block it.
`presentCall`/`presentResult` produce client cards; presenters are "soft-validated" (warn only) at `schema.js:300-320`.
Thrown errors are tool failures; invalid arguments are `INVALID_ARGS` (`schema.js:315-320`).

### 1.4 Are tools gated by permission mode?
**No.** Sandbox mode gates *effects* (filesystem/process), not tool visibility; no code path links
`ctx.sandboxPolicy.mode` to `tools.schemas`/`restrict`. Visibility gates are `restrict`/`guard` (agent scope), and
call gates are the `tools/pre-execute` waterfall. File-touching tools are gated only because they call `ctx.fs` /
`ctx.sandbox`, which consult the policy (sections 2–3).

---

## 2. Permission model

### 2.1 Sandbox modes
`SANDBOX_MODES` — `dsh-sandbox-policy/lib/index.js:26-30`: `read-only`, `workspace-write`, `danger-full-access`.
`setSandboxMode(session, mode)` (`:40`) appends a `sandbox/mode` session event. `SandboxPolicyService` (`:96`),
`Config` (`:97-104`) has `mode` (default `"read-only"`) and `workspaceRoot`:

```js
resolve(request = {})  // dsh-sandbox-policy/lib/index.js:141 → { mode, workspaceRoot, sessionId? }
// mode = request.mode ?? session override ?? configured default
// workspaceRoot = session.header.cwd ?? configured fallback
```

`overrideOf(session)` (`:154`) returns the session override. Writable roots in confined modes: `writableRoots(policy)`
(`dsh-sandbox/lib/index.js:166`) = `workspaceRoot` + `/tmp` + canonical `os.tmpdir()`. Effects: `read-only` permits no
writes; `workspace-write` only inside those roots; `danger-full-access` does not confine.

### 2.2 Approval policies
`APPROVAL_POLICIES` — `dsh-user-approval/lib/index.js:37`: `ask`, `never`. Outcomes (`:30`):
`allowed-once | rejected | cancelled | unavailable`. Service `ctx.approval` (`:72`), Config `{ policy }` default `"ask"`
(`:74`), `setApprovalPolicy(session, policy)` (`:63`), `setPolicy(agent, policy)` (`:98`). `NEVER_SENTENCE` (`:39`) is
what the model is told when the policy is `never`. Request API (`:128`):

```js
async request(req)  // { agent, toolName, callId?, reason?, displayReason?, signal? }
// requires an open turn (hasOpenTurn :49; throws "approval.request() outside an open turn" :130)
// appends approval/asked then approval/decided (:136-170); decide(req, session) :172
// effectivePolicy :152 — policy never → "rejected"; aborted signal → "cancelled"
// decision waterfall "approval/request"; missing answer → "unavailable"
```

### 2.3 Escalation (the only widening path for a tool)
`dsh-sandbox/lib/index.js`: `ESCALATION_TARGETS` (`:42`) = `["workspace-write","danger-full-access"]`;
`WIDER_MODES` (`:30`) maps `read-only → [workspace-write, danger-full-access]`, `workspace-write → [danger-full-access]`;
`validateEscalationArgs(sandboxPermissions, justification)` (`:51`); `approveEscalation(request, approval)` (`:99`):

```js
async function approveEscalation(
  { requestedMode, effectiveMode, justification, subject = "operation" },
  { approver, agent, toolName, callId, signal },
) // → approver.request({ agent, toolName, callId, reason, displayReason: { en, zh }, signal? })
   // returns the granted mode; rejection text "the user rejected escalating this <subject> to ..."
```

Denial text `sandboxDenialMarker(mode)` (`:64`) → `[sandbox: file access denied under <mode> mode]`;
`escalationHintMarker(subject)` (`:76`), `sandboxPermissionsDescription(subject)` (`:86`), `SANDBOX_UNAVAILABLE` (`:264`,
fail-closed). Real consumer: `dsh-tool-fs/lib/index.js:1134-1156` (`resolvePolicy`) calls `validateEscalationArgs`,
takes `this.policy?.resolve({ session })`, and with escalation args calls
`approveEscalation({ requestedMode, justification, effectiveMode: policy.mode, subject: "operation" },
{ approver: ctx.get("approval"), agent: exec.agent, callId: exec.callId, toolName, signal: exec.signal })`, returning
`{ ...policy, mode: approvedMode }`. Tool-facing schema (`:1108-1120`): `sandbox_permissions` enum
ESCALATION_TARGETS + `justification` string. `dsh-tool-fs` refuses to mount over a confining filesystem without a
policy: `tool-fs: the mounted filesystem confines but ctx.sandboxPolicy is missing` (`:1099`).

### 2.4 Presets
`dsh-permission-presets/lib/index.js`: `CUSTOM_PRESET = "custom"` (`:50`), `AUTO_PRESET = "auto"` (`:52`),
`AUTO_PRESET_SPEC = { sandbox: "danger-full-access", approval: "ask" }` (`:58`); state schema (`:62-71`)
`{ preset, sandbox, approval, seeded }`; `applyPermissionEvent` (`:85`) folds `permission/preset`, `sandbox/mode`,
`approval/policy`, `session/end-seed`; Config `presets` (`:138`) plus volatile `defaultPreset`. Presets are session
events, not tool-visibility masks.

### 2.5 What a tool must consult before touching files outside the workspace
1. `ctx.sandboxPolicy.resolve({ session })` → effective `mode` + `workspaceRoot` (`dsh-sandbox-policy:141`).
2. Do the I/O only through `ctx.fs`; the sandboxed filesystem re-resolves and re-checks containment, throwing `FsError`
   `FS_SANDBOX_DENIED` (section 3).
3. For wider access: `sandbox_permissions` + `justification` tool args → `approveEscalation` → `ctx.approval.request`
   (must be inside an open turn). No other path exists; policy `never` resolves every `ask` to `rejected`.
4. For subprocesses, confine argv with `ctx.sandbox.confine(argv, policy, signal)`.

### 2.6 Process confinement surface
`SandboxProvider extends Service` on key `"sandbox"` (`dsh-sandbox/lib/index.js:282-286`); concrete
`async confine(argv, policy, signal)` (`dsh-sandbox-local/lib/index.js:305`) → `{ argv, enforcement, denialSignatures,
runnerFailureRules }`, fail-closed `SANDBOX_UNAVAILABLE`. It is separate from `ctx.sandboxPolicy`.

---

## 3. Filesystem helpers to reuse

`ctx.fs` is a `Service` (`dsh-fs/lib/index.js:58`, `super(ctx, "fs")`) with `get sandboxMode()` (`:86`) and
`watch(target, changed, signal)` (`:70`). All methods are async and take a resolved target plus `signal`.
Local backend — `dsh-fs-local/lib/index.js`:

```js
async resolve(path, opts)                          // :780  opts { cwd?, signal? }
async stat(target, signal)                         // :802
async lstat(path, opts, signal)                    // :813
async readText(target, signal)                     // :825
streamText(target, signal)                         // :831  (Readable)
async readBytes(target, signal, maxBytes)          // :837
async readByteRange(target, range, signal)         // :843
async listDir(target, signal)                      // :849
async writeText(target, content, expected, signal) // :864
async editText(target, edit, expected, signal)     // :883
// contains(parent, child) :798, processPath(target) :789
```

Write intents (`expected`) observed: `{ kind: "createIfAbsent" }`, `{ kind: "replaceIfVersion", version }`.
`editText` edit object used by the built-in tool: `{ oldString, newString, replaceAll }`
(`dsh-tool-fs/lib/index.js:754-758`). `FsError` codes (`dsh-fs/lib/index.js:34`): `FS_NOT_FOUND`,
`FS_STALE_VERSION`, `FS_NOT_OBSERVED`, `FS_NOT_REGULAR_FILE`, `FS_AMBIGUOUS_EDIT`, `FS_SANDBOX_DENIED`, `FS_TOO_LARGE`.

Path-escape guard — `dsh-fs-sandbox/lib/index.js`:

```js
class SandboxedFileSystem extends LocalFileSystem                              // :104 inject ["sandboxPolicy"]
async writeText(target, content, expected, signal, sandboxPolicy)              // :125
async editText(target, edit, expected, signal, sandboxPolicy)                  // :139
async checkedTarget(target, sandboxPolicy)  // :153 → resolve + contains, else FS_SANDBOX_DENIED (:157/:164)
isPathUnder(path, root, caseSensitive = process.platform !== "win32")          // :53
```

`isPathUnder` is a lexical fast path plus a dev/ino ancestor walk (`:38-64`). The package documents itself as a
trusted-code fence, **not** a kernel boundary (`:77-85`); confine processes with `ctx.sandbox.confine`.

Path policy of the built-in `dsh-tool-fs` (copy the pattern; do not import it):

- `sessionResolveOptions(ctx, exec)` (`:171-177`) → `cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)`
  then `{ cwd?, signal }` (relative paths resolve against the session cwd).
- `resolveRegularReadTarget` (`:191-203`) = `ctx.fs.resolve(...)` + `ctx.fs.stat(...)`, throws `FS_NOT_FOUND` /
  `FS_NOT_REGULAR_FILE`, emits `fs/observed`.
- Mutations take a guard intent first: `intent = await ctx.waterfall("fs/write-intent" | "fs/edit-intent", target,
  exec, () => undefined)` (`:753`), then `ctx.fs.writeText(target, input.content, intent, exec.signal, sandboxPolicy)`
  (`:610`) or `ctx.fs.editText(target, { oldString, newString, replaceAll }, intent, exec.signal, sandboxPolicy)`
  (`:754-758`). Errors are normalized with `sandbox.mapError(error, sandboxPolicy)` + `remediateFsError` (`:760`).
- `dsh-tool-fs` exports only `{ Config, apply, inject, name }` (`:1231`) — **no reusable helpers** (NOT FOUND);
  reuse `ctx.fs` and replicate the ~40-line wrapper.

Large files: use `readBytes(target, signal, maxBytes)` / `readByteRange` / `streamText`, not `readText`. `ctx.fs` has
no atomic-rename or fsync helper (NOT FOUND); only the storage backend has atomic tmp+rename.

---

## 4. Settings / config

### 4.1 Exposing a settings UI section
Mark only user-editable fields `.volatile()` on the plugin's Schemastery `Config`; the settings service auto-derives
one section per configurable plugin entry. There is no section-registration API (NOT FOUND). Example:
`dsh-agent-loop/lib/index.js:1554` `maxParallelToolCalls: z.number().step(1).min(1).default(10).volatile()`;
secrets use `z.string().role("secret").volatile()` (`dsh-web-search-deepseek/lib/index.js:278`).

`SettingsForms extends Service`, key `"settings"` (`dsh-settings/lib/index.js:330`), injects
`["configEditor","profileContext"]` (`:324`), no Config of its own (README:33). Custom page policy:
`configure({ auto: false }, ctx.fiber)` (`:370`) — one per plugin instance, returns a disposer; typically called in an
optional `ctx.inject(["settings"], ...)` child of `apply` (README); `invalidate()` (`:382`).

```js
describe(options)  // :413 → descriptors per active profile entry
// { autoGenerate, ns, schema, revision, applies: "live", value, base, user, ...secret metadata }  (:441-451)
```

`revision` increments when the raw schema/config changes; the service emits `settings/document-updated` (ns, revision)
(`:428-435`). Revision-checked mutators:

```js
async update(ns, patch, expectedRevision)      // :470  merge editable fields
async replace(ns, section, expectedRevision)   // :479  reset live fields, then set
async mutate(ns, ops, expectedRevision)        // :488  form ops set/unset (unset array index removes)
async write(ns, change, expected, paths = [])  // :501
```

`writable` is `true` (`:396`); `documentPath` (`:400`) forwards to `configEditor.documentPath`; `prepareDocument()`
(`:406`). Errors: `No configurable plugin entry "<ns>"` (`:504`), `Plugin entry "<ns>" has no volatile fields`
(`:506`), `Config field "<path>" is not volatile` (`:507`/`:520`), `SettingsConflictError` `settings namespace "<ns>"
changed since it was read (expected revision X, now Y)` (`:176`).

### 4.2 Persistence and precedence
Writes go through the config editor: `dsh-config-editor/lib/index.js` `super(ownerContext, "configEditor")` (`:20`),
`get documentPath()` (`:24`) → `profileContext.patchPath`; `configuration()` (`:39`) returns
`{ entry, inherited, override }` rows; `async edit(entry, change)` (`:69`) locks `<profile>/package.json` (`:72`),
validates the YAML sequence, and refuses when a home patch or CLI overlay shadows the value — `Configuration for "<id>"
is overridden by a home patch or command-line overlay` (`:122`). Profiles: `$DSH_HOME/profiles/<name>/cordis.patch.yml`
(`dsh-app-boot`: `PROFILES_DIR = "profiles"` `:507`, `PROFILE_PATCH_FILENAME = "cordis.patch.yml"` `:509`,
`resolveProfileDir(name, home)` `:546`). On this machine `C:\Users\LEGION\.dsh\profiles\web\cordis.patch.yml` exists
and is an empty YAML sequence `[]`; `profiles/` also holds `desktop`. Reset restores the layer below the profile
override; home patches/CLI overlays win (dsh-settings README:12,33).

### 4.3 Programmatic config surface
No read-back service: plugins read their `Config` object directly (dsh-settings README:47) — the Schemastery-validated
value received at `apply`, which settings mutates through the same config layer. Read it at use time (do not cache a
copy) if live changes matter. Only `.volatile()` fields are editable; everything else is deployment config.

---

## 5. Persistence (`dsh-storage`)

### 5.1 Hub and domain form
`ctx.storage` is the hub (`dsh-storage/lib/index.js:104`): backend registry (`register(name, backend)` `:45`, `get`
`:57`, `names` `:66`), `mount(form, facility)` (`:118`), `form(form)` (`:130`), `get domain()` (`:135`). Unit names
match `/^[a-z][a-z0-9_]*$/` (`:80`); `storageBackendServiceKey(name)` → `storage.backend.<name>` (`:97`). Failures use
`StorageError` (duplicate-backend / backend-not-found / form-not-mounted / duplicate-mount).

The usable API is the domain form (`dsh-storage-domain`), reachable as `ctx.storage.domain.open(spec)` or via the
provided service key `storageDomain` (`:449`). Plugin seam: `inject = ["storage"]` (`:311`), Config
`{ backend: <required>, routes: {} }` (`:312-315`).

```js
defineDomain(spec)            // :61 spec { name, version, layout?, compatibleVersions?, tables, global?, invalidRecords? }
domainTable(schema)           // :46 → { valueSchema }
ctx.storageDomain.open(spec)  // :355 → Domain (single open per name; "already-open" otherwise)
domain.table(name)            // :187 → table handle
domain.global                 // get/set (:157)
domain.close()                // :198
ctx.storageDomain.get(name)   // :405; closeAll() :414
```

Descriptor (`:82`): `{ name, version, tables, hasGlobal, layout?, compatibleVersions? }`. Validation: names match
`UNIT_NAME_RE`; `version` a non-negative integer; `compatibleVersions` must be `< version`; `layout` is `"single"` or
`"per-record"`; `invalidRecords` only `"backup-and-skip"`; the global schema must not accept `null`.

### 5.2 Read/write semantics

```js
table.get(key)        // :241  sync, throws "missing-key"
table.entries()       // :245  sync snapshot
table.keys()          // :249
table.size()          // :253
table.put(key, value) // :257  durable write, then domain/changed
table.delete(key)     // :264  false if absent
table.update(key, fn) // :278  read-modify-write; "missing-key" if absent
```

Reads are synchronous from validated in-memory state; writes serialize on a unit chain: `unit.write` first, then
memory, then emit `domain/changed` (`:216`). There are **no cross-table transactions** and **no migration hooks**
(NOT FOUND). Version mismatch fails with `version-mismatch` (`dsh-storage-json/lib/index.js:102`);
`invalidRecords: "backup-and-skip"` uses `unit.backupRecord`. A unit is single-open per name; `close()` waits for the
write chain.

### 5.3 JSON backend and on-disk locations
`dsh-storage-json`: Config `{ root: z.string().required() }` (`:551`), backend (`:554`), `async openUnit(descriptor)`
(`:569`), atomic tmp+rename (`:26`). `single` layout → `<root>/<name>.json` (`:179`) and every write rewrites the whole
unit (README:140). `per-record` layout → `<root>/<name>/<table>/<key>.json` + `global.json` (`:312-344`), directory
authoritative (README:73), record keys `[a-zA-Z0-9_-]+` (README:56), legacy single-file seeding (`:293-400`). Version
stamps: unit `version` + `compatibleVersions`; mismatch → `version-mismatch` (`:102`). `backupRecord` writes
`<key>.json.bak.<YYYYMMDDHHmm>` (`:473-482`).

Observed root `C:\Users\LEGION\.dsh\storages`: `workspace.json` (single layout; unit `{"name":"workspace","version":2}`,
global `{ initialized, workspaceIds, archivedSessionIds, pinnedSessionIds, defaultWorkspaceId }`, table `workspaces` →
`{ path, title, sessionIds, createdAt, updatedAt }`), `schedule.json` (single), and `session_projcache/sessions/<id>.json`
(per-record).

### 5.4 What is safe for large blobs (file checkpoints)
**Not a storage domain.** Domains are in-memory validated JSON: `single` rewrites the whole unit per write and every
record is loaded/validated at open; README guidance says use SQLite for large or frequent data
(`dsh-storage-json/README.md:32,140`). There is no blob/checkpoint store API (NOT FOUND).

- Small records (indexes, manifests, checkpoint metadata): `per-record` domain.
- Large/binary blobs (file contents, diffs): immutable files, one per checkpoint (content-addressed or `<seq>-<hash>`),
  under a plugin-owned directory below the workspace or `<DSH_HOME>`, using `ctx.fs` streaming + the write-intent/
  observed protocol; own the retention/dedupe policy.
- Precedent: attachments live at `<DSH_HOME>/attachments/v1`, content-deduped and never auto-deleted
  (`dsh-attachment-local/README.md:55`), but that store is for prompt attachments, not a general plugin blob API.
- Session checkpoints flush via `session/flush` (dsh-session-checkpoint-policy README:48-66: before model request,
  before top-level tool body, at agent/pre-step); register plugin state that must survive crashes.

---

## 6. Background work (`dsh-jobs`)

`ctx.jobs` is an abstract `JobRegistry extends Service` (`dsh-jobs/lib/index.js:115`, `super(ctx, "jobs")` `:118`;
the contract constructor throws if loaded directly). Provider `dsh-jobs-local`: `LocalJobRegistry` (`:356`),
`Config` (`:357-362`) defaults `maxConcurrentJobsPerOwner = 10` (`:340`), `retainBytes = 256 KiB` (`:342`),
`settledRetainBytes = 16 KiB` (`:344`), `pumpPollMs = 150` (`:346`). `dsh-tool-jobs` attaches the controller; without
one `start()` throws `background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs
in its composition)` (`:414`).

```js
start(spec)                      // :412 → Job; spec { kind, label, owner?, output?, outputLimitBytes?, toolCall?, run(handle) }
list(caller)                     // :503
get(id, caller)                  // :506
read(id, caller)                 // :509  model cursor, consuming; producer result once after settlement
readAt(id, from, caller)         // :512  non-consuming, absolute byte offsets (observers)
kill(id, caller, reason)         // :517 → "requested"; emits stopping, calls producer cancel, reason in terminal detail
async wait(id, timeoutMs, caller, signal)  // :520 blocks ≤ timeout; resolves the view even on timeout (TASK_WAIT_TIMEOUT :338)
remove(id, caller)               // :523 only settled: "job <id> is still <status>; kill it and wait for settlement before removing it" (:525)
attachController(name)           // :528
events.subscribe(filter, listener) // events getter :408; registration/progress/stopping/settlement/removal/output
```

`JobHandle` = `{ id, append(text, options), updateProgress(line) }` (`:430-438`); `run(handle)` returns
`{ done, cancel }` (`:439`, settle `:769`). Ids are `<kind>-<16 hex>` (`:422`) — not secrets; ownership is fenced by
owner `SessionId` (`resolveOwner` `:537`, `assertAccess` `:575`). Jobs are per-session (`owner: exec.agent.id`; real
call site `dsh-tool-pwsh/lib/index.js:369-375`). `stdout`/`stderr` reach the model, `log` only observers;
`updateProgress` shows live progress until settlement (dsh-jobs README:34,36).

Concurrency/cancellation: hard cap per owner (`:419`: `background job limit reached for this owner (limit: N); use
job_kill ...`); admission preflights inside `start()` before `run()` — use it for hash walks/repo scans instead of
unbounded fan-out. `kill` is cooperative: producer cancel runs before the status change (`:644-654`); a throwing cancel
during teardown force-fails the record and logs a possible orphan (`:857-858`). Retention is a byte ring (256 KiB live,
16 KiB settled; reads below the window are lossy). **In-process only**: jobs die with the harness process; no durable/
restartable backend (NOT FOUND, README:128). Session archive asks `workspace/session-activity` and kills via
`workspace/session-stop` (`installJobArchiveAdmission` `:19`).

---

## 7. Workspace and roots

- Current session cwd: `WorkingDirectoryService` on `ctx.workingDirectory` (`dsh-working-directory/lib/index.js:24-25`);
  `get(session)` (`:76`), `ensure(agent, signal)` (`:87`, resolves via `ctx.fs.resolve(current, { signal })` `:90`),
  `set(agent, path, signal)` (`:113`), `contextText(session)` (`:121`), `directory(path, cwd, signal)` (`:124`).
  Launch cwd is `session.header.cwd` (projection `init: (header) => header.cwd ?? null` `:34`);
  `ensure` falls back to `agent.session.header.cwd ?? this.defaultDirectory` (`:98`).
- Workspace root for policy: `ctx.sandboxPolicy.resolve({ session }).workspaceRoot` = `session.header.cwd ?? configured
  fallback` (`dsh-sandbox-policy:141`); or `ctx.fs.resolve(".", { cwd })`.
- Multiple workspaces: yes. `WorkspaceRegistry extends Service`, key `"workspaceRegistry"` (`dsh-workspace/lib/index.js:376`,
  injects `["storageDomain","sessionPersistence"]` `:355`, `[Service.init]` `:379` opens the `workspace` domain, table
  `workspaces`, global state). API: `create(path, title)` (`:408`, realpath, must be a directory),
  `initializeDefault(resolveDirectory)` (`:425`), `get(id)` (`:445`), `list()` (`:454`), `delete(id)` (`:469`),
  `insertBefore(id, beforeId)` (`:479`), `archiveSession(sessionId, options = {})` (`:526`), `unarchiveSession` (`:553`),
  `pinSession` (`:578`), `unpinSession` (`:598`), `sessionKnown(id)` (`:614`), `stopSessionActivity(sessionId)` (`:621`),
  `resolveByPath(path)` (`:637`), `createCanonical` (`:641`). Records coexist (`workspaceIds` + `defaultWorkspaceId`
  in the `workspace.json` global); a session belongs to the workspace whose canonical path equals its cwd, and still
  has one active cwd at a time.
- Change capture: `dsh-workspace-changes` provides `ctx.workspaceChanges` with `{ summary(sessionId, seq), diff(sessionId,
  seq, index, signal) }` (`:1019-1022`); records turn-start/turn-end git tree snapshots plus whole-file captures around
  `fs/write-intent`/`fs/edit-intent` (`:1076-1085`) and `tools/pre-execute` (`:1086`); Config caps `timeoutMs,
  outputMaxBytes, maxFiles, maxFileBytes, diffTimeoutMs` (`:998-1004`). It exports only `{ Config, apply, inject, name }`
  (`:1097`) — reuse the service, not the module. Its per-turn snapshots already provide checkpoints; a file-checkpoint
  feature should avoid duplicating them blindly.

---

## 8. Gaps (explicit NOT FOUND)

- `ctx.tools.define` / a standalone `tools.register` outside a plugin context — NOT FOUND (API is `defineTool` +
  `ctx.tools.register`).
- Permission-mode gating of tool *visibility* — NOT FOUND; only `restrict`/`guard` and the `tools/pre-execute` waterfall;
  modes gate FS/process effects.
- `dsh-approval*` packages and `dsh-permission*` beyond `dsh-permission-presets` — NOT FOUND.
- Settings API for arbitrary UI sections/custom controls or reading another plugin's config — NOT FOUND; only
  Schemastery `Config` + `.volatile()`, consumed by client settings packages.
- Storage namespace API, transactions, migration hooks, cross-unit atomicity — NOT FOUND; version stamps +
  `version-mismatch` + `invalidRecords: backup-and-skip` are the only evolution story.
- Blob/checkpoint store API (large binary records, content-addressed storage) — NOT FOUND; storage domains are small
  in-memory JSON (single layout rewrites the unit).
- Durable background jobs across process restart or shared between processes — NOT FOUND (in-process contract).
- Atomic rename/fsync helper on `ctx.fs` — NOT FOUND (only the storage-json backend implements tmp+rename).
- Process confinement on `ctx.sandboxPolicy` — NOT FOUND; confinement is `ctx.sandbox.confine` on a separate service.

---

## 9. Recommended seams for this plugin

- Register with `defineTool` + `ctx.tools.register`; inject `ctx.fs`/`ctx.sandboxPolicy`/`ctx.approval`; never shell out
  for file edits.
- Gate writes: `ctx.waterfall("fs/write-intent"|"fs/edit-intent", target, exec)` → intent → `ctx.fs.writeText/editText
  (..., exec.signal, policy)`; when escalation args are present call `approveEscalation` (needs an open turn).
- Settings: mark Config fields `.volatile()`; read the same Config object at use time; never cache.
- Persist indexes/manifests in a `per-record` domain; keep checkpoint blobs as immutable files, not records.
- Run hash walks/repo scans via `ctx.jobs.start({ kind, label, owner: exec.agent.id, run })`; respect the 10-job owner
  cap and cooperative `kill`; never persist job ids as durable handles.
- Derive the root from `ctx.workingDirectory.ensure(agent, signal)` / `sandboxPolicy.resolve`; use
  `ctx.workspaceRegistry.list()/resolveByPath()` when a plugin must span workspaces.
