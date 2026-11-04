# 01 — Cordis plugin core: how a host (node-side) DSH plugin is declared, loaded, and constrained

Research notes for DSH 0.2.1-rc.5. Source of truth: the unpacked runtime at
`C:\Users\LEGION\.dsh\harness-src\@deepseek-ai\<package>\` and installed third-party
plugins at `C:\Users\LEGION\.dsh\profiles\desktop\node_modules\<package>\` (marked
*profile* below). Every claim cites `<package>/<file>:<line>`; quoted text is the
minimal real signature. Read-only investigation — nothing was executed.

`cordis` ships readable TypeScript (`src/*.ts`) beside its build (`lib/index.js`),
so signatures cite `src`, which is what `lib` was compiled from.
`cordis/package.json` → `"name": "@deepseek-ai/cordis"`, `"version": "4.0.5"`.

---

## 1. Exact plugin declaration shape

A plugin is a **function, a class, or an object with `apply`** — nothing else:

```ts
// cordis/src/registry.ts:92-95
export type Plugin<T = any> =
  | Plugin.Function<T>
  | Plugin.Constructor<T>
  | Plugin.Object<T>
```

Shared metadata (`cordis/src/registry.ts:100-111`), each field quoted:

| field | declaration | doc comment |
|---|---|---|
| `name` | `name?: string` | "Display name used for fiber diagnostics and logger names." |
| `Config` | `Config?: StandardSchemaV1<any, T>` | "Standard-schema validator applied to config before the plugin starts." |
| `inject` | `inject?: Inject` | "Services the plugin requires; it only loads while all are available." |
| `provide` | `provide?: string \| string[]` | "Service name(s) the plugin provides (read by `Service` and by loaders)." |
| `intercept` | `intercept?: Dict<boolean>` | "Service names whose intercept config the plugin declares it consumes." |

Call shapes (`cordis/src/registry.ts:120-133`): `(ctx: Context, config: T): any` for
functions, `new (ctx: Context, config: T): any` for classes, and
`apply(ctx: Context, config: T): any` for objects.

Resolution (`cordis/src/registry.ts:222-228`): `if (typeof plugin === 'function') return plugin;
if (isApplicable(plugin)) return plugin.apply`; `isApplicable` is
`typeof object.apply === 'function'` (`:8-10`). Anything else throws
`invalid plugin, expect function or object with an "apply" method, received ` (`:319`).

**Function form, real example** — `dsh-token-diet` (*profile*), the cleanest
third-party host plugin in the profile:

```js
// dsh-token-diet/lib/index.js:30,36,39,75
export const name = 'token-diet'
export const Config = undefined
export const inject = []
export function apply(ctx, config) {
```

**Service-class form, real examples** (the default export *is* the plugin):

```js
// dsh-token-meter/lib/index.js:687-692, 876
var TokenMeter = class extends Service {
	static Config = z.object({});
	static inject = ["sessionProjections"];
	constructor(ctx, config = {}) {
		super(ctx, "tokenMeter");
export { TokenMeter, TokenMeter as default };
```

```js
// dsh-session-projection/lib/index.js:44,52,436
var SessionProjectionRegistry = class extends Service {
	constructor(ctx) {
		super(ctx, "sessionProjections");
export { SessionProjectionRegistry, SessionProjectionRegistry as default };
```

`z` there is **schemastery, not zod**: `dsh-token-meter/lib/index.js:2`
`import z from "@deepseek-ai/schemastery";` (`@deepseek-ai/schemastery` 3.18.5).
A scan of shipped `*/lib/index.js` finds 129 files importing `z from
"@deepseek-ai/schemastery"` versus 10 importing `{ z } from "zod"`.

`Service`'s constructor registers the instance immediately and ties it to the
owning fiber (`cordis/src/service.ts:42-58`):
`constructor(protected ctx: Context, name: string)`, then
`self.ctx.reflect.provide(name, self, this[symbols.check])` (`:57`); `name ??=
this.constructor['provide']` (`:43`). The doc comment at `:8-9`: "Subclasses call
`super(ctx, name)` from their constructor. The service is registered immediately
and is automatically removed with the owning fiber."

`ctx.inject` sugar compiles to an object plugin (`cordis/src/registry.ts:300-302`):
`inject(inject: Inject, callback: Plugin.Function<void>) { return this.plugin({ inject, apply: callback, name: callback.name }) }`.
`Inject` is `(keyof M)[] | { [K in keyof M]?: M[K] }` (`:19`) — a name array, or
name → intercept-config.

The canonical README form is an ordinary function with attached metadata
(`cordis/README.md:45-55`): `const greeter = Object.assign((ctx: Context) => {
ctx.on('app/ready', ...) }, { inject: ['counter'] })`, then `await root.plugin(Counter)`.

**`reusable` / `fork`: NOT FOUND** anywhere in `cordis/src` (searched all eight
modules). One plugin callback gets one `Fiber` per `ctx.plugin()` call —
`fibers: DisposableList<Fiber>` ("Every live fiber of this plugin (one per
`ctx.plugin()` call)", `registry.ts:139-140`) — and isolation is expressed with
`ctx.isolate(name, label)` (`context.ts:121-125`) instead.

---

## 2. `ctx` API surface

`ctx` is a proxy over services; methods are mixed in by their owning service
(`cordis/src/reflect.ts:219-222`): reflect → `get,set,provide,accessor,mixin`;
fiber → `runtime,effect`; registry → `inject,plugin`; events →
`on,once,parallel,emit,serial,bail,waterfall`. Therefore `ctx.effect` **is**
`Fiber.effect` and `ctx.on` **is** `EventsService.on`.

| API | exact signature | source |
|---|---|---|
| `ctx.plugin` | `plugin<P extends Plugin>(plugin: P, ...args: Spread<GetPluginConfig<P>>): Fiber & PromiseLike<Fiber>` | `cordis/src/registry.ts:185` |
| `ctx.inject` | `inject(inject: Inject, callback: Plugin.Function<void>)` (returns the fiber) | `cordis/src/registry.ts:300` |
| `ctx.effect` | `effect(execute: () => Effect, label?: string): AsyncDisposable<Promise<void>>` | `cordis/src/fiber.ts:415-417` |
| `ctx.on` | `on<K extends keyof Events>(name: K, listener: Events[K], options?: boolean \| EventOptions): () => boolean` | `cordis/src/events.ts:97` |
| `ctx.once` | same, "the listener disposes itself after its first call" | `cordis/src/events.ts:106` |
| `ctx.emit` | `emit<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): void` | `cordis/src/events.ts:53` |
| `ctx.parallel` | `...: Promise<void>` ("resolving once every listener has settled") | `cordis/src/events.ts:44` |
| `ctx.serial` | `Promisify<ReturnType<Events[K]>>` (await in order until one bails) | `cordis/src/events.ts:63` |
| `ctx.bail` | `bail<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>` | `cordis/src/events.ts:73` |
| `ctx.waterfall` | last argument is `next`; "not calling it vetoes" | `cordis/src/events.ts:86` |
| `ctx.get` | `get<K>(name: K, strict?: boolean): undefined \| this[K]` | `cordis/src/reflect.ts:17` |
| `ctx.set` | `set<K>(name: K, value: undefined \| this[K]): void` | `cordis/src/reflect.ts:29` |
| `ctx.provide` | `provide(name: string, value?: any, check?: () => boolean)` | `cordis/src/reflect.ts:277` |
| `ctx.accessor` / `ctx.mixin` | `accessor(name: string, options)` / `mixin(...)` | `cordis/src/reflect.ts:56,67` |

Listener options are exactly `{ prepend?: boolean; global?: boolean }`
(`cordis/src/events.ts:112-117`). Bail only stops on a value that is not
`null`, `false`, or `undefined` — `isBailed` (`events.ts:13-15`).

`ctx.logger` is a callable `LoggerService` (`cordis/src/context.ts:28`), used as
`ctx.logger.info('%s #%d', ...)`; formatters `%s %d %o %c %C`
(`cordis/src/logger.ts:50-61`), ring buffer `bufferSize = 1000` (`:195`), and each
fiber gets `new Logger({ name, level: config.level, meta: { fiber: new WeakRef(fiber) } })`
(`:257-261`).

`ctx.timer` is **not** in core: it is `cordis-plugin-timer`
(`cordis/README.md:87`: "Disposal-aware timeout, interval, throttle, and debounce
helpers"), whose instance registers `super(ctx, "timer");`
(`cordis-plugin-timer/lib/index.js:6`) and whose every helper allocates through
`this.ctx.effect(...)` (`:28,38,51,58,119`).

`ctx.router`: **NOT FOUND** in `cordis/src` (no router service in core).

Also on the context: `ctx.root` (`context.ts:22`), `ctx.baseUrl?` (`:24`),
`ctx.fiber` (`fiber.ts:10-13`), `ctx.extend(meta)` (`:99`), `ctx.isolate(name,
label)` (`:121`), `ctx.intercept(name, config)` (`:139-145`).

---

## 3. Lifecycle: gating, readiness, disposal, reload

**States** (`cordis/src/fiber.ts:147-154`), with the doc comment at `:142-145`:

```ts
export const enum FiberState { PENDING, LOADING, ACTIVE, FAILED, DISPOSED, UNLOADING }
```

`PENDING` is "waiting for required services", `LOADING` "the plugin callback is
running", `ACTIVE` "loaded and providing", `FAILED` "the callback or its config
threw", `UNLOADING` "disposers are running", `DISPOSED` "the fiber was removed and
cannot restart" (`:142-145`).

**Inject gating is an epoch string.** `_refresh()` walks the injected names and
concatenates the *fiber uid* of each resolved impl (`fiber.ts:611-623`):

```ts
// cordis/src/fiber.ts:614-622
for (const name of Object.keys(this.inject)) {
  const impl = this._store[name]
  if (!impl) { epoch = INACTIVE; break }
  epoch += ':' + impl.fiber.uid
}
this._setEpoch(epoch)
```

`_setEpoch` (`:625-639`) ignores an unchanged epoch; crossing **INACTIVE → active**
runs `_reload()` and reports `LOADING`, any other change runs `_unload()` and
reports `UNLOADING` (`:631-637`). A service re-registration by another fiber
therefore changes the uid and forces a full unload + reload of every dependent.

**Readiness.** Cordis core has no `ready` event (the `'app/ready'` in the README
example is a user event, `cordis/README.md:29,57`; a grep for `'app/ready'` across
all shipped `*.js` returns no producer/consumer in DSH). What exists instead:
`async await()` waits out `inertia` and rethrows the startup error
(`fiber.ts:704-710`), and the Loader exposes an `await` intercept —
`Loader.Intercept { await?: boolean }` "Keep dependent plugins pending while
loader entries are still loading." (`cordis-plugin-loader/src/index.ts:66-69`),
enforced by `[Service.check]()` returning false while `this.getTasks().length`
(`:175-179`). That is why DSH rows carry `inject: [webStartup]`,
`sdkAppStartup, loader`, `acpAppStartup` (`dsh-web-app/cordis.patch.yml:181`,
`dsh-sdk-app/cordis.patch.yml:19`, `dsh-acp-app/cordis.patch.yml:17`).

**Disposal.** `_unload()` clears the disposer list and awaits all of them
**concurrently**, logging each failure (`fiber.ts:675-686`):

```ts
await Promise.all(this._disposables.clear().map(async (dispose) => { ... }))
```

**How cleanup must be written.** The contract is on `effect` itself
(`fiber.ts:405-409`): "`execute` runs immediately; the disposers it produces are
collected and run (in reverse order) either when the returned disposer is called
or when the fiber unloads … Calling the disposer twice is a no-op. Throws
`CordisError('INACTIVE_EFFECT')` if the fiber is already disposed, and `TypeError`
if `execute` returns an invalid shape." Accepted effect results are Disposable,
`Iterable<Disposable>`, `Promise<Disposable>`, or `AsyncIterable<Disposable>`
(`fiber.ts:83-93`); `INACTIVE_EFFECT`'s message is "cannot create effect on
inactive context" (`fiber.ts:172`).

Real, effect-scoped registration: `dsh-session-projection/lib/index.js:82-101`
wraps its registry mutation in `return this.ctx.effect(function* () { ... yield ()
=> { ... refs -= 1 ... } }, "sessionProjections.register()")`, so unloading the
calling fiber unregisters the projection.

**Config errors** are `ValidationError extends TypeError` with `name =
'ValidationError'` and message `invalid config:\n` + `  - ${issue.message} (at
${issue.path.join('.')})` (`fiber.ts:19-35`); validation uses
`runtime.Config['~standard'].validate(config)` and rejects async validators with
`TypeError('Async config validation is not supported')` (`fiber.ts:50-56`).

**Update / restart.** `update(config, noSave = false)` runs the `internal/update`
waterfall and then `restart()` (`fiber.ts:736-753`); `restart()` is
`this.assertActive(); this._setEpoch(INACTIVE); this._refresh(); await this.await()`
(`:718-723`). Loader reuses exactly this for a config change:
`this.fiber.update(this.options.config, true)` (`cordis-plugin-loader/src/config/entry.ts:105-107`).

**Reload / HMR.** Core has no HMR; DSH adds `dsh-hmr`, which registers itself as
service `hmr` (`super(ctx, "hmr");`, `dsh-hmr/lib/index.js:783`) and declares
`[Inject("loader"), Inject("timer")]` (`:676`). It re-imports a module through the
Loader (`const moduleNamespace = await this.ctx.loader.import(generation.filename,
this.getOuterStack);`, `:1075`) and, per its README, "Affected runtimes stop
without making their entries disabled, and `reconcileProfile()` passes them to
app-boot's single `recomposeProfile()` call, which starts them, including those
below an unchanged Include" (`dsh-hmr/README.md:69`); volatile-only config changes
commit without restart (`cordis-plugin-loader/src/config/entry.ts:146-150`).
Replacing an installed package therefore needs a restart to load a fresh module
generation (`dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md:70`).

---

## 4. Service registry

`provide` is effect-scoped and refuses duplicates (`cordis/src/reflect.ts:277-305`):
it allocates an isolation symbol, stores `{ name, value, fiber, check }`, throws
`service "${name}" has been registered at <${this.store[key].fiber.name}>` (`:290`),
and its disposer deletes the entry and calls `this.notify([name])` (`:295`).

`set` is owner-only — `cannot set property "${name}" without provide` (`:258`) and
`cannot set property "${name}" in multiple fibers` (`:261`).

Reads go through the context proxy, so an **undeclared** read fails:
`cannot get property "${prop}" without inject` (`:144`) or `cannot get required
service "${prop}" in inactive context` (`:160`). Consume a service by declaring
it in `inject`/`config.inject`, or deliberately with `ctx.get('name')`.
`notify(names)` re-evaluates every fiber whose `inject` names a changed service in
the same isolation label (`:314-336`).

Real provider line, quoting a custom availability predicate
(`cordis-plugin-loader/src/index.ts:102`):
`ctx.reflect.provide('loader', this, this[Service.check])`.

| service name | provider | consumed as |
|---|---|---|
| `sessionProjections` | `dsh-session-projection/lib/index.js:52` | `static inject = ["sessionProjections"]` (`dsh-token-meter/lib/index.js:689`), then `ctx.sessionProjections.register(...)` (`:694-696`) |
| `tokenMeter` | `dsh-token-meter/lib/index.js:692` | `inject: ['tokenMeter']` |
| `settings` | `dsh-settings/lib/index.js:330` (`static inject = ["configEditor", "profileContext"]`, `:324`) | `ownerContext.inject(["settings"], (child) => …)` (`dsh-agent-default-model/lib/index.js:30`) |
| `tools` | `dsh-tools/lib/index.js:2798` (`super(ctx, "tools")`) | `export const inject = ['tools']` (`…/references/host-plugin.md:61`) |
| `webServer` | `dsh-host-webserver/lib/index.js:286` | `inject: ['webServer']` — "Web route-registration plugin: HTTP and upgrade routes, index transform taps, and static dist fallback" (`…/cordis-composition-reference/references/packages.md:275`) |
| `sessions` | `dsh-session/lib/index.js:1739` | `inject: ['sessions']` |
| `sessionPersistence` | `dsh-session-persistence/lib/index.js:265` | `ctx.inject(["sessionPersistence"], (childCtx) => …)` (`dsh-agent-loop/lib/index.js:1612`) |
| `storage` | `dsh-storage/lib/index.js:109` | `ctx.storage`; backends/forms mount via `mount(form, facility)` (`:118`) |
| `loader` | `cordis-plugin-loader/src/index.ts:84,102` (`public name = 'loader'`) | `ctx.root.loader.await()` (`dsh-settings/lib/index.js:339`) |
| `hmr` | `dsh-hmr/lib/index.js:783` | — |
| `timer` | `cordis-plugin-timer/lib/index.js:6` | `ctx.timer` |

`sessionStore`: **NOT FOUND** as a service name in the runtime; the session-side
services are `sessions` and `sessionPersistence` above.

Optional dependencies are the standard idiom for staying inactive rather than
throwing: "Put optional services in `inject` or `ctx.inject([...], ...)` so the
plugin stays inactive in profiles without them instead of throwing."
(`…/references/practices.md:20`). Inline form, real use:
`ctx.inject(["typert"], (typeCtx) => {` (`dsh-agent/lib/index.js:333`).

---

## 5. Config: schema and where it comes from

`Config` must satisfy `StandardSchemaV1` (`registry.ts:104`) and is validated
through `'~standard'` (`fiber.ts:53`). DSH's own packages use
`@deepseek-ai/schemastery` (`schemastery/package.json` → `"version": "3.18.5"`),
whose default export is the schema class — `export default Schema`
(`schemastery/src/index.ts:962`) — and which implements `'~standard'`
(`:154,290`).

Schemastery syntax (`schemastery/README.md`):

```js
// :42-45
const Config = Schema.object({
  foo: Schema.dict(Schema.string()).default({}),
  bar: Schema.array(Schema.string()).default([]),
})
```

- `Schema.object(dict)` — "Assert that the value is an object whose each property
  is of corresponding subtype. The default value will be `{}` if not specified."
  (`:179-181`)
- `schema.required()` — "Assert that the value is not nullable." (`:243-245`)
- `schema.default(value)` — "Set the fallback value when nullable." (`:247-249`)
- `schema.description(text)` — "Set the description of the schema." (`:251-253`)
- "Note: `default` and `required` are mutually exclusive." (`:241`)
- `schema.simplify(value)` — "Normalize a value by removing parts that are equal to
  schema defaults." (`:255-258`); the Loader uses it to persist compact config:
  `const unparse = this.runtime?.Config?.['simplify']`
  (`cordis-plugin-loader/src/index.ts:117-118`).

Zero-argument service Config, real: `static Config = z.object({});`
(`dsh-token-meter/lib/index.js:688`) — with `z` from `@deepseek-ai/schemastery`.

**In `cordis.patch.yml`, config is the row's `config:` key.** `EntryOptions`
(`cordis-plugin-loader/src/config/entry.ts:10-23`) is exactly `{ id: string; name:
string; config?: any; group?: boolean | null; disabled?: boolean | null; inject?:
Inject | null }`, documented as "Config passed to the plugin". Real rows:

```yaml
# dsh-base/cordis.patch.yml:15-26 (rows under one insert)
- insert:
    - id: tool-plugin-manager
      name: '@deepseek-ai/dsh-plugin-manager/tools'
      disabled: true
    - id: timer
      name: '@deepseek-ai/cordis-plugin-timer'
```

```yaml
# dsh-genui/cordis.patch.yml:3-9 (profile)
- insert:
    - id: genui
      name: dsh-genui
      config:
        sectionOrder: 80
        sectionName: genui:cards
```

A matching override "replaces the complete `config`" (`…/references/host-plugin.md:3`);
`dsh-base/cordis.patch.yml:6-7` says the same: "A patch replaces the targeted
row's whole `config` rather than merging into it".

**`!!js`** is a real YAML tag, registered in app-boot:

```js
// dsh-app-boot/lib/index.js:20-26
const JsExpr = new yaml.Type("tag:yaml.org,2002:js", {
	kind: "scalar",
	resolve: (data) => typeof data === "string",
	construct: (data) => ({ __jsExpr: data }),
	...
const entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr)   // :33
```

Evaluation is dynamic, with the context as the scope
(`cordis-plugin-loader/src/config/utils.ts:5-9`):

```ts
export const evaluate = new Function('ctx', 'expr', `
  with (ctx) {
    return eval(expr)
  }
`)
```

and it is applied recursively to every node of a plugin's config
(`interpolate`, `utils.ts:12-22`) on the Loader's `internal/config` waterfall
(`cordis-plugin-loader/src/index.ts:104-113`), except for tree carriers
(`Group`, `Include`) whose nested rows own their expressions (`:107-109`).
`disabled` may also be an expression: `isJsExpr(options.disabled) ?
Boolean(this.evaluate(options.disabled.__jsExpr)) : Boolean(options.disabled)`
(`entry.ts:91-95`). Semantics: "`!!js` scalars are Loader expressions, never
`!js`. Inside `config` they are evaluated after the row's declared injections
activate, against that plugin's context (`ctx.<service>`), so `!!js
dshHomePath('sessions')` and `!!js "!ctx.get('profileContext')"` are valid. Other
row metadata stays literal." (`…/cordis-composition-reference/SKILL.md:22`).
Real use: `disabled: !!js "!ctx.get('profileContext')"` (`dsh-base/cordis.patch.yml:22,30`).

---

## 6. Packaging: what DSH reads from an installed plugin package

Minimal Host-only bundle manifest (`…/references/host-plugin.md:9-17`):

```json
{
  "name": "@local/my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

| field | read by | evidence |
|---|---|---|
| `dsh.bundle.patch` | app-boot bundle resolver | `"dsh.bundle.patch must be a file path or a list of file paths"` (`dsh-app-boot/lib/index.js:519`); resolved to absolute paths in order, `function bundlePatchPaths(packageDir, bundle) { return bundlePatchFiles(bundle).map((file) => join(packageDir, file)); }` (`:529-531`) |
| `dsh.client` | client module graph | validator `parseDshClient(pkgName, value)` (`dsh-client-modules/lib/client.js:61-75`): required `platform` string; optional `inject`/`external` string arrays; optional `immediately` boolean — anything else throws `client-modules: … dsh.client.<field> must be …` |
| `engines.dsh` | compatibility preflight | `const range = engines.dsh;` … `return satisfies(runtimeVersion, range) ? {} : { "engines.dsh": range }` (`dsh-app-boot/lib/index.js:281-284`) |
| `peerDependencies` (`@deepseek-ai/dsh*`) | fallback when `engines.dsh` absent | `unmetRequirements` (`app-boot:286-298`); `workspace:^/~/*` are rewritten to the current runtime |
| `exports` | module resolution | required subpaths in real bundles: `"."`, `"./client"`, `"./icon"`, `"./locale/*.json"`, `"./package.json"` (`dsh-token-diet/package.json:8-14`) |
| `files` | packaging only | must keep patch, locales, icon, runtime files (`…/host-plugin.md:35`) |

Compatibility is evaluated without importing plugin code (`app-boot:252`
comment: "Evaluate plugin dsh requirements (`engines.dsh`, else dsh peers)
without importing plugin code"):

```js
// dsh-app-boot/lib/index.js:311-315
function evaluatePluginCompatibility(manifest, exemptions = {}, runtimeVersion = getDshRuntimeVersion()) {
	const requirements = unmetRequirements(fields, runtimeVersion);
	if (Object.keys(requirements).length === 0) return void 0;
```

The failure text is `Plugin ${key} is incompatible with dsh ${runtimeVersion}:
requirements …` (`app-boot:335`), and install rejects with exit code 1:
`const issue = evaluatePluginCompatibility(manifest, exemptions); if (issue !==
undefined && !issue.exempted) { preflight.push(pluginCompatibilityWarning(issue));
incompatible.push(incompatiblePlugin(issue)) }`
(`dsh-plugin-manager/lib/types/operations.js:362-364`), diagnostic
`\ndsh: installation rejected: ${warnings.join('\n')}…` (`:339`). Exemptions are
profile-local, in `compatibility.json` ("Independent profile metadata; neither
package manifests nor Cordis patches carry grants", `app-boot:340-341`).

`dsh.compatibility.dshReleases` and `dsh.manifestVersion` are **not read by the
runtime**: a recursive search for the literals `dshReleases` and
`manifestVersion` over every shipped `*.js` returns no match. Third-party packages
still ship them, e.g. `dsh-pet/package.json` maps releases to
`"compatible"/"incompatible"` and `dsh-token-diet/package.json:43` declares
`"manifestVersion": 1`; they are marketplace metadata, not an enforcement path
(see Open questions).

**Patch row shape.** A row has `id`, `name` (the plugin package specifier;
inserted relative paths are anchored beside their patch file), optional `config`,
and optional `disabled`, `inject`, `intercept`, and `isolate`
(`…/cordis-composition-reference/SKILL.md:18`). Insert form:

```yaml
# …/references/host-plugin.md:22-27
- insert:
    - id: my-plugin
      name: '@local/my-plugin'
      config: {}
```

`inject` on a row, real: `inject: [webStartup]` (`dsh-web-app/cordis.patch.yml:181,199,236`),
`inject: [sdkAppStartup, loader]` (`dsh-sdk-app/cordis.patch.yml:19`),
`inject: [acpAppStartup]` (`dsh-acp-app/cordis.patch.yml:17`),
`inject: [headlessStartup]` (`dsh-headless/cordis.patch.yml:26`).

Patch semantics (`…/cordis-composition-reference/SKILL.md:14-16`): `insert`
appends rows (naming an existing `group: true` row appends inside its `config`
list); "A patch with an `id` and no `insert` targets the existing row with that
id. Supplied fields replace the row's fields; `config` is replaced wholesale,
never deep-merged"; "Non-insert patches without a nonempty `id`, and targets that
match no row, are warned about and skipped." app-boot's implementation comment
(`app-boot:47-59`) repeats that a non-matching patch "warns and is skipped", and
`dsh-base/cordis.patch.yml:12-13` states "Row order carries no load semantics
(activation is service-availability driven)".

---

## 7. What a plugin cannot do through these interfaces

- **No in-process Electron.** A plugin is only ever called as
  `(ctx: Context, config: T)` (`registry.ts:121-133`); nothing in `ctx` exposes
  Electron. No shipped package imports it: a recursive search for
  `from "electron"` / `require("electron")` over all `*.js`/`*.ts` under
  `harness-src` returns no match, and `electron` is not installed in the profile
  (`Test-Path …\node_modules\electron` → `False`). `dsh-pet` instead downloads an
  Electron runtime (`@electron/get@5.1.0`, `dsh-pet/package.json:40,99`) to run a
  *separate* standalone app whose `bin.dsh-pet-standalone` "runs the plugin's host
  half on a fake ctx" (`:38`) — evidence that the host half needs only a `ctx`.
- **No database handle through `ctx`.** The sanctioned seams are services:
  storage mounts under `ctx.storage` via `mount(form, facility)`
  (`dsh-storage/lib/index.js:118`), sessions/projections via
  `ctx.sessions`/`ctx.sessionProjections`. Session data must not be invented:
  "Do not append session events with a new `type`… Derive state from existing
  events, or keep plugin-owned data in a storage service found through
  inspection." (`…/references/practices.md:21`).
- **But there is no sandbox.** Plugin modules are ordinary ESM imported by the
  Loader, so Node builtins are reachable — `dsh-token-diet` writes its own files
  with `import { mkdir, readFile, rename, unlink, writeFile } from
  'node:fs/promises'` (`dsh-token-diet/lib/host/budget.js:17`, writes at `:97`).
  "No raw DB writes" is therefore a **convention enforced by service ownership
  and review**, not a capability restriction; the only hard limit is that a
  service's state can only be mutated by its declaring fiber (`reflect.ts:258,261`).
- **No host client packages at runtime.** "Do not `require('@deepseek-ai/dsh-client-ui-primitives')`
  or load any other Harness Client package as a module; `dsh.client.inject`
  entries only order activation"; UI is contributed through slots
  (`…/references/practices.md:35`, `references/ui-plugin.md:13`).
- **No undeclared service reads.** Accessing a service not named in `inject`
  throws `cannot get property "…" without inject` (`reflect.ts:144`), and a
  service registered twice throws `service "…" has been registered at <…>`
  (`reflect.ts:290`).
- **No extra plugin lifecycle in core.** `reusable`, `fork`, `ctx.router`, and a
  framework `ready` event are **NOT FOUND** in `cordis/src`; don't design against
  them.

---

## Open questions

1. Who consumes `dsh.compatibility.dshReleases`? Nothing in the shipped runtime
   does (no literal match). Likely the plugin registry/market surface outside
   `app.asar` (`dsh-client-ui-plugin-market` ships a `compatibility` code path but
   no `dshReleases` literal) — unresolved.
2. `webServer`'s route-registration method names are not quoted here; only the
   service identity (`dsh-host-webserver:286`) and its purpose
   (`packages.md:275`). Needs a follow-up read of `dsh-host-webserver/lib/index.js`.
3. `cordis-plugin-group` ships only a re-export (`src/index.ts:3`
   `export default Group`) and `cordis-plugin-include` supplies the file-backed
   tree (`include/README.md:5`); the `cordis:group` / `cordis:include` row names
   come from `…/cordis-composition-reference/SKILL.md:20`, but their builtin
   registration (`loader.builtins`) was not traced to a line.
