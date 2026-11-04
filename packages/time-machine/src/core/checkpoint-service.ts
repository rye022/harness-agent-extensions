/**
 * Checkpoint orchestration: capture, finalize, snapshot.
 *
 * The service is framework-free on purpose. The Cordis plugin owns timers,
 * sessions and tools; this class owns hashing, dedupe and the journal, so it can
 * be exercised by unit tests without a running harness.
 *
 * @module @harness-ext/time-machine/checkpoint-service
 */
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  DEFAULT_MAX_FILE_BYTES,
  IgnorePolicy,
  displayPath,
  isWithin,
  looksBinary,
  readHead,
  toPosixPath,
} from '@harness-ext/shared';
import { CheckpointIndex, newCheckpointId } from './checkpoint-index.ts';
import { ObjectStore } from './object-store.ts';
import { scanWorkspace, type ScanResult } from './workspace-scan.ts';
import {
  CHECKPOINT_SCHEMA,
  type CaptureTarget,
  type CapturedKind,
  type CheckpointEntry,
  type CheckpointRecord,
  type CheckpointTestResult,
  type TurnBuffer,
} from './types.ts';

/** Options for a checkpoint service. */
export interface CheckpointServiceOptions {
  /** Directory that holds the journal and the object store. */
  root: string;
  policy?: IgnorePolicy;
  /** Files captured by one snapshot. */
  maxFiles?: number;
  now?: () => number;
  logger?: { info(message: string): void; warn(message: string): void };
}

/** Which state of a checkpoint to use. */
export type RestoreSide = 'before' | 'after';

/** Identity of the turn a capture belongs to. */
export interface TurnScope {
  sessionId?: string;
  turn?: number;
  workspaceRoot: string;
}

/** Outcome of capturing one image. */
interface CapturedImage {
  hash: string | null;
  size?: number;
  kind: CapturedKind;
  note?: string;
}

/** The checkpoint engine. */
export class CheckpointService {
  readonly store: ObjectStore;
  readonly index: CheckpointIndex;
  readonly policy: IgnorePolicy;
  private readonly maxFiles: number;
  private readonly now: () => number;
  private readonly logger: { info(message: string): void; warn(message: string): void };
  private readonly buffers = new Map<string, TurnBuffer>();

  constructor(options: CheckpointServiceOptions) {
    this.store = new ObjectStore(options.root);
    this.index = new CheckpointIndex(options.root);
    this.policy = options.policy ?? new IgnorePolicy();
    this.maxFiles = options.maxFiles ?? 5000;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? { info: () => {}, warn: () => {} };
  }

  private bufferKey(scope: TurnScope): string {
    return `${scope.sessionId ?? 'anonymous'}|${scope.turn ?? 0}`;
  }

  /** Create (or reuse) the in-memory buffer for one turn. */
  private bufferFor(scope: TurnScope): TurnBuffer {
    const key = this.bufferKey(scope);
    let buffer = this.buffers.get(key);
    if (buffer === undefined) {
      buffer = {
        sessionId: scope.sessionId,
        turn: scope.turn,
        workspaceRoot: scope.workspaceRoot,
        entries: new Map(),
        order: [],
        tests: [],
      };
      this.buffers.set(key, buffer);
    }
    return buffer;
  }

  /** Resolve a path to its manifest form and absolute form. */
  private manifestPath(absPath: string, workspaceRoot: string): string {
    if (isWithin(workspaceRoot, absPath)) {
      const rel = toPosixPath(relative(resolve(workspaceRoot), resolve(absPath)));
      return rel === '' ? '.' : rel;
    }
    return toPosixPath(absPath);
  }

