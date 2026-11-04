# 06 — Web-GUI UI plugins: panels, settings sections, and the browser↔host seam

Scope: DeepSeek Harness **0.2.1-rc.5**. Sources: runtime unpacked at `C:\Users\LEGION\.dsh\harness-src\@deepseek-ai\<package>\`, and shipped third-party plugins under `C:\Users\LEGION\.dsh\profiles\desktop\node_modules\`. Citations are `<package>/<file>:<line>`. Anything I could not verify is written as `NOT FOUND` rather than guessed.

Short version: a client plugin is a **Cordis plugin whose entry is `exports["./client"]`**, produced as a `window.__ModuleLoader__.load({ id, factory })` registration script. It receives a browser Cordis `ctx` and adds UI by registering **slots** (`ctx.slots.register(...)`), reads/writes host state through **`ctx.remote`**, and can expose its own HTTP route through the host half's `webServer.register(...)`.

---

## 1. `dsh.client` package field

### 1.1 Exact shape (0.2.1-rc.5)

Validator `parseDshClient(pkgName, value)` — `dsh-client-modules/lib/index.js:62-76` — accepts exactly four keys:

| key | type | required | meaning |
|---|---|---|---|
| `platform` | `string` | yes | only `"web"` is meaningful |
| `inject` | `string[]` | no | **package ids** of client modules that must arrive first (graph edges), not service names |
| `external` | `string[]` | no | extra non-baseline module requests, each answered by a dynamic row or an exact static-table key |
| `immediately` | `boolean` | no | eager activation instead of on-first-use |

There is **no `entry` field** in this version — `entry` is `NOT FOUND`. The entry point comes from the package's `exports["./client"]`.

```json
"dsh": { "client": { "platform": "web", "inject": [], "immediately": true } },
"exports": { "./client": "./lib/client.js" }
```

Real manifests:
- `dsh-context/package.json` — `inject` lists `@deepseek-ai/dsh-api-remotes`, `...dsh-client-connection`, `...dsh-client-ui-conversation`, `...dsh-client-ui-settings`, `...dsh-client-ui-sidebar-right` (plus locale); also `dsh.bundle.patch = "./cordis.patch.yml"`.
- `dsh-genui/package.json` — `inject` lists `...dsh-client-ui-chat`, `...dsh-client-ui-conversation`, `...dsh-client-ui-slots`, `...dsh-client-ui-primitives`.
- `dsh-pet/package.json` — `inject: ["@deepseek-ai/dsh-client-connection"]`.
- `billion-context/package.json` — `{ "platform": "web" }` only; `exports["./client"]` → `./dist/agent/dsh-native-client.js` (path is arbitrary).

Errors: `client-modules: ${pkgName} has a non-object dsh.client declaration`; `... dsh.client.platform must be a string`; `... dsh.client.inject must be a string array`; `... dsh.client.immediately must be a boolean` (`dsh-client-modules/lib/index.js:64-69`).

### 1.2 Discovery and serving

- `resolveMeta` (`dsh-client-modules/lib/index.js:720-750`) reads `package.json`, resolves `clientExportOf(pkgName, exportsField)` and builds `{ clientPath: join(dirname(pkgPath), clientRel), inject?, external, immediately }`.
- Missing bundle: `client-modules: ${packageName} declares dsh.client but exports no "./client" bundle` (`dsh-client-modules/lib/index.js:738`).
- `ClientModuleRegistry extends Service` (`static inject = ["loader"]` `:514`, service name `clientModules`, `super(ctx, "clientModules")` `:538`) scans Loader entries incrementally (`:545-562`) and serves bundles through the web carrier: `webCtx.effect(() => webCtx.webServer.register({ kind: "prefix", path: PLUGIN_ROUTE, handler: this.serveBundle }), "client-modules: bundle route")` (`:563-569`), mounted via `ctx.inject(["webServer"], registerWebCarrier)` (`:570`). `PLUGIN_ROUTE` is the `/plugins` prefix (`dsh-client-modules/README.md:78`).

### 1.3 Which host package puts it in the page

Three packages cooperate; the **injector is `dsh-client-modules`**:

1. `dsh-client-modules` pushes index rows on the webserver event:
   `ctx.on("webserver/index-inject", (table) => { table.push(...bootInjections(this.composed)); })` (`dsh-client-modules/lib/index.js:571-573`).
2. `bootInjections(graph)` (`:460-505`) emits, in order: an inline head script that installs a **queue facade** `window.__ModuleLoader__ = { mode:"queue", pendingQueue, load(registration){pendingQueue.push(registration)}, create(options){…} }` (`:461-482`); `script-preload` rows for `application` batches; `script-src` head rows for the `bootstrap` batch; then the boot manifest as a global:
   `{ kind: "global", name: "__DSH_BOOT__", value: graph }` (`:499-503`).
3. `dsh-host-webserver` owns `collectIndexInjections()` / `renderIndex(html)` / `tapIndex(transform)` + the `webserver/index-inject` event (`dsh-host-webserver/README.md`), and `dsh-host-frontend-static` claims the SPA fallback seat and renders every index response through it: "Every successful index response is rendered through the webserver's `renderIndex`, so the boot manifest reaches the page on `/`" (`dsh-host-frontend-static/README.md:42`). `dsh-web-app` is the composition that mounts all of this (`dsh-web-app/cordis.patch.yml:180,218,228,235`).

Bundle URLs: combo `/plugins/??<id>/client.js,…&rev=<rev>`, single `/plugins/<id>/client.js?rev=<rev>`, chunks `/plugins/<id>/client.<hash>.js?rev=<rev>` (`dsh-client-modules/lib/index.js:204-253`); combo URLs are partitioned before exceeding 3 KiB (`MAX_COMBO_URL_BYTES`, `:237-253`).

### 1.4 Bundle format — NOT plain ESM, NOT an IIFE

The loader accepts only a **factory registration script**:

```js
window.__ModuleLoader__.load({
  id: "dsh-genui",
  factory: (require) => { var module = { exports: {} }; /* body */ return module.exports }
});
```

(`dsh-client-modules/lib/client.js:1-6`). Consequence documented in the bundle itself: "executing a plugin bundle only REGISTERS its factory … every module body side effect — including CSS injection — lives inside the factory closure and runs at materialization" (`dsh-client-modules/lib/client.js:16-23`). Resolution order is "seed word → shell instance; memoized record → exports; graph row …; registered factory → materialize; anything else → throw" (`:25-31`).

So: **no build tool is required by the Host** (it only reads the file named by `exports["./client"]` and checks the registration happened — `loaded without registering "${id}" via __ModuleLoader__.load`, `:758,874`). In practice every shipped plugin is built with the shared Client tsdown preset; the failure text you will see if you forget is `client-modules: client bundle not found; run \`pnpm run build\` before launch:` (`dsh-client-modules/lib/index.js:128-160`). `dsh-api-remotes/README.md:62` documents the build split (`clientBundle(..., { hostPhase: true })`).

