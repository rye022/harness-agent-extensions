/**
 * Append-only JSONL journals.
 *
 * Checkpoint indexes and memory stores keep their canonical history as one JSON
 * object per line. Appends are the only writes, so a crash can at worst lose the
 * final line; readers tolerate that truncated tail instead of failing the whole
 * file.
 *
 * @module @harness-ext/shared/jsonl
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Append one JSON value as a single line, creating parent directories. */
export function appendJsonl(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}

/** Read a JSONL file, skipping blank lines and a truncated final record. */
export function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf8');
  const out: T[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // A partially written last line is expected after a crash; anything else
      // is reported by the caller through its own validation.
      continue;
    }
  }
  return out;
}

/** Read only the last parseable record of a JSONL file. */
export function readLastJsonl<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const trimmed = lines[index]!.trim();
    if (trimmed === '') continue;
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      continue;
    }
  }
  return undefined;
}