  /** Capture the current state of one file. */
  private async captureImage(absPath: string): Promise<CapturedImage> {
    let stat;
    try {
      stat = lstatSync(absPath);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { hash: null, kind: 'text', note: 'did-not-exist' };
      return { hash: null, kind: 'unreadable', note: `stat-failed:${errorCode(error)}` };
    }
    if (stat.isSymbolicLink()) return { hash: null, kind: 'symlink', note: 'symlinks-are-not-captured' };
    if (!stat.isFile()) return { hash: null, kind: 'unreadable', note: 'not-a-regular-file' };
    if (stat.size > this.policy.maxFileBytes) {
      return { hash: null, size: stat.size, kind: 'oversized', note: `larger-than-${this.policy.maxFileBytes}-bytes` };
    }
    let kind: CapturedKind = 'text';
    try {
      if (looksBinary(readHead(absPath, 8192))) kind = 'binary';
    } catch (error) {
      return { hash: null, size: stat.size, kind: 'unreadable', note: `read-failed:${errorCode(error)}` };
    }
    try {
      const stored = await this.store.putFile(absPath);
      return { hash: stored.hash, size: stored.size, kind };
    } catch (error) {
      return { hash: null, size: stat.size, kind: 'unreadable', note: `store-failed:${errorCode(error)}` };
    }
  }

  /**
   * Capture the pre-mutation image of a file, once per turn.
   *
   * Returning the entry that is already buffered is intentional: the second and
   * later mutations of the same file in one turn must not overwrite the state
   * the turn started from.
   */
  async captureBefore(target: CaptureTarget, scope: TurnScope): Promise<CheckpointEntry | undefined> {
    const absPath = resolve(target.absPath);
    const relPath = this.manifestPath(absPath, scope.workspaceRoot);
    if (this.policy.check(relPath).ignored) return undefined;
    const buffer = this.bufferFor(scope);
    const existing = buffer.entries.get(relPath);
    if (existing !== undefined) return existing;
    const image = await this.captureImage(absPath);
    const entry: CheckpointEntry = {
      path: relPath,
      before: image.hash,
      sizeBefore: image.size,
      kind: image.kind,
      ...(target.tool === undefined ? {} : { tool: { ...target.tool } }),
      ...(image.note === undefined ? {} : { note: image.note }),
    };
    if (image.note !== undefined && image.note !== 'did-not-exist') {
      this.logger.warn(`time-machine: capture problem for ${relPath}: ${image.note}`);
    }
    buffer.entries.set(relPath, entry);
    buffer.order.push(relPath);
    return entry;
  }

  /** Remember a test result observed during the turn. */
  recordTest(scope: TurnScope, result: CheckpointTestResult): void {
    this.bufferFor(scope).tests.push(result);
  }

  /**
   * Close the turn's buffer into a checkpoint record.
   *
   * Returns undefined when nothing was captured, so an idle turn never creates
   * an empty checkpoint. A capture failure inside the turn is recorded on the
   * record (`error`) instead of being thrown, because the turn itself already
   * succeeded from the agent's point of view.
   */
  async finalizeTurn(scope: TurnScope): Promise<CheckpointRecord | undefined> {
    const key = this.bufferKey(scope);
    const buffer = this.buffers.get(key);
    if (buffer === undefined || buffer.entries.size === 0) return undefined;
    this.buffers.delete(key);
    const problems: string[] = [];
    const files: CheckpointEntry[] = [];
    for (const relPath of buffer.order) {
      const entry = buffer.entries.get(relPath)!;
      const absPath = resolve(scope.workspaceRoot, relPath);
      const image = await this.captureImage(absPath);
      if (image.note !== undefined && image.note !== 'did-not-exist') {
        problems.push(`${relPath}: ${image.note}`);
      }
      const finalized: CheckpointEntry = { ...entry, after: image.hash };
      if (image.size !== undefined) finalized.sizeAfter = image.size;
      files.push(finalized);
    }
    const parent = scope.sessionId === undefined ? undefined : this.index.lastForSession(scope.sessionId);
    const record: CheckpointRecord = {
      schema: CHECKPOINT_SCHEMA,
      id: newCheckpointId(this.now()),
      createdAt: new Date(this.now()).toISOString(),
      createdAtMs: this.now(),
      origin: 'auto-turn',
      ...(scope.sessionId === undefined ? {} : { sessionId: scope.sessionId }),
      ...(scope.turn === undefined ? {} : { turn: scope.turn }),
      ...(parent === undefined ? {} : { parentId: parent.id }),
      workspaceRoot: scope.workspaceRoot,
      files,
      ...(buffer.tests.length === 0 ? {} : { tests: buffer.tests }),
      ...(problems.length === 0 ? {} : { error: problems.join('; ') }),
      stats: this.statsOf(files),
    };
    this.index.append(record);
    return record;
  }