---

## 2. Client entry contract and extension points

### 2.1 What the entry module exports

Plain object, Cordis-shaped, no default export wrapper:

```js
exports.inject = ["slots", "locale"];   // client service names, awaited before apply
exports.apply = apply;                   // function apply(ctx) — browser Cordis root ctx
// exports.name is optional
```

Precise examples:

`dsh-client-ui-settings-plugins/lib/client.js:162,167,215-216`
```js
const inject = ["slots", "locale"];
function apply(ctx) { … }
exports.apply = apply;
exports.inject = inject;
```

`dsh-genui/lib/client.js:616-633`
```js
const inject = ["slots"];
function apply(ctx) {
  prefetchGenuiRuntime();
  ctx.slots.inject("conversation.input.left", () => ctx.slots.register(
    { name: "conversation.input.left", id: "genui-prompt-toggle", order: 0 }, PromptToggleButton));
  ctx.slots.inject("conversation.chat.node", () => ctx.slots.register(
    { name: "conversation.chat.node", key: "assistant-step", priority: -1, locale: "chat" }, GenuiAssistantNodeView));
}
```

A second, richer example — `dsh-context` (single-line minified bundle, `dsh-context/lib/client.js:1`; also has `exports.name`):
```js
const inject = ["slots", "locale"];
function apply(ctx) { … }               // exports: { name: "dsh-context", inject, apply }
ctx.slots.inject("conversation.view", () => ctx.slots.register(
  { name: "conversation.view", id, order: 20, locale: "dsh-context", label: () => t("tab.context") }, View));
ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: PID, locale: NS }, InsightsPage));
ctx.slots.inject("sidebar.panellist", () => ctx.slots.register(
  { name: "sidebar.panellist", id: PID, order: 20, label: () => t("ov.title"), locale: NS }, Icon));
ctx.slots.inject("conversation.chat.assistant-actions", () => ctx.slots.register(
  { name: "conversation.chat.assistant-actions", id: "context-jump", order: 20, locale: "dsh-context" }, Jump));
ctx.slots.inject("conversation.input.overlay", () => ctx.slots.register(
  { name: "conversation.input.overlay", id: "context-modal", order: 10, locale: "dsh-context",
    inject: () => ({ hooks: { contextModal }, warm: true }) }, Modal));
```

