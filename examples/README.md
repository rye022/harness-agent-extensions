# Examples

Copy-paste material for trying the two plugins without reading the whole repository.

## 1. Install both plugins into a DeepSeek Harness profile

```bash
# from the repository root (node >= 22.12, pnpm 11)
pnpm install
pnpm build

mkdir -p "$DSH_HOME/pkgs"
pnpm pack --pack-destination "$DSH_HOME/pkgs"                                   # @harness-ext/shared
pnpm --dir packages/time-machine pack --pack-destination "$DSH_HOME/pkgs"
pnpm --dir packages/context-os    pack --pack-destination "$DSH_HOME/pkgs"
```

Create a profile and register the tarballs:

```bash
DSH_PROFILE=demo
dsh --profile $DSH_PROFILE --from-default-profile web --dump-config > /dev/null

cat >> "$DSH_HOME/profiles/$DSH_PROFILE/pnpm-workspace.yaml" <<'YAML'

overrides:
  '@harness-ext/shared': file:REPLACE_WITH_ABSOLUTE_PATH/harness-ext-shared-0.1.0.tgz
YAML

dsh plugin --profile $DSH_PROFILE add \
  "$DSH_HOME/pkgs/harness-ext-shared-0.1.0.tgz" \
  "$DSH_HOME/pkgs/harness-ext-time-machine-0.1.1.tgz" \
  "$DSH_HOME/pkgs/harness-ext-context-os-0.1.1.tgz"

dsh --profile $DSH_PROFILE --dump-config | grep -A3 'harness-ext'
```

Why the `overrides` entry is required: each plugin declares `@harness-ext/shared` as a
`workspace:*` dependency, which does not exist on npm. pnpm 11 ignores
`pnpm.overrides` inside a profile's `package.json`, but honours `overrides:` in the
profile's `pnpm-workspace.yaml`. Without it the install fails with
`ERR_PNPM_FETCH_404` while resolving the registry.

On Windows the paths are absolute with forward slashes, e.g.
`file:C:/Users/me/.dsh/pkgs/harness-ext-shared-0.1.0.tgz`.

Restart the app afterwards (the desktop profile is managed by the Electron app, so a
window reload is not enough — quit from the tray and relaunch).

## 2. The patch rows the bundles add

[`cordis.patch.yml`](cordis.patch.yml) is the same content the packages ship, as a
single file you can copy into a profile's `cordis.patch.yml` when you prefer to
hand-write the rows (for example when testing a locally built `lib/` directory
without packing tarballs). Do not add the rows twice — the bundle already inserts
them.

## 3. A five-minute walkthrough in the chat

```
# 1. make a mess
> rewrite src/server.ts so the port comes from process.env.PORT

# 2. see what was captured (checkpoints are created per turn and per tool call)
> tm_list
> tm_diff {"id":"cp_..." ,"side":"before"}

# 3. undo, safely: a dry run first, then the real thing
> tm_restore {"id":"cp_...","side":"before","dry_run":true}
> tm_restore {"id":"cp_...","side":"before"}
   ... safety checkpoint: cp_... (restore it to undo this restore)

# 4. memory, independent of compaction
> co_remember {"title":"Port comes from PORT","body":"src/server.ts must read process.env.PORT","kind":"decision","importance":3}
> co_recall {"query":"PORT"}
> co_brief {"query":"PORT"}          # what would be injected under pressure
> co_status                           # pressure, layers, budget mode
```

The `tm_*` tools appear in the tool list only while the Time Machine bundle is
loaded; `co_*` likewise. Both can be disabled independently (`enabled: false` in the
plugin config) without affecting the other or the harness.

## 4. Optional configuration

See [`../docs/CONFIGURATION.md`](../docs/CONFIGURATION.md) for every key, default and
example. The two defaults that matter most:

- `time-machine.capture.workspaceSnapshotOnTurnStart` is `false`: turn-level
  snapshots hash the whole workspace, so they are opt-in.
- `context-os.inject.enabled` is `false`: injecting a brief into `agent/pre-step` is
  the one operation that could break a turn, so it must be enabled deliberately.