  /** Drop a turn buffer without writing a record (session disposed, aborted turn). */
  discardTurn(scope: TurnScope): void {
    this.buffers.delete(this.bufferKey(scope));
  }

  /** Capture a whole workspace tree as one checkpoint. */
  async createSnapshot(options: {
    workspaceRoot: string;
    origin: 'manual' | 'pre-restore' | 'auto-turn';
    label?: string;
    sessionId?: string;
    /** Turn number, when the snapshot stands for one turn. */
    turn?: number;
    /** Restrict the scan to these workspace-relative paths. */
    onlyPaths?: readonly string[];
  }): Promise<{ record: CheckpointRecord; scan: ScanResult }> {
    const scan = scanWorkspace(options.workspaceRoot, { policy: this.policy, maxFiles: this.maxFiles });
    const wanted =
      options.onlyPaths === undefined
        ? scan.files
        : scan.files.filter((file) => options.onlyPaths!.some((path) => toPosixPath(path) === file.relPath));
    const files: CheckpointEntry[] = [];
    const problems: string[] = [];
    for (const file of wanted) {
      const image = await this.captureImage(file.absPath);
      if (image.note !== undefined && image.note !== 'did-not-exist') problems.push(`${file.relPath}: ${image.note}`);
      files.push({
        path: file.relPath,
        before: image.hash,
        after: image.hash,
        ...(image.size === undefined ? {} : { sizeBefore: image.size, sizeAfter: image.size }),
        kind: image.kind,
      });
    }
    const record: CheckpointRecord = {
      schema: CHECKPOINT_SCHEMA,
      id: newCheckpointId(this.now()),
      createdAt: new Date(this.now()).toISOString(),
      createdAtMs: this.now(),
      origin: options.origin,
      ...(options.label === undefined ? {} : { label: options.label }),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.turn === undefined ? {} : { turn: options.turn }),
      workspaceRoot: options.workspaceRoot,
      files,
      ...(problems.length === 0 ? {} : { error: problems.join('; ') }),
      stats: this.statsOf(files),
    };
    this.index.append(record);
    return { record, scan };
  }

  /** Human-readable path for a manifest entry. */
  display(record: CheckpointRecord, entry: CheckpointEntry): string {
    return displayPath(isAbsolute(entry.path) ? entry.path : resolve(record.workspaceRoot ?? '.', entry.path));
  }

  /** Store statistics used by `tm_status`. */
  stats(): { checkpoints: number; objects: number; referencedBytes: number; journalBytes: number } {
    let referencedBytes = 0;
    for (const hash of this.index.referencedHashes()) referencedBytes += this.store.size(hash) ?? 0;
    return {
      checkpoints: this.index.size,
      objects: this.index.referencedHashes().size,
      referencedBytes,
      journalBytes: this.index.journalBytes(),
    };
  }

  private statsOf(files: readonly CheckpointEntry[]): { files: number; bytes: number; stored: number } {
    let bytes = 0;
    let stored = 0;
    const hashes = new Set<string>();
    for (const entry of files) {
      bytes += (entry.sizeBefore ?? 0) + (entry.sizeAfter ?? 0);
      if (entry.before !== null) hashes.add(entry.before);
      if (entry.after !== null && entry.after !== undefined) hashes.add(entry.after);
    }
    stored = hashes.size;
    return { files: files.length, bytes, stored };
  }
}

/** Read a checkpoint's stored image as text, for diffs. */
export function readEntryText(store: ObjectStore, hash: string | null | undefined): string | undefined {
  if (hash === null || hash === undefined) return undefined;
  return store.readText(hash);
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String((error as { code?: unknown }).code ?? 'unknown');
  }
  return error instanceof Error ? error.message : 'unknown';
}

/** Re-exported for tests that build synthetic targets. */
export { DEFAULT_MAX_FILE_BYTES };
