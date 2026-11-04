# Contributing

Thanks for considering a contribution. This repository contains documentation, two
Cordis plugins, a shared library, tests, and benchmarks. Changes should stay inside
that boundary: the plugins extend DeepSeek Harness from the outside and do not patch
Harness core code.

## Prerequisites

- Node.js `>=22.12.0`. The plugins declare that runtime requirement. For development,
  use Node 24: `pnpm test` executes TypeScript sources directly through Node's type
  stripping, and the tests are not transpiled first.
- pnpm `11.28.5`, the version pinned by the root `package.json` `packageManager`
  field. Enable it through Corepack or install that pnpm version directly.
- Windows, macOS, or Linux. Windows is a supported development platform; see the
  Windows notes below before writing scripts or tests that touch files.

The repository has no native build step. TypeScript, Node built-ins, and the pinned
Harness peer packages are the whole toolchain.

## Setup

```bash
pnpm install
pnpm test
pnpm build
pnpm typecheck
```

- `pnpm install` installs the workspace and the exact Cordis/DSH packages used by the
  real-Cordis tests.
- `pnpm test` runs every `packages/*/test/**/*.test.ts` file with `node --test`,
  including `tests/packaging.test.ts`. No build is needed first.
- `pnpm build` runs `tsc -b` for `shared`, `time-machine`, and `context-os`, in that
  order, and writes each package's `lib/`.
- `pnpm typecheck` runs the same project build with verbose output. It is the
  compiler check; there is no separate ESLint or Prettier configuration.
- `pnpm bench` runs the synthetic benchmark suite. Benchmarks are optional for a
  normal change; run them when the change affects capture, recall, or brief building.
- `pnpm bench:scale` is the opt-in large-repository run (10 000 files by default,
  about a minute). It is not part of CI and asserts nothing; use it when a change
  alters scanning, snapshotting, or restore planning. `BENCH_SCALE_FILES` overrides
  the file count.

If `pnpm` is not on `PATH`, invoke the pinned version through Corepack or your
package-manager shim. Do not add a second package manager or a lockfile from another
tool.

## Project conventions

### TypeScript and module specifiers

