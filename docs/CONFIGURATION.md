# Configuration

Both plugins are Cordis plugins. Their configuration lives in the `config` object of
the plugin row in `cordis.patch.yml`; the package's `dsh.bundle.patch` entry is what
makes that row available to a profile. Every field is optional. When a field is
omitted, the default below applies.

The two plugins are independent. A profile can enable one, both, or neither. The
examples use `$DSH_HOME`, which means the `DSH_HOME` environment variable when it is
set to a non-empty value, otherwise `~/.dsh`:

- Time Machine root: `$DSH_HOME/time-machine`.
- Context OS root: `$DSH_HOME/context-os`.
- Context OS database: `$DSH_HOME/context-os/context.db`.

## Time Machine

### Keys

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Master switch. When false the plugin returns without providing `ctx.timeMachine`, registering tools, or attaching filesystem/session hooks. Existing data is left alone. |
| `root` | string (path) | unset | Storage root. When omitted or blank, `$DSH_HOME/time-machine`. The directory holds the object store, the checkpoint journal, and staging. |
| `maxFileBytes` | integer | `2097152` (2 MiB) | Largest file whose content is stored. Accepted range: `1024` to `536870912` (512 MiB). A larger file is recorded as oversized metadata without content, so it cannot be restored. |
| `maxFiles` | integer | `5000` | Maximum number of files considered by one workspace scan. Accepted range: `1` to `200000`. Raise it for a workspace that legitimately has more files. |
| `ignoreExtra` | string[] | `[]` | Additional ignore globs, merged with the built-in policy. Built-in ignores cannot be overridden in V0.1. Blank and non-string entries are dropped during normalisation. |
| `capture.writeIntent` | boolean | `true` | Capture the pre-image of files changed through the Harness write intent. |
| `capture.editIntent` | boolean | `true` | Capture the pre-image of files changed through the Harness edit intent. |
| `capture.workspaceSnapshotOnTurnStart` | boolean | `false` | Take a full workspace snapshot at the start of each turn. This is a coarse opt-in that can cover shell-mediated edits, at the cost of a full hash pass per turn. |
| `keep.maxCheckpoints` | integer | `2000` | Journal size at which compaction is triggered. Accepted range: `10` to `1000000`. Lowering it does not immediately rewrite the journal; compaction happens when the index grows past the limit. |
| `tools.enabled` | boolean | `true` | Register the `tm_*` tools. When false the service and capture hooks remain active, but the model cannot call the tools. |
| `tools.disabled` | string[] | `[]` | Tool names to skip individually, for example `['tm_diff']`. Names that are not registered are harmless. |
| `tools.maxDiffChars` | integer | `20000` | Maximum characters in `tm_diff` text. Accepted range: `200` to `2000000`. Longer output is cut and marked `[truncated]`. |
| `tools.maxListItems` | integer | `50` | Maximum number of records returned by `tm_list`, regardless of the requested `limit`. Accepted range: `1` to `10000`. |

### Example row

The checked-in patch uses the defaults. This example adds the optional storage
location and one extra ignore pattern:

```yaml
- insert:
    - id: harness-ext-time-machine
      name: '@harness-ext/time-machine'
      config:
        enabled: true
        root: /Users/example/.dsh/time-machine
        maxFileBytes: 2097152
        maxFiles: 5000
        ignoreExtra:
          - '*.tmp'
        capture:
          writeIntent: true
          editIntent: true
          workspaceSnapshotOnTurnStart: false
        keep:
          maxCheckpoints: 2000
        tools:
          enabled: true
          disabled: []
          maxDiffChars: 20000
          maxListItems: 50
```

Omit `root` to use the default location. On Windows use a path such as
`C:\Users\example\.dsh\time-machine`, but forward slashes also work in YAML.

### Capture behaviour

Time Machine has two capture paths:

- File intents are authoritative. After the write or edit hook returns and before
  the underlying write happens, the plugin reads the pre-image and attributes it to
  the current turn and tool call. The first touch of a path in a turn wins, so a
  later read does not replace the original image.
- At turn end, buffered changes become one `auto-turn` checkpoint. A turn with no
  captured changes produces no checkpoint. A failed tool result is stored as a test
  result on the checkpoint.

Setting `capture.workspaceSnapshotOnTurnStart` adds a full snapshot at the beginning
of each turn. That snapshot is a separate coarse checkpoint. It is the only capture
path that sees edits made through `pwsh` or other tools that do not emit file
metadata, but it hashes the whole workspace on every turn and is off by default.

`tm_checkpoint` creates a `manual` checkpoint on demand. It scans the workspace
root; an absolute path outside that root is not part of a manual snapshot. This is
separate from restore, which writes the paths recorded in a checkpoint.

### Restore safety

`tm_restore` always builds a plan first:

- Each entry is classified as `write`, `delete`, `unchanged`, or `unverifiable`.
- A `conflict` is reported when the current file hash is neither the target hash nor
  the hash that was expected to be current.
- `unverifiable` means the target content is absent or its object is missing from the
  store. Such paths are skipped.
- A plan is `safe` only when it has no conflicts and no missing objects.

A dry run writes nothing and creates no safety checkpoint. Applying a plan with
writes or deletes first creates a `pre-restore` checkpoint covering those paths, then
writes through a temporary file and rename, then re-hashes every written file. The
tool reports `failed` entries and does not claim success if verification fails.

An unsafe plan is refused unless `force: true` is passed:

```text
restore refused: N file(s) changed since the checkpoint; re-run with dry_run to inspect, or force=true to overwrite
```

`force` overrides the conflict refusal; it does not reconstruct a missing object.
Missing objects remain unverifiable. Use `tm_diff` before forcing, and `tm_status`
to check store size and checkpoint count.

### Normalisation

`normalizeConfig` never throws. Invalid input is a normal condition, logged as an
issue, and the plugin still mounts:

- A value of the wrong type falls back to the field's default.
- A finite number is truncated to an integer and clamped into its accepted range.
  For example, `maxFileBytes: 0` becomes `1024`; `maxFileBytes: 1` also becomes
  `1024`; `maxListItems: 999999` becomes `10000`.
- `root` must be a non-empty string; a blank value falls back to the default.
- `ignoreExtra` drops non-string and blank entries.
- Unknown keys are silently ignored. They do not fail the mount and do not produce a
  configuration issue.

Issues are logged with the prefix `time-machine: config "<field>": <message>`. The
plugin does not abort startup because of a bad value.

### Data and reset

The default layout is:

```text
$DSH_HOME/time-machine/
├── objects/<aa>/<sha256>   # content-addressed file images
├── checkpoints.jsonl       # append-only checkpoint journal
└── tmp/                    # staging for atomic writes
```

Identical content is stored once. The object store is garbage-collected against
retained checkpoints; deleting a checkpoint record does not immediately delete an
object that another record still references. Damaged journal lines are reported and
skipped when the index loads.