Frequently injected services (observed): `slots`, `locale`, `layout`, `reflect`, `configForms`, `sessions`, `uiSession`, `uiConversation`, `connection`, `remote`, `remote.commands`, `commandUi` (`dsh-pet/lib/client.js:5709-5716`, `dsh-client-ui-trajectory/lib/client.js:8162-8167`, `dsh-client-ui-settings-plugins/lib/client.js:162`). Client plugins may also `ctx.provide("<name>", api)` to publish their own service (`dsh-pet/lib/client.js`, `ctx.provide("petApi7340", …)`).

### 2.2 Slot registration API

```ts
ctx.slots.inject(name, () => ctx.slots.register(options, Component))   // effect-scoped: unload removes it
options = {
  name: string,            // slot name, must match the injected name
  id?: string,             // list-kind identity
  key?: string,            // keyed-kind identity (e.g. "assistant-step", panel id)
  order?: number, priority?: number,
  label?: () => string,    // nav/tab label, locale-aware
  locale?: string,         // namespace for label resolution
  inject?: () => unknown,  // props injected into Component
  store?: unknown,
  children?: Record<string, { kind: "list" | "keyed", scope: "root" }>  // declares sub-slots the component may host
}
```

(`dsh-client-ui-settings-plugins/lib/client.js:201-212`, `dsh-client-ui-plugin-manager/lib/client.js:4417-4461`, `dsh-genui/lib/client.js:628-633`, `dsh-client-ui-trajectory/lib/client.js:8205-8212`.)

Read face inside components: `ctx.slots.getVersion(name)`, `ctx.slots.entries(name)` → `{ options: { id?, order?, label? } }[]`, `ctx.slots.subscribe(name, listener)` (`dsh-client-ui-settings-plugins/lib/client.js:176-199`); helpers `renderSlot(name, props, { only })` and `useTabs(selector)` (`:37-44,68,124`).

### 2.3 Extension points (names as declared by the shipped UI packages)

| Point | Kind | Where declared | Use |
|---|---|---|---|
| `main` | keyed | `dsh-client-ui-layout/README.md:32` | full-page global panel; `key` = panel id; selecting an id without a live registration throws |
| `sidebar.panellist` | list | `dsh-client-ui-sidebar/README.md:38` | sidebar icon row; `id` must equal the `main` `key` |
| `sidebar.panellist.actions` | list | `dsh-client-ui-sidebar/README.md:40` | "More" menu rows (`entries`, `onOpen`, `onPinnedChange`, `onDismiss`) |
| `sidebar.settings` | single seat | `dsh-client-ui-sidebar/README.md:30,46` | bottom Settings seat (occupied by `ui-settings-general`) |
| `shell.overlay` | list | `dsh-client-ui-plugin-manager/lib/client.js:4402-4410` | toasts, modals (`id`-keyed rows) |
| `conversation.view` | list | `dsh-client-ui-trajectory/lib/client.js:8205` | tab next to chat (Trajectory, Context) |
| `conversation.chat.node` | keyed | `dsh-genui/lib/client.js:628` | **custom renderer** for an assistant step (`key`, `priority`) |
| `conversation.chat.assistant-actions` | list | `dsh-context/lib/client.js:1` | message action-bar button |
| `conversation.input.left` | list | `dsh-genui/lib/client.js:623` | composer leading button |
| `conversation.input.overlay` | list | `dsh-context/lib/client.js:1` | overlay above the composer |
| `settings.section` | list | `dsh-client-ui-settings/README.md:44` | top-level Settings page |
| `settings.plugins.tab` | list | `dsh-client-ui-settings/README.md:44` | tab inside Settings → Plugins |
| `plugins.bundle.config` | keyed | `dsh-client-ui-plugin-manager/lib/client.js:4440-4443` | per-plugin config card on the Plugins page |
| `settings.onboarding` | list | `dsh-client-ui-settings/README.md:44` | onboarding step |

