/**
 * Safe restore: plan first, then apply.
 *
 * A restore is split into a plan and an execution on purpose. The plan is what
 * the user (or the model) inspects: which files would be written, which would be
 * deleted, what is already in the target state, and — most importantly — which
 * files changed since the checkpoint and therefore *conflict*. Nothing is
 * written until the plan is accepted, and a conflicted plan never applies
 * automatically.
 *
 * @module @harness-ext/time-machine/restore
 */
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { sha256OfFile, writeAtomic } from '@harness-ext/shared';
import type { CheckpointEntry, CheckpointRecord } from './types.ts';
import type { CheckpointService, RestoreSide } from './checkpoint-service.ts';

/** One file in a restore plan. */
export interface RestoreFilePlan {
  /** Manifest path of the entry. */
  path: string;
  /** Absolute path the restore would touch. */
  absPath: string;
  /** Target image; `null` means "delete this file". */
  to: string | null;
  /** Image the file had when the checkpoint was made, if known. */
  from: string | null | undefined;
  /** Current on-disk image, `null` when the file is absent. */
  current: string | null;
  size?: number;
  status: 'write' | 'delete' | 'unchanged' | 'unverifiable';
  /** Why a status is what it is. */
  note?: string;
}

/** A file whose content no longer matches what the checkpoint left behind. */
export interface RestoreConflict {
  path: string;
  absPath: string;
  /** Image the checkpoint expects (undefined when the checkpoint never captured it). */
  expected: string | null | undefined;
  actual: string | null;
}

/** The full plan. */
export interface RestorePlan {
  checkpointId: string;
  side: RestoreSide;
  workspaceRoot: string;
  files: RestoreFilePlan[];
  conflicts: RestoreConflict[];
  /** Objects the restore needs but the store does not hold. */
  missingObjects: string[];
  summary: { writes: number; deletes: number; unchanged: number; unverifiable: number };
  /** True when the plan can be applied without overriding foreign changes. */
  safe: boolean;
}

/** Execution report. */
export interface RestoreReport {
  applied: { path: string; action: 'write' | 'delete'; verified: boolean }[];
  failed: { path: string; error: string }[];
  /** Whether every written file re-hashed to its expected content. */
  verified: boolean;
}

/** Compute the current hash of a file, or null when it is absent. */
export async function currentImage(absPath: string): Promise<string | null> {
  if (!existsSync(absPath)) return null;
  try {
    const stat = statSync(absPath);
    if (!stat.isFile()) return null;
    return await sha256OfFile(absPath);
  } catch {
    return null;
  }
}

function entryTarget(entry: CheckpointEntry, side: RestoreSide): { to: string | null | undefined; expected: string | null | undefined } {
  if (side === 'before') return { to: entry.before, expected: entry.after };
  return { to: entry.after, expected: entry.before };
}

/** Build a restore plan without touching the workspace. */
export async function planRestore(
  service: CheckpointService,
  record: CheckpointRecord,
  side: RestoreSide,
  workspaceRoot: string = record.workspaceRoot ?? process.cwd(),
): Promise<RestorePlan> {
  const files: RestoreFilePlan[] = [];
  const conflicts: RestoreConflict[] = [];
  const missingObjects: string[] = [];
  let writes = 0;
  let deletes = 0;
  let unchanged = 0;
  let unverifiable = 0;

  for (const entry of record.files) {
    const absPath = isAbsolute(entry.path) ? entry.path : resolve(workspaceRoot, entry.path);
    const { to, expected } = entryTarget(entry, side);
    if (to === undefined) {
      unverifiable += 1;
      files.push({
        path: entry.path,
        absPath,
        to: null,
        from: expected,
        current: null,
        status: 'unverifiable',
        note: 'this side of the change was never captured',
      });
      continue;
    }
    const actual = await currentImage(absPath);
    if (to !== null && !service.store.has(to)) {
      missingObjects.push(to);
      files.push({ path: entry.path, absPath, to, from: expected, current: actual, status: 'unverifiable', note: 'content object is missing' });
      unverifiable += 1;
      continue;
    }
    const conflicted = actual !== to && expected !== undefined && expected !== actual;
    if (actual === to) {
      unchanged += 1;
      files.push({ path: entry.path, absPath, to, from: expected, current: actual, status: 'unchanged' });
      continue;
    }
    if (conflicted) conflicts.push({ path: entry.path, absPath, expected, actual });
    if (to === null) {
      deletes += 1;
      files.push({ path: entry.path, absPath, to, from: expected, current: actual, status: 'delete' });
      continue;
    }
    writes += 1;
    const size = service.store.size(to);
    files.push({
      path: entry.path,
      absPath,
      to,
      from: expected,
      current: actual,
      status: 'write',
      ...(size === undefined ? {} : { size }),
      ...(conflicted ? { note: 'current content differs from what the checkpoint left behind' } : {}),
    });
  }

  return {
    checkpointId: record.id,
    side,
    workspaceRoot,
    files,
    conflicts,
    missingObjects: [...new Set(missingObjects)],
    summary: { writes, deletes, unchanged, unverifiable },
    safe: conflicts.length === 0 && missingObjects.length === 0,
  };
}

/**
 * Apply a plan.
 *
 * `force` is required to override conflicts; without it a conflicted plan is
 * rejected before any write happens. Every written file is re-hashed so a
 * partially failed restore is reported as failed instead of "done".
 */
export async function applyRestore(
  service: CheckpointService,
  plan: RestorePlan,
  options: { force?: boolean } = {},
): Promise<RestoreReport> {
  if (!plan.safe && options.force !== true) {
    throw new Error(
      `restore refused: ${plan.conflicts.length} conflict(s), ${plan.missingObjects.length} missing object(s); pass force to override`,
    );
  }

  // Re-verify every target immediately before writing. A plan can be minutes
  // old, and an editor (or another agent) may have saved in between; without
  // `force`, any drift aborts the whole restore before the first write.
  if (options.force !== true) {
    const drifted: string[] = [];
    for (const file of plan.files) {
      if (file.status === 'unchanged' || file.status === 'unverifiable') continue;
      const actual = await currentImage(file.absPath);
      if (actual !== file.current) drifted.push(file.path);
    }
    if (drifted.length > 0) {
      const preview = drifted.slice(0, 3).join(', ');
      const suffix = drifted.length > 3 ? `, … (${String(drifted.length)} total)` : '';
      throw new Error(
        `restore refused: ${String(drifted.length)} file(s) changed after the plan was built: ${preview}${suffix}; re-plan or pass force to override`,
      );
    }
  }
  const applied: RestoreReport['applied'] = [];
  const failed: RestoreReport['failed'] = [];
  for (const file of plan.files) {
    if (file.status === 'unchanged' || file.status === 'unverifiable') continue;
    try {
      if (file.status === 'delete') {
        rmSync(file.absPath, { force: true });
        applied.push({ path: file.path, action: 'delete', verified: !existsSync(file.absPath) });
        continue;
      }
      const buffer = file.to === null ? undefined : service.store.read(file.to);
      if (buffer === undefined) throw new Error('content object is missing');
      mkdirSync(dirname(file.absPath), { recursive: true });
      writeAtomic(file.absPath, buffer);
      const after = await sha256OfFile(file.absPath);
      applied.push({ path: file.path, action: 'write', verified: after === file.to });
    } catch (error) {
      failed.push({ path: file.path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { applied, failed, verified: failed.length === 0 && applied.every((entry) => entry.verified) };
}
