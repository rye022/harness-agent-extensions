# Changelog

All three packages share one version line for the two plugins (`@harness-ext/time-machine`,
`@harness-ext/context-os`). `@harness-ext/shared` stays at 0.1.0 and is versioned only
when its public helpers change.

## 0.1.2 — 2026-11-04

Inject when a brief still fits. Release:
[v0.1.2](https://github.com/rye022/harness-agent-extensions/releases/tag/v0.1.2)

- Context OS no longer refuses to contribute a brief just because the free room is
  smaller than the configured reserve. The reserve is capped at half of the remaining
  room (`reserve = min(retainTokens, floor(free / 2))`) and a brief needs at least 80
  usable tokens, so a brief is injected whenever it fits — including above 90 % pressure.
  A context already over its window still has nothing to give and reports
  `no room for a brief: 0 tokens free, 0 reserved, 0 usable (< 80)`.
- The reserve of `conservative` dropped from 25 % to 10 %: at its own 85 % trigger only
  15 % is free, so a 25 % reserve made the mode structurally unable to fire.
- Installers `install.ps1` / `install.sh` now pick the newest tarball they find instead
  of hard-coding a version, so they keep working across releases.
- Tests: 76 (dev tree and public tree), covering the new rule and the over-window case.

## 0.1.1 — 2026-11-04

Measure the window, validate layers, audit decisions. Release:
[v0.1.1](https://github.com/rye022/harness-agent-extensions/releases/tag/v0.1.1)

- Context OS measures the context window the harness reports
  (`contextPressure.contextWindow`) instead of trusting the configured `windowTokens`
  default. A stale default made every pressure decision wrong: with the default
  `131072` on a `1048576`-token window the plugin computed negative free space and
  could never inject a brief.
- Every budget decision is appended to `$DSH_HOME/context-os/decisions.jsonl`
  (`{"at","sessionId","windowTokens","event","turn","step","decision"}`), configurable
  through `audit.enabled` / `audit.maxBytes`.
- `ContextStore.remember()` rejects layers outside `L1 | L2 | L3` instead of storing
  them; the tool schema documents the enum.
- Version assertions in the tests derive from the package version instead of a literal.

## 0.1.0 — 2026-11-04

First public release. Assets: three tarballs plus `install.ps1` / `install.sh`.
Release: [v0.1.0](https://github.com/rye022/harness-agent-extensions/releases/tag/v0.1.0)

- `@harness-ext/time-machine` — content-addressed file checkpoints. Captures pre-images
  through `fs/write-intent` / `fs/edit-intent`, commits one `auto-turn` checkpoint per
  turn, and ships `tm_checkpoint`, `tm_list`, `tm_diff`, `tm_restore`, `tm_status`.
  Restores refuse when the plan was built against files that changed since (TOCTOU
  guard), and always write a `pre-restore` checkpoint first.
- `@harness-ext/context-os` — L1/L2/L3 memory in SQLite with FTS5 (CJK-aware
  tokenisation), automatic ingestion from `session/event`, budget decisions per mode,
  brief building, and `co_remember`, `co_recall`, `co_brief`, `co_status`, `co_forget`.
- Both plugins: `cordis.patch.yml` bundle patch, `dsh.compatibility.dshReleases`
  pinned to `0.2.1-rc.5`, optional one-directional interop (Time Machine checkpoints
  become memories; restores mark affected memories stale).
- Tests 73, benchmarks for checkpoints, recall, brief coverage and a 10 000-file repo.
- Known limits: no UI panel, no live-model end-to-end test in CI, `pwsh` file edits are
  not captured, no vector retrieval, file restore is not session or context restore.