---

## 3. Host ↔ client transport

Four channels exist; pick by data direction and lifetime.

### (a) Typed Remote RPC — `ctx.remote` (call host methods, receive forwarded events)

Client face: `ctx.remote.$mount(contribution)`, `ctx.remote.<namespace>.<method>(...)`, `ctx.remote.$on(event, handler)`.

```js
// dsh-api-remotes/lib/types/client/index.js:29-48
export const inject = ['remote'];
export async function apply(ctx) {
  disposers.push(await ctx.remote.$mount(contribution));   // one per capability
}
```

Real call from a third-party plugin — `dsh-pet/lib/client.js:5745`:
```js
await ctx.remote?.commands?.execute(session.sessionId, "/pet " + option.id, []);
```

Real host→client push — `dsh-client-ui-plugin-manager/lib/client.js:4391-4394`:
```js
ctx.remote.$on("plugin-manager/install-state", (progress) => controller.installProgress(progress));
ctx.on("connection/reset", refresh)
```

Constraints: `API_REMOTE_FORWARDED_EVENTS` is "the legal key set of `ctx.remote.$on`"; events must be allowlisted and access-controlled (`dsh-api-remotes/README.md:43-49`). "The capability set is fixed by explicit build-time value imports; the Client does not discover the Host's active Services or Remote definitions at runtime" (`dsh-api-remotes/README.md:77`). Notifications are best-effort and not replayed (`:79`). Physical transport is owned by the API Gateway (`POST` for unary, `/api/remote.mux` WebSocket for streams); `dsh-api-remotes` owns none of it (`:36`; `dsh-client-connection/README.md:34`).

### (b) Plugin-owned HTTP route — `webServer.register` + `fetch` (works for any plugin, no build-time allowlist)

Host (`dsh-genui/lib/index.js:6391-6405`):
```js
ctx.effect(() => webServer.register({
  kind: "exact",
  path: GENUI_PROMPT_CONTROL_URL,          // "/api/dsh-genui/prompt"
  handler: createGenuiPromptControlHandler(endpointControl)
}), "dsh-genui: prompt toggle state endpoint");
```
Browser (`dsh-genui/lib/client.js`, same-origin): `await fetch("/api/dsh-genui/prompt", { … })`.

`register(route)` returns a disposer and throws on duplicate path; `registerFallback` has a single seat (`dsh-host-webserver/README.md`). This is the cheapest channel for a self-contained panel and needs no `dsh.client.external`.

### (c) Session projections — host-computed data attached to session rows

`dsh-context` declares projections on the host (`dsh-context/lib/index.d.ts:107-118`):
```ts
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap { contextTimeline; contextHeaders; contextActivity }
}
```
and reads them in the browser as `row.projections` / `projectionValues` (`dsh-context/lib/client.js:1`, `projections` read sites). Use when data must ride the session lifecycle instead of a request/response.

### (d) Connection lifecycle — `ctx.connection`

`ctx.connection` exposes generic RPC, generation state, `reconnect()`, and emits `connection/reset` (`dsh-client-connection/README.md:12,62`). Auth is a launch-token→cookie exchange; RPC answers 401 before dispatch (`:41`). Plugins mostly subscribe to `connection/reset` rather than touch the socket.

---

## 4. React / component model and styles

