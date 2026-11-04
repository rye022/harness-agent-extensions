/**
 * Public entrypoint of `@harness-ext/context-os`.
 *
 * The Cordis loader imports this module, reads `name` / `inject`, and calls
 * `apply`. Everything else is exported so tests and integrations can use the
 * store, the budget policy and the tool registry directly.
 */
export { apply, inject, name, version, BRIEF_MARKER } from './plugin.ts'
export type { ContextOsService, ContextOsEventMap, PluginContext } from './plugin.ts'

export { registerTools, toHitSummary } from './tools.ts'
export type { ContextOsRuntime, ContextOsStatus, HitSummary, ToolScope } from './tools.ts'

export { DEFAULT_CONFIG, defaultRoot, dshHome, normalizeConfig, resolveDbPath } from './config.ts'
export type { ConfigIssue, ContextOsConfig, NormalizedConfig } from './config.ts'

export * from './core/index.ts'
