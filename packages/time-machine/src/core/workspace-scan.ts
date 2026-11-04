/**
 * Workspace scanning for manual and pre-restore checkpoints.
 *
 * The scan is deliberately conservative: it never follows symlinks (a checkpoint
 * could otherwise escape the workspace or loop), skips the default ignore
 * policy, and stops at a file-count ceiling so one checkpoint cannot walk a
 * huge monorepo for minutes.
 *
 * @module @harness-ext/time-machine/workspace-scan
 */
import { lstatSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { IgnorePolicy, looksBinary, readHead, toPosixPath } from '@harness-ext/shared';
import type { CapturedKind } from './types.ts';

/** One scanned file. */
export interface ScannedFile {
  absPath: string;
  /** POSIX path relative to the scan root. */
  relPath: string;
  size: number;
  kind: CapturedKind;
}

/** One skipped path, for user-facing explanations. */
export interface SkippedPath {
  relPath: string;
  reason: string;
}

/** Result of a scan. */
export interface ScanResult {
  files: ScannedFile[];
  skipped: SkippedPath[];
  /** True when the file-count ceiling stopped the walk. */
  truncated: boolean;
}

/** Scan options. */
export interface ScanOptions {
  policy: IgnorePolicy;
  /** Hard ceiling of files collected. Defaults to 5000. */
  maxFiles?: number;
  /** Depth ceiling, as a guard against pathological trees. Defaults to 32. */
  maxDepth?: number;
}

const BINARY_SNIFF_BYTES = 8192;

/** Scan a workspace tree for capturable files. */
export function scanWorkspace(root: string, options: ScanOptions): ScanResult {
  const maxFiles = options.maxFiles ?? 5000;
  const maxDepth = options.maxDepth ?? 32;
  const files: ScannedFile[] = [];
  const skipped: SkippedPath[] = [];
  let truncated = false;

  const walk = (dir: string, depth: number): void => {
    if (truncated) return;
    if (depth > maxDepth) {
      skipped.push({ relPath: toPosixPath(relative(root, dir)), reason: 'depth-limit' });
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      skipped.push({ relPath: toPosixPath(relative(root, dir)), reason: `unreadable-directory: ${errorCode(error)}` });
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      const absPath = join(dir, entry.name);
      const relPath = toPosixPath(relative(root, absPath));
      if (entry.isSymbolicLink()) {
        skipped.push({ relPath, reason: 'symlink' });
        continue;
      }
      if (entry.isDirectory()) {
        const decision = options.policy.check(`${relPath}/placeholder`);
        if (decision.ignored) {
          skipped.push({ relPath, reason: `directory:${decision.reason ?? 'ignored'}` });
          continue;
        }
        walk(absPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        skipped.push({ relPath, reason: 'not-a-regular-file' });
        continue;
      }
      let size: number;
      try {
        size = lstatSync(absPath).size;
      } catch (error) {
        skipped.push({ relPath, reason: `unreadable: ${errorCode(error)}` });
        continue;
      }
      const decision = options.policy.check(relPath, size);
      if (decision.ignored) {
        skipped.push({ relPath, reason: decision.reason ?? 'ignored' });
        continue;
      }
      let kind: CapturedKind = 'text';
      try {
        const head = readHead(absPath, BINARY_SNIFF_BYTES);
        if (looksBinary(head)) kind = 'binary';
      } catch {
        kind = 'unreadable';
      }
      files.push({ absPath, relPath, size, kind });
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
    }
  };

  walk(root, 0);
  return { files, skipped, truncated };
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String((error as { code?: unknown }).code ?? 'unknown');
  }
  return error instanceof Error ? error.message : 'unknown';
}