- **React 18**, resolved from the shell's frozen seed table — never bundled by the plugin. External bundles literally call `require("react")`, `require("react-dom")`, `require("react/jsx-runtime")`, `require("@deepseek-ai/dsh-client-ui-primitives")` (`dsh-genui/lib/client.js`, top of module). `dsh-pet/package.json` pins `react`/`react-dom` as **peerDependencies**, `^18.2.0`.
- **Plugins may import `@deepseek-ai/dsh-client-ui-primitives`** — it is a seed word, not a graph row. `dsh-client-modules/README.md:50`: "The shell seeds a frozen module table (`PLATFORM_MODULES`); every dynamic bundle resolves its externals against exactly that baseline." `dsh.client.external` is only for non-baseline requests (`:34,50`); composition rejects malformed requests, missing suppliers, self-requests and cycles (`:50`). `dsh-client-ui-slots` is the same kind of package (both appear as dev/peer deps, e.g. `dsh-web-frontend/package.json:33-34`, but neither exists as an on-disk package in `harness-src` — they are baked into the built shell).
- **Styles**: each plugin ships CSS in its own bundle and self-injects a deduped `<style>` tag:
  ```js
  const tagId = "<pkg>/<File>.module.css";
  document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null
    && (tag.dataset.plugin = "<pkg>", tag.dataset.pluginCss = tagId, tag.textContent = css, document.head.appendChild(tag));
  ```
  (`dsh-client-ui-settings-plugins/lib/client.js:11-19`; same shape in `dsh-context`.) Class names are hashed with a per-package prefix (`XAL7Ya_section`, `lc-card`), the build preset rewrites CSS modules into `\0dsh-css:module:…` regions (visible in `dsh-genui/lib/client.js`), and the loader claims/removes those tags per module: `claimStyles(id, before)` sets `data-plugin=<id>`, `removeOwnedStyles(id)` clears them (`dsh-client-modules/lib/client.js:618-631`). Theme via CSS variables (`--dsw-alias-*`), not by importing a stylesheet.
- Theming/locale are services, not globals: `ctx.locale.register(NS, {zh, en})` + `ctx.locale.bind(NS)` inside `ctx.effect(...)` (`dsh-client-ui-settings-plugins/lib/client.js:169-175`).

---

## 5. Settings sections — how a plugin registers one

Three distinct seats (`dsh-client-ui-settings/README.md:44`):

1. **Top-level page** — `settings.section` (list). Shipped example, the whole Plugins section (`dsh-client-ui-settings-plugins/lib/client.js:201-212`):
   ```js
   ctx.slots.inject("settings.section", () => ctx.slots.register({
     name: "settings.section", id: "plugins", order: 15, label: () => t("nav"), locale: NS,
     inject: sectionInjected,
     children: { "settings.plugins.tab": { kind: "list", scope: "root" } }
   }, PluginsSettingsSection));
   ```
2. **Tab inside Settings → Plugins** — `settings.plugins.tab` with `{ id, order, label }`; "the section renders the entries in order and mounts a tab on its first selection" (`dsh-client-ui-settings-plugins/README.md:30`).
3. **Config card for your own plugin, on the Plugins page** — `plugins.bundle.config`, declared keyed by `dsh-client-ui-plugin-manager` (`lib/client.js:4440-4443`) and registered keyed by your namespace while the host half serves config forms:
   ```js
   ctx.inject(["configForms"], (c) => {
     c.effect(() => c.configForms.whileServed(["dsh-context"], () =>
       c.slots.inject("plugins.bundle.config", () => c.slots.register(
         { name: "plugins.bundle.config", key: "dsh-context", locale: NS, inject: d }, Card))));
   });
   ```
   (`dsh-context/lib/client.js:1`.) `ctx.configForms.get(entryId)` gives `{ value, base, user, revision, writable }` with `set`/`unset`/`mutate`; `whileServed(namespaces, register)` runs only while the host serves one of those namespaces (`dsh-client-ui-settings/README.md:34,40`). `ctx.settingsSchema` rehydrates/validates schemas (`:72`).

**Correction to the task premise:** `sectionOrder` / `sectionName` are **not** settings config. They are the host-side system-prompt section config of `dsh-genui`:
`dsh-genui/lib/index.js:6315-6321` — `const Config = z.object({ sectionOrder: z.number().default(80), sectionName: z.string().default("genui:cards"), promptEnabled: … })`, consumed at `:6348-6353` as `createGenuiPromptControl({ name: config.sectionName, order: config.sectionOrder, … }, systemPrompt)`; `dsh-genui/cordis.patch.yml:3-8` inserts `{ id: genui, name: dsh-genui, config: { sectionOrder: 80, sectionName: "genui:cards" } }`. A repo-wide grep finds `sectionName` in no UI/settings code, and `sectionOrder` elsewhere only as `ctx.systemPrompt.getSectionOrder("…")` (e.g. `dsh-tool-pwsh/lib/index.js:352`). No slot option or manifest key named `sectionOrder`/`sectionName` exists → `NOT FOUND`.

---

## 6. Full-page / sidebar panel: yes, and this is the canonical shape

