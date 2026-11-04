/**
 * Framework-free core of the time machine.
 *
 * Everything under `core/` can be used and tested without Cordis, a harness
 * session or a model: the object store, the journal, the capture service, the
 * workspace scanner and the restore planner/executor.
 *
 * @module @harness-ext/time-machine/core
 */
export * from './types.ts';
export * from './object-store.ts';
export * from './checkpoint-index.ts';
export * from './checkpoint-service.ts';
export * from './restore.ts';
export * from './workspace-scan.ts';
