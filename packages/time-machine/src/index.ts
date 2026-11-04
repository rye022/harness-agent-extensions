/**
 * @harness-ext/time-machine — file checkpoints, timeline and safe restore for
 * DeepSeek Harness.
 *
 * `apply`, `inject` and `name` are the Cordis plugin entry the harness loader
 * calls. The framework-free core is re-exported too, so tests, benchmarks and
 * an embedding application can drive checkpoints without a running harness.
 *
 * @module @harness-ext/time-machine
 */
export { apply, inject, name, version } from './plugin.ts';
export type { PluginContext, TimeMachineEvents, TimeMachineService } from './plugin.ts';
export { registerTools } from './tools.ts';
export type { TimeMachineRuntime } from './tools.ts';
export { normalizeConfig, defaultRoot, dshHome, DEFAULT_CONFIG } from './config.ts';
export type { TimeMachineConfig, NormalizedConfig, ConfigIssue } from './config.ts';
export * from './core/index.ts';