A global panel is a **pair of registrations sharing one id**, plus optional navigation:

```js
const PANEL_ID = "plugins";
ctx.slots.inject("main", function* () {                       // full page (keyed)
  yield ctx.slots.register({ name: "main", key: PANEL_ID, locale: NS, store,
    inject: () => face, children: { /* sub-slots */ } }, PluginManagerPage);
  yield () => { /* undo navigation service */ };
});
ctx.slots.inject("sidebar.panellist", () => ctx.slots.register(  // sidebar icon
  { name: "sidebar.panellist", id: PANEL_ID, order: 0, label: () => t("panel"), locale: NS }, PluginsPanelIcon));
```
(`dsh-client-ui-plugin-manager/lib/client.js:4411-4490`.)

Navigation is the layout service: `ctx.layout.selectPanel(PANEL_ID)`, `ctx.layout.toggleSidebar()`, `ctx.layout.openRightbar(track, fullscreen)`, `ctx.layout.closeRightbar`, state at `ctx.layout.panelInfo` (`dsh-client-ui-layout/README.md:32,57,59`). The plugins page even publishes its own navigation API to other plugins: `ctx.reflect.provide("pluginNavigation", { openList, openBundle })` (`dsh-client-ui-plugin-manager/lib/client.js:4465-4479`).

`dsh-context` does the same thing and gates it on a host-provided placement preference: `dashboardPlacement`-like config `defaultPlacement: 'all'|'tab'|'sidebar'|'hide'` (`dsh-context/lib/index.d.ts`) chooses between a `conversation.view` tab and the `main` + `sidebar.panellist` pair. A timeline-style view is the `conversation.view` tab: `{ name: "conversation.view", id: "trajectory", order: 10, label: () => t("view.trajectory"), children: { … } }` (`dsh-client-ui-trajectory/lib/client.js:8205-8212`).

Constraints:
- Layout state does **not** persist: "Layout state resets on reload" (`dsh-client-ui-layout/README.md:12,94`).
- Selecting a `main` id with no live registration throws; unregistering must clean up its sidebar row too (both are effect-scoped via `ctx.slots.inject`).
- The right column is a track for an edge-anchored panel (45% viewport, retained px preference, capped 70%) — do not assume a fixed width (`dsh-client-ui-layout/README.md:30`).
- The Host half may be an **empty `apply`** whose only purpose is to hold a Loader row so the client bundle is served: "The Host half is an empty `apply`, present only so the package holds a Loader row the client module system serves the browser half for" (`dsh-client-ui-settings-plugins/README.md:40`).
- Browser half is browser-only: the factory `require` resolves only seed words, graph rows and registered factories — anything else throws `client-modules: require("${spec}") missed the module table …` (`dsh-client-modules/lib/client.js:832-849`). Node builtins are therefore unavailable; no `fs`, no `path`, no `process`.
- No documented bundle-size cap (`NOT FOUND`). Observed sizes: `dsh-client-ui-trajectory/lib/client.js` 398,745 B; `dsh-client-ui-tool/lib/client.js` 198,462 B; `dsh-context` 616,622 B; `dsh-genui` 24,836 B; `modlens` 50,354 B. Hard limits that do exist: 3 KiB combo-URL partition (`dsh-client-modules/lib/index.js:237-253`) and one module node per package (edges only to table leaves; `README.md:135`). Chunking is supported through `require.async("./client.<hash>.js")` + `/plugins/<id>/client.<hash>.js` (`lib/client.js:842-848`, `lib/index.js:221-222`).

---

## 7. Developing and testing a client plugin