To reset Time Machine, stop the desktop app, remove the root directory (or set
`root`/`enabled` to a different configuration), and restart. There is no built-in
reset command in V0.1. Removing the directory permanently loses every checkpoint and
its objects. To disable without deleting data, set `enabled: false`; to remove the
plugin, see [Removing a plugin](#removing-a-plugin).

## Context OS

### Keys

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Master switch. When false the plugin still provides an inert `ctx.contextOs` service, but opens no database, registers no `co_*` tools, and captures no events. |
| `root` | string (path) | unset | Data root. When omitted or blank, `$DSH_HOME/context-os`. Used to derive the database path when `dbFile` is unset. |
| `dbFile` | string (path) | unset | Explicit SQLite database path. When set, it takes precedence over `root`. When omitted or blank, `<root>/context.db`. |
| `mode` | `conservative` \| `balanced` \| `saver` | `balanced` | Budget profile. Selects the threshold, brief cap, retain floor, and brief recall limit. See [Budget modes](#budget-modes). |
| `windowTokens` | integer | `131072` | Context window used to compute pressure and the profile fractions. Accepted range: `1000` to `100000000`. |
| `threshold` | number | unset | Pressure fraction at which a brief becomes eligible. Accepted range: `0` to `1`. When set, overrides the mode's threshold. |
| `briefCapTokens` | integer | unset | Absolute maximum brief size. Accepted range: `80` to `200000`. When set, overrides the mode's fraction of `windowTokens`; the effective cap still has a 120-token floor. |
| `retainTokens` | integer | unset | Absolute number of tokens held back from the window. Accepted range: `0` to `1000000`. When set, overrides the mode's fraction. The reserve is always capped at half of the remaining free space; a brief is built only if at least 80 tokens remain usable after it. |
| `capture.userMessages` | boolean | `true` | Ingest user messages as L1 `user-request` records. |
| `capture.toolErrors` | boolean | `true` | Ingest failed tool results as L1 `error` records. |
| `capture.files` | boolean | `true` | Ingest file-touching tool calls as L1 `file` records. |
| `capture.compaction` | boolean | `true` | Ingest compaction summaries as L3 `compaction-summary` records. |
| `capture.goals` | boolean | `true` | Ingest goal changes as L2 `goal` records. |
| `retention.maxRecords` | integer | `20000` | Maximum stored records. Accepted values: `0` or greater; `0` means unlimited. Rounding applies; negative values fall back to the default. |
| `retention.l1TtlHours` | number | `12` | TTL for captured L1 records, in hours. Must be greater than `0`. |
| `retention.pruneOnTurnEnd` | boolean | `true` | Run retention pruning at turn end. Pruning drops expired records and enforces `maxRecords`. |
| `retention.summaryTtlDays` | number | `30` | TTL for L3 compaction summaries and session digests, in days. Must be greater than `0`. |
| `inject.enabled` | boolean | `false` | Experimental automatic brief injection into the agent pre-step. Default off; see [Injection](#injection-experimental). |
| `inject.minSteps` | integer | `3` | Minimum agent step at which injection is considered. Accepted values: `0` or greater. |
| `tools.enabled` | boolean | `true` | Register the `co_*` tools. When false, capture and the service remain active but the model cannot call the tools. |
| `tools.disabled` | string[] | `[]` | Tool names to skip individually, for example `['co_forget']`. |
| `tools.recallLimit` | integer | `8` | Default number of hits returned by `co_recall`. Must be at least `1`; a call-level `limit` is clamped to `1..50`. This is separate from the per-mode brief recall limit. |
| `tools.maxChars` | integer | `600` | Maximum characters of a record body returned by `co_recall`. Accepted range: `80` and above. Longer bodies are truncated. |

Todos are ingested from `todo/write` events as L2 records, and session titles become
L3 session digests; neither has its own capture flag. Assistant prose is not indexed.
If the database cannot be opened, the plugin logs the failure, keeps an inert service,
and does not register the `co_*` tools.

### Example row

The checked-in patch uses the defaults. This example sets explicit storage paths and
overrides the balanced profile's threshold, brief cap, and retain floor:

```yaml
- insert:
    - id: harness-ext-context-os
      name: '@harness-ext/context-os'
      config:
        enabled: true
        root: /Users/example/.dsh/context-os
        dbFile: /Users/example/.dsh/context-os/context.db
        mode: balanced
        windowTokens: 131072
        threshold: 0.7
        briefCapTokens: 1200
        retainTokens: 26000
        capture:
          userMessages: true
          toolErrors: true
          files: true
          compaction: true
          goals: true
        retention:
          maxRecords: 20000
          l1TtlHours: 12
          pruneOnTurnEnd: true
          summaryTtlDays: 30
        inject:
          enabled: false
          minSteps: 3
        tools:
          enabled: true
          disabled: []
          recallLimit: 8
          maxChars: 600
```

`threshold`, `briefCapTokens`, and `retainTokens` are optional. Remove them to use
the values implied by `mode`. `dbFile` is optional too; remove it to use
`<root>/context.db`.

### Budget modes

Each mode supplies a pressure threshold, a brief cap as a fraction of the window, a
retain floor as a fraction of the window, and a recall limit used while composing
the brief:

| Mode | Threshold | Brief cap | Retain floor | Brief recall limit |
| --- | --- | --- | --- | --- |
| `conservative` | `0.85` | `1.2%` of `windowTokens` | `10%` of `windowTokens` | 4 |
| `balanced` | `0.70` | `0.9%` of `windowTokens` | `20%` of `windowTokens` | 6 |
| `saver` | `0.50` | `0.6%` of `windowTokens` | `15%` of `windowTokens` | 8 |

The decision itself is measured against the **real** context window when the harness reports one (the `contextPressure` projection carries `contextWindow`); `windowTokens` is only a fallback for harnesses that report none. Every decision is appended to `<root>/decisions.jsonl` (see `audit` below), so "why was no brief injected?" is answerable after the fact.

The fractions are converted with rounding and a floor: the brief cap is
`max(120, round(fraction * windowTokens))`, and the retain floor is
`max(0, round(fraction * windowTokens))`. Explicit `briefCapTokens` and
`retainTokens` replace the fraction-derived values. Explicit `threshold` overrides
the mode threshold.

The decision is computed from the current token usage:

```text
pressure = used / windowTokens
if pressure < threshold: no brief
free = windowTokens - used
reserve = min(retainTokens, floor(free / 2))     # the floor never exceeds half the room
available = free - reserve
if available < 80: no brief
briefTokens = min(briefCapTokens, available)
```

The cap on the reserve is what makes the brief reachable at high pressure: with
8 000 tokens free and a 20 000-token floor, the old rule reported "nothing left"
while a 900-token brief would have fit. A brief never takes more than half the
remaining headroom, and nothing is contributed once the window is exhausted
(`free <= 0`, i.e. pressure ≥ 100 %).

`used` is the token meter's `totalTokens` when the meter is available, otherwise an
estimate. `co_status` reports the basis (`usage` or `estimated`). The 80-token
minimum is a budget rule: below it, the brief is not worth the injection. This is
separate from the 120-token floor applied when a brief is built explicitly.

### Brief composition

The brief heading is:

```text
[Context OS brief] Memory that must survive compaction:
```

Sections are added in this order, and each section header consumes part of the
budget:

1. Request: L1 `user-request` and `goal` records, up to 2.
2. Open errors: L1 `error` records, up to 3.
3. Files in flight: L1 `file` records, up to 4.
4. Decisions and contracts: L2 `decision` and `contract` records, up to 5.
5. Progress and todos: L2 `progress` and `todo` records, up to 4.
6. Recalled: L3 records, only when a non-empty `query` is supplied and budget remains.
   The mode's brief recall limit applies here; L1 recall hits with a score below
   `0.5` are skipped.

Lines are appended until the token cap is reached, at which point the result is
marked `truncated`. Snippets are capped at 220 characters. If no line fits, the brief
is empty. `co_brief` returns the rendered `text`, the estimated `tokens`, and the
`truncated` flag. Its `max_tokens` argument, when present, overrides the decision's
brief size and the profile cap, with a floor of 120 tokens.

The `query` argument is optional. In V0.1 it is used only to enable the L3 Recalled
section; it is not inferred from the latest user message, despite older wording in
the tool description. Without a query, the other five sections are still composed.

### Injection (experimental)

`inject.enabled` is off by default and should be treated as experimental. When it is
on, the plugin adds a waterfall listener to the agent pre-step. After the normal
pre-step handler runs, it checks all of the following:

- the result kind is `enter` and the result contains a message list;
- a session id is available and the current step is at least `inject.minSteps`;
- injection has not already happened for this session and turn;
- the budget decision says a brief should be injected;
- the brief is non-empty and no `[Context OS brief]` marker is already present.

If every check passes, it appends one user message containing the brief text. Any
error during the waterfall is caught and the original pre-step result is returned,
so the turn continues without the brief. Injection happens at most once per turn.

The default is off because a malformed pre-step message list can break a turn. The
listener is deliberately defensive, but the agent pre-step shape is an internal
contract; enable it only after validating it against the Harness version in use.
`co_status.inject` reports whether injection is active for the current decision; it
does not simply echo `inject.enabled`.

### Normalisation

`normalizeConfig` never throws. Unlike Time Machine, Context OS does not clamp an
out-of-range value: it keeps the default and records an issue.

- A wrong type or an out-of-range value falls back to the default.
- Accepted numeric values are rounded to the documented integer where the field is
  an integer.
- An unknown `mode` falls back to `balanced`.
- A blank `root` or `dbFile` is treated as unset.
- Unknown keys are silently ignored.
- The plugin still mounts after a bad value; the issue is logged with the prefix
  `context-os: config.<path>: <message>`.

For example, `windowTokens: 0` keeps `131072` and records an issue;
`maxRecords: -1` keeps `20000`; `mode: aggressive` becomes `balanced`. A wrong type
in one field does not prevent the other fields from being applied.

### Data and reset

The default database is `$DSH_HOME/context-os/context.db`, with SQLite's WAL and
shared-memory side files (`context.db-wal`, `context.db-shm`) alongside it. The
schema is versioned (`CONTEXT_OS_SCHEMA` 1). It contains the `memories` table and the
FTS5 `memories_fts` index. The store opens with WAL journaling and `synchronous =
NORMAL`.

`root`/`dbFile` move the database; they do not migrate existing data. To reset, stop
the desktop app, remove `context.db` together with its `-wal` and `-shm` files, and
restart. There is no export, import, or reset command in V0.1. The same rule applies
to Time Machine: stop the app before deleting its root.

To disable without deleting data, set `enabled: false`. To remove the plugin, see
below.

## Removing a plugin

Disable a plugin without uninstalling it:

```yaml
config:
  enabled: false
```

Remove an installed plugin from a profile:

```bash
dsh plugin --profile desktop remove @harness-ext/time-machine
dsh plugin --profile desktop remove @harness-ext/context-os
```

Removing a plugin does not delete its data under `$DSH_HOME`. Delete that directory
separately if the data is no longer wanted. Restart the desktop app after changing
the installed package set.

## Configuration issues at a glance

| Symptom | Likely cause | Effect |
| --- | --- | --- |
| `time-machine: config "maxFileBytes": ...` in the log | Non-numeric or out-of-range value | Value is clamped or replaced; plugin mounts |
| `context-os: config.windowTokens: ...` in the log | Wrong type or out-of-range value | Default is kept; plugin mounts |
| `co_*` tools are missing | `context-os.enabled` is false, `tools.enabled` is false, the name is in `tools.disabled`, or the database failed to open | Service may still be present; no tools |
| `tm_*` tools are missing | `time-machine.enabled` is false, `tools.enabled` is false, or the name is in `tools.disabled` | No service when the master switch is false |
| `tm_restore` refuses | Current file hash conflicts with the checkpoint, or content is missing | Re-run with `dry_run: true`; use `force: true` only after checking the diff |
| Brief is empty | No stored sections fit, pressure is below the threshold, or the 80-token minimum rejected it | Check `co_status` and the budget mode |
| Injection never happens | `inject.enabled` is false, the step is below `minSteps`, the decision declined, or a marker is already present | This is the default and expected behaviour |