The repository uses strict TypeScript with `NodeNext` module resolution,
`noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `isolatedModules`, and project
references. Source imports use TypeScript specifiers:

```ts
import { ContextStore } from '../src/core/store.ts';
import { diffTexts } from '@harness-ext/shared';
```

The `.ts` extension is deliberate. Tests run those files directly with Node 24 type
stripping; the build rewrites relative `.ts` specifiers to `.js` through
`rewriteRelativeImportExtensions`. Use a type-only import (`import type`) for types,
and keep import cycles out of the package entry points.

Published code is built with `tsc -b`; do not hand-edit `lib/` or commit generated
output. A package's public surface is its `lib/index.js` plus the `exports` map in
its `package.json`.

### Dependencies

The only runtime dependency of a plugin is `@harness-ext/shared`. Harness packages
(`@deepseek-ai/cordis`, `dsh-session`, `dsh-tools`) are peer dependencies and dev
dependencies; do not add them as regular dependencies or bundle them. Node built-ins
are preferred over new packages. A new runtime dependency needs a clear reason, a
license check, and a note in the pull request.

### Lifecycle and disposal

Every registration must be disposable. This includes tool registrations, filesystem
or session hooks, provided services, event-bus subscriptions, open databases, and
timers. Register cleanups through `ctx.effect` (or return the disposer from the
function that `ctx.effect` wraps) so unloading the plugin leaves no listener, timer,
or file handle behind. A test that mounts and unloads the plugin should prove the
registrations are gone.

### Configuration

`normalizeConfig` must never throw. Malformed input is a normal condition: return
the default for the affected field, record an issue, and let the plugin mount. The
two packages differ in their normalisation policy:

- Time Machine clamps finite numeric values into the documented range and truncates
  them to integers; wrong types fall back to the default.
- Context OS keeps the default for an out-of-range or wrong-typed value and records
  an issue; accepted numbers are rounded but not clamped.

Both policies are intentional. Do not "improve" one to match the other without
updating the configuration docs and tests. Unknown keys are currently ignored, but
new known keys must be added to the type, the default object, the normaliser, the
tests, `docs/CONFIGURATION.md`, and both READMEs when the change is user-visible.

### Tools

Tool definitions are registered through the package's `registerTools` helper and
`defineTool` from `@deepseek-ai/dsh-tools`. Registration must never throw: a failure
to register one tool is logged as a warning and must not prevent the plugin from
mounting. This is why the helpers wrap `register(definition)` in a `try`/`catch`.

Tool `execute` functions may return a structured error or throw for a refused
operation (for example, an unsafe restore without `force`). That is different from
registration failure. Keep user-facing refusals precise: say which safety rule
fired and what the caller can do next.

### File writes

Workspace file writes belong to the Time Machine restore path. Content is read from
the content-addressed object store, written to a temporary file, renamed into place,
and re-hashed. Do not add a second ad-hoc writer for workspace files, and do not
write into Harness session logs, profile data, or another plugin's storage.

Plugin-owned state belongs under its private `$DSH_HOME` directory:

- `$DSH_HOME/time-machine/` for objects, the checkpoint journal, and staging.
- `$DSH_HOME/context-os/context.db` for the Context OS SQLite database.

## Adding a tool

The existing tools are thin adapters over a runtime object; follow that shape.

1. Implement the operation in the package's core layer (`src/core/`). Keep it
   independent of Cordis where possible so it can be unit-tested directly.
2. Expose it through the package runtime in `plugin.ts` (for Time Machine,
   `TimeMachineRuntime` in `tools.ts` is implemented by the plugin; for Context OS,
   the runtime is the store-backed service).
3. Add the definition in `src/tools.ts`:

   ```ts
   add(
     'tm_example',
     defineTool({
       name: 'tm_example',
       description: 'One sentence that says what the tool does and when to use it.',
       parameters: {
         limit: { type: 'integer', description: 'Maximum items.', minimum: 1 },
       },
       output: {
         schema: {
           type: 'object',
           additionalProperties: false,
           properties: {
             count: { type: 'integer', required: true },
           },
         },
         render(_args, value) {
           return [{ type: 'text', text: `count: ${String(value.count)}` }];
         },
       },
       execute(args) {
         return runtime.example({ limit: args.limit });
       },
     }),
   );
   ```

   `parameters` is a map of JSON-Schema property descriptions; put `required: true`
   on the property, not in a separate array. `output.schema` is the machine-readable
   result, and `render` returns Harness content blocks.
4. Respect the package limits: `maxListItems` and `maxDiffChars` for Time Machine,
   `maxChars` for Context OS body snippets. Clamp caller-supplied limits in the
   adapter rather than trusting the model.
5. Add the tool name to the relevant `tools.disabled` handling by using the shared
   `add` helper; do not call `ctx.tools.register` directly.
6. Test the tool through the plugin surface, not only the core function. Include a
   disposal test that unloads the plugin and asserts the tool is gone.
7. Update `docs/CONFIGURATION.md` and the READMEs if the tool adds a configuration
   key or changes the documented tool list.

## Adding a test

Tests use the built-in Node test runner. There is no Jest, Vitest, or Mocha.

- Put tests in `packages/<package>/test/` and name the file `*.test.ts`.
- Import `test` from `node:test` and `assert` from `node:assert/strict`.
- Test the real implementation, not a reimplementation. For SQLite, use a real
  `node:sqlite` database; for filesystem behavior, use a temporary directory.
- A filesystem test should create a unique directory with `mkdtemp` under
  `os.tmpdir()`, pass it explicitly to the code under test, and remove it in a
  `finally` block. Never write into the repository or the user's home directory.
- Use a fixed clock (or an injected `now` function) for TTL and recency tests so the
  result does not depend on wall time.
- For plugin behavior, mount the plugin with a fake Cordis context when the test is
  about wiring. Use the real `@deepseek-ai/cordis` package for lifecycle and hook
  order tests; the dev dependency is pinned for that purpose.
- Run a single file directly while iterating:

  ```bash
  node --test packages/context-os/test/store.test.ts
  ```

Behavior changes need tests. A bug fix should include a regression test that fails
before the fix. Prefer a small number of focused tests over a large integration test
that hides which rule broke.

## Windows notes

The repository is developed on Windows as well as macOS and Linux. Keep tests and
scripts portable:

- Do not round-trip files through PowerShell text cmdlets such as
  `Get-Content ... | Set-Content ...`. They can change encoding, add a BOM, or
  normalise line endings. Use Node's `fs` APIs, or write JSON with
  `JSON.stringify` in a Node script.
- Build paths with `path.join` / `path.resolve`; do not concatenate separators.
- Treat `\r\n` and `\n` as equivalent when asserting on file content, or write the
  fixture with an explicit encoding and newline.
- Use `mkdtemp` and clean up with `rm(..., { recursive: true, force: true })`. Avoid
  shell `rm -rf` and platform-specific cleanup commands in tests.
- Do not assume a POSIX shell, `cp`, or `chmod`. If a test needs an executable bit or
  a symlink, skip it on platforms that do not support the operation rather than
  failing.
- File handles and SQLite connections must be closed before the temporary directory
  is removed; Windows refuses to delete open files.

## Review checklist

Before opening or updating a pull request, confirm:

- [ ] `pnpm test` passes, including the new or updated tests.
- [ ] `pnpm typecheck` is clean, and `pnpm build` succeeds.
- [ ] `pnpm build` succeeds, so the shipped `lib/` matches the sources.
- [ ] Behaviour changes have a test that would fail without the change.
- [ ] Plugin registrations and resources are released on unload.
- [ ] Configuration changes are reflected in the normaliser, tests, and
      `docs/CONFIGURATION.md`.
- [ ] User-visible changes are reflected in `README.md` and `README.zh-CN.md`.
- [ ] No Harness core file, session log, profile file, or other plugin's database is
      modified.
- [ ] No secret, token, private key, or machine-specific absolute path is committed.
- [ ] The change is limited to the stated problem; unrelated formatting churn is
      removed.

## Commit and pull request style

Use Conventional Commits, for example:

```text
feat(time-machine): add a tool for checkpoint metadata
fix(context-os): keep the retain floor when the cap is small
test(context-os): cover Chinese FTS recall
docs: document the profile override for @harness-ext/shared
chore: pin the Cordis dev dependency
```

Keep commits and pull requests small and focused. A pull request should explain the
problem, the chosen approach, the user-visible effect, and the tests that cover it.
Call out follow-up work separately instead of folding it into the same change. Do not
commit generated `lib/` output, benchmark result files, or local profile data.

By contributing, you agree that your contribution is licensed under the repository's
MIT license.