- **Yes, HMR exists and watches built bundles.** `dsh-client-hmr` "keeps open Web pages in sync with the Host plugin graph and reloads rebuilt browser bundles" (`dsh-client-hmr/README.md:12`). Host half stat-polls each package's stamped entry artifact and serves `/plugins/events`; every new connection receives the full graph (`:62`).
- **What must be running**: `pnpm run dev:web` "starts the host and the rebuild watchers together (`--no-serve` attaches only the watchers to a host started elsewhere, as does any watch process using the shared Client tsdown preset)" (`dsh-client-hmr/README.md:32`). Config: `pollIntervalMs` default `500` (`:40-42`).
- **What a reload does**: invalidate module → prefetch new single-resource script → delete registry runtime → drain old fiber → remove owned styles → materialize new exports → `entry.refresh()` (`:66`). Each reload re-executes the bundle and remounts with fresh state; dependents cascade automatically; React state inside the reloaded plugin is lost while session/workspace/connection state survives (`:36,48,116`). No rollback after teardown (`:117`). Failures appear in Settings → Plugins → plugin list and can be retried there, even at an unchanged revision (`:74`).
- Bundle content changes reach the graph **only** through `rebuilt(id)` (`dsh-client-modules/README.md:76`); revisions come from `mtimeMs`/`ctimeMs`/size, not content hashes (`:78`), so a rewrite preserving all three is invisible.
- Non-HMR installation of a packaged plugin: `dsh plugin --profile web add <pkg>` (`dsh-genui/cordis.patch.yml:2`). A `dsh.bundle.patch` (`cordis.patch.yml`) is how the package inserts its own Loader row on install (`dsh-context/package.json`, `dsh-genui/cordis.patch.yml`).
- Unit-testing the browser half without the host: shipped plugins import React and primitives as externals pinning them in devDependencies/peerDependencies (`dsh-pet/package.json`) and run `tsdown --watch` locally; no plugin-facing test harness was found in the runtime tree → `NOT FOUND` for an official client-plugin test kit.

---

## 8. Minimal skeleton that satisfies all of the above

`package.json`
```json
{
  "type": "module",
  "main": "./lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js" },
  "dsh": { "client": { "platform": "web", "inject": [] } },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.5",
    "@deepseek-ai/dsh-client-ui-primitives": "^0.2.1-rc.5",
    "react": "^18.2.0", "react-dom": "^18.2.0"
  }
}
```

`lib/index.js` (host half — may be `export function apply() {}`)
```js
export const name = "my-panel";
export const inject = ["webServer"];
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: "/api/my-panel/state", handler }), "my-panel: state");
}
```

`lib/client.js` (built to the factory envelope)
```js
const inject = ["slots", "locale"];
function apply(ctx) { /* ctx.slots.inject("main", …) + ("sidebar.panellist", …) */ }
exports.apply = apply; exports.inject = inject;
```

---

## 9. Gaps / not found

- `dsh.client.entry` — does not exist (`NOT FOUND`); entry is `exports["./client"]`.
- `sectionOrder` / `sectionName` as settings or slot keys — `NOT FOUND`; they are host system-prompt config (see §5).
- `@deepseek-ai/dsh-client-ui-primitives` and `@deepseek-ai/dsh-client-ui-slots` source/packages on disk — absent from `harness-src`; `PLATFORM_MODULES` itself lives only in the built shell (`NOT FOUND` as a file; the name is referenced at `dsh-client-modules/README.md:50`).
- Documented bundle-size budget, CSP rules, or an official client-plugin scaffold/test kit — `NOT FOUND`.
- Whether a third party can define its **own** Remote namespace (vs. consuming shipped ones and using an HTTP route): `$mount` is public (`dsh-api-remotes/lib/types/client/index.js:47`) but the capability set is build-time fixed (`README.md:77`) and no shipped third-party plugin exports `./remote` → unverified, treat as `NOT FOUND`.
- Why `dsh-context` needs `@deepseek-ai/dsh-client-ui-sidebar-right` in `dsh.client.inject` while it registers `main`/`sidebar.panellist`: not traced (`NOT FOUND`); `ui-sidebar-right` is still composed in the web patch (`dsh-web-app/cordis.patch.yml:283`).

---

## 10. Implications for harness-agent-extensions (short)

1. A sidebar panel + settings card is a **client-only** deliverable: one `exports["./client"]` bundle, `inject: ["slots"]` (+`locale`), `ctx.slots.inject` into `main` and `sidebar.panellist` with one shared id, plus `plugins.bundle.config` (keyed) for its config UI — the `dsh-context` shape.
2. Data/RPC should use a **plugin-owned HTTP route** on the host half (`webServer.register({kind:"exact", path:"/api/…"})`) for self-contained features; use `ctx.remote` only for shipped capabilities that are already allowlisted.
3. Build with the shared Client tsdown preset and develop with `pnpm run dev:web` (or `--no-serve` against an existing host) so `rebuilt(id)` drives live swaps; anything not emitted through `window.__ModuleLoader__.load` fails with `loaded without registering "…"`.
