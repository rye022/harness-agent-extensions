/**
 * Shared primitives for the Harness Agent Extensions.
 *
 * Only framework-free code lives here: hashing, path policy, ignore rules,
 * line diff, JSONL journals, small fs helpers and token estimates. Both
 * `@harness-ext/time-machine` and `@harness-ext/context-os` depend on this
 * package, and the plugin packages never depend on each other directly.
 *
 * @module @harness-ext/shared
 */
export { sha256Hex, sha256OfFile, isContentHash, type ContentHash } from './hash.ts';
export { toPosixPath, pathKey, isWithin, displayPath, resolveManifestPath, joinPosix } from './paths.ts';
export {
  DEFAULT_IGNORED_DIRECTORIES,
  DEFAULT_IGNORED_FILES,
  DEFAULT_MAX_FILE_BYTES,
  IgnorePolicy,
  globToRegExp,
  matchesAny,
  hasIgnoredSegment,
  looksBinary,
  type IgnorePolicyOptions,
  type IgnoreDecision,
} from './ignore.ts';
export {
  diffTexts,
  formatHunks,
  splitLines,
  type DiffHunk,
  type DiffLine,
  type DiffOptions,
  type DiffResult,
} from './diff.ts';
export { appendJsonl, readJsonl, readLastJsonl } from './jsonl.ts';
export { readIfExists, sizeOf, exists, isMissing, readHead, writeAtomic, ensureDir, safeJoin } from './fsx.ts';
export { estimateTokens, estimateTokensOf } from './tokens.ts';
export { TypedBus, type BusListener, type TypedBusLike } from './events.ts';
