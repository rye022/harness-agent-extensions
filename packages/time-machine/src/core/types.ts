/**
 * On-disk checkpoint model.
 *
 * A checkpoint is a record of the state of a set of files at one moment. It
 * stores hashes, not paths to copies, because the images live in the
 * content-addressed object store and are shared between checkpoints.
 *
 * Two kinds of checkpoints exist, and the difference is visible in `files`:
 *
 * - tool/turn checkpoints record `before` (the image the first mutation would
 *   replace) and, once the turn settles, `after`. They answer "what did this
 *   step change, and how do I undo or redo it".
 * - manual and pre-restore checkpoints record the whole scanned tree, with
 *   `before === after`. They answer "what did the workspace look like".
 *
 * `null` is meaningful and never the same as "unknown": `before: null` means
 * the file did not exist, while a missing `after` means it was not captured.
 *
 * @module @harness-ext/time-machine/types
 */
import type { ContentHash } from '@harness-ext/shared';

/** Format version of the record written to the journal. */
export const CHECKPOINT_SCHEMA = 1 as const;

/** How a checkpoint came to exist. */
export type CheckpointOrigin = 'auto-tool' | 'auto-turn' | 'manual' | 'pre-restore';

/** What a captured file looked like. */
export type CapturedKind = 'text' | 'binary' | 'oversized' | 'symlink' | 'unreadable';

/** One file inside a checkpoint. */
export interface CheckpointEntry {
  /** Path as recorded: workspace-relative POSIX when inside the workspace, otherwise absolute POSIX. */
  path: string;
  /** Image before the mutation; `null` means the file did not exist. */
  before: ContentHash | null;
  /** Image after the mutation; `undefined` means it was never captured, `null` means it was deleted. */
  after?: ContentHash | null;
  sizeBefore?: number;
  sizeAfter?: number;
  kind: CapturedKind;
  /** Tool call that produced the first mutation of this file in the turn, when known. */
  tool?: { name: string; callId?: string };
  /** Free-form note: why a capture was skipped, which operation caused it, and so on. */
  note?: string;
}

/** A test or check that ran around the captured changes. */
export interface CheckpointTestResult {
  /** Tool call that produced the result, when known. */
  callId?: string;
  /** Command or tool name, trimmed for display. */
  command: string;
  status: 'passed' | 'failed' | 'unknown';
  exitCode?: number;
  summary?: string;
  at: string;
}

/** One checkpoint record. */
export interface CheckpointRecord {
  schema: typeof CHECKPOINT_SCHEMA;
  /** Stable identifier, also the file name in the journal order. */
  id: string;
  createdAt: string;
  createdAtMs: number;
  origin: CheckpointOrigin;
  /** Human label supplied by the user or derived from the tool call. */
  label?: string;
  sessionId?: string;
  turn?: number;
  step?: number;
  tool?: { name: string; callId?: string };
  /** Previous checkpoint of the same session, for walking history. */
  parentId?: string;
  workspaceRoot?: string;
  cwd?: string;
  files: CheckpointEntry[];
  tests?: CheckpointTestResult[];
  /** Set when capture failed part-way; the record is then explicitly incomplete. */
  error?: string;
  stats?: { files: number; bytes: number; stored: number };
}

/** What a caller may ask to be captured before a mutation. */
export interface CaptureTarget {
  /** Absolute path of the file that is about to change. */
  absPath: string;
  /** Tool that is about to touch the file, for attribution. */
  tool?: { name: string; callId?: string };
}

/** Buffered state for one turn of one session. */
export interface TurnBuffer {
  sessionId?: string;
  turn?: number;
  workspaceRoot: string;
  /** path → entry captured before its first mutation in this turn. */
  entries: Map<string, CheckpointEntry>;
  /** Absolute paths touched during the turn, in first-touch order. */
  order: string[];
  tests: CheckpointTestResult[];
}
