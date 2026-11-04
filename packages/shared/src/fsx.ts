/**
 * Small filesystem helpers shared by the extensions.
 *
 * @module @harness-ext/shared/fsx
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Read a UTF-8 file, returning undefined when it does not exist. */
export function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/** File size, or undefined when the file does not exist. */
export function sizeOf(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/** Whether a path exists. */
export function exists(path: string): boolean {
  return existsSync(path);
}

/** Whether an error means "the file is not there". */
export function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ENOENT';
}

/** Read at most `limit` bytes from the start of a file (for binary sniffing). */
export function readHead(path: string, limit: number): Uint8Array {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(limit);
    const read = readSync(fd, buffer, 0, limit, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** Write a file atomically: write a sibling temp file, then rename over the target. */
export function writeAtomic(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

/** Create a directory tree. */
export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** Join path segments and normalise them. */
export function safeJoin(...segments: string[]): string {
  return join(...segments);
}
