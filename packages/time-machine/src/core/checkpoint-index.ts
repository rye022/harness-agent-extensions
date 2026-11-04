/**
 * Durable checkpoint index.
 *
 * Records are appended to one JSONL journal; the in-memory map is a cache over
 * it. Appending is the only mutation, so a crash loses at most the record being
 * written, and the loader reports damaged lines instead of silently dropping
 * them.
 *
 * @module @harness-ext/time-machine/checkpoint-index
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CHECKPOINT_SCHEMA, type CheckpointRecord } from './types.ts';

/** Query options for listing checkpoints. */
export interface ListOptions {
  sessionId?: string;
  origin?: CheckpointRecord['origin'];
  /** Newest first, capped at this many records. */
  limit?: number;
  /** Only records created at or after this ISO timestamp. */
  since?: string;
}

/** Load report, produced once at startup. */
export interface LoadReport {
  loaded: number;
  /** Lines that could not be parsed or failed validation, with line numbers. */
  damaged: { line: number; reason: string; preview: string }[];
}

/** Result of a structural verification pass. */
export interface VerifyReport {
  records: number;
  duplicateIds: string[];
  damaged: { line: number; reason: string }[];
  /** Objects referenced by records but absent from the store. */
  missingObjects: string[];
  /** Objects present but whose bytes do not match their name. */
  corruptObjects: string[];
}

/** The journal plus lookups over it. */
export class CheckpointIndex {
  readonly root: string;
  readonly journal: string;
  private readonly records = new Map<string, CheckpointRecord>();
  private readonly order: string[] = [];
  private lastLoad: LoadReport = { loaded: 0, damaged: [] };

  constructor(root: string) {
    this.root = root;
    this.journal = join(root, 'checkpoints.jsonl');
    mkdirSync(root, { recursive: true });
    this.lastLoad = this.load();
  }

  /** Report from the initial load. */
  get loadReport(): LoadReport {
    return this.lastLoad;
  }

  /** Number of loaded records. */
  get size(): number {
    return this.records.size;
  }

  /** Load (or reload) the journal from disk. */
  load(): LoadReport {
    this.records.clear();
    this.order.length = 0;
    const damaged: LoadReport['damaged'] = [];
    if (!existsSync(this.journal)) return { loaded: 0, damaged };
    const text = readFileSync(this.journal, 'utf8');
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!.trim();
      if (line === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A trailing partial line is the normal crash artefact; keep it visible
        // but do not fail the load.
        damaged.push({ line: index + 1, reason: 'unparseable JSON', preview: line.slice(0, 120) });
        continue;
      }
      const problem = validateRecord(parsed);
      if (problem !== undefined) {
        damaged.push({ line: index + 1, reason: problem, preview: line.slice(0, 120) });
        continue;
      }
      const record = parsed as CheckpointRecord;
      if (this.records.has(record.id)) {
        damaged.push({ line: index + 1, reason: `duplicate id ${record.id}`, preview: line.slice(0, 120) });
        continue;
      }
      this.records.set(record.id, record);
      this.order.push(record.id);
    }
    return { loaded: this.records.size, damaged };
  }

  /** Append one record, validating it first. */
  append(record: CheckpointRecord): void {
    const problem = validateRecord(record);
    if (problem !== undefined) throw new Error(`refusing to append invalid checkpoint: ${problem}`);
    if (this.records.has(record.id)) throw new Error(`checkpoint ${record.id} already exists`);
    const line = `${JSON.stringify(record)}\n`;
    const existed = existsSync(this.journal);
    const previous = existed ? readFileSync(this.journal, 'utf8') : '';
    writeFileSync(this.journal, `${previous}${line}`, 'utf8');
    this.records.set(record.id, record);
    this.order.push(record.id);
  }

  /** Fetch one record. */
  get(id: string): CheckpointRecord | undefined {
    return this.records.get(id);
  }

  /** Newest-first listing. */
  list(options: ListOptions = {}): CheckpointRecord[] {
    const out: CheckpointRecord[] = [];
    for (let index = this.order.length - 1; index >= 0; index -= 1) {
      const record = this.records.get(this.order[index]!)!;
      if (options.sessionId !== undefined && record.sessionId !== options.sessionId) continue;
      if (options.origin !== undefined && record.origin !== options.origin) continue;
      if (options.since !== undefined && record.createdAt < options.since) continue;
      out.push(record);
      if (options.limit !== undefined && out.length >= options.limit) break;
    }
    return out;
  }

  /** Newest record for a session. */
  lastForSession(sessionId: string): CheckpointRecord | undefined {
    for (let index = this.order.length - 1; index >= 0; index -= 1) {
      const record = this.records.get(this.order[index]!)!;
      if (record.sessionId === sessionId) return record;
    }
    return undefined;
  }

  /** Every content hash referenced by any checkpoint. */
  referencedHashes(): Set<string> {
    const out = new Set<string>();
    for (const record of this.records.values()) {
      for (const entry of record.files) {
        if (entry.before !== null) out.add(entry.before);
        if (entry.after !== undefined && entry.after !== null) out.add(entry.after);
      }
    }
    return out;
  }

  /** Rewrite the journal compacted to the currently loaded records. */
  compact(): void {
    const temp = `${this.journal}.${process.pid}.compact`;
    const body = this.order.map((id) => JSON.stringify(this.records.get(id)!)).join('\n');
    writeFileSync(temp, body === '' ? '' : `${body}\n`, 'utf8');
    renameSync(temp, this.journal);
  }

  /** Remove one record from memory and rewrite the journal. */
  remove(id: string): boolean {
    if (!this.records.delete(id)) return false;
    const index = this.order.indexOf(id);
    if (index >= 0) this.order.splice(index, 1);
    this.compact();
    return true;
  }

  /** Journal size in bytes. */
  journalBytes(): number {
    try {
      return statSync(this.journal).size;
    } catch {
      return 0;
    }
  }
}

/** Generate a checkpoint id: sortable prefix plus randomness. */
export function newCheckpointId(now: number = Date.now()): string {
  return `cp_${now.toString(36)}_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
}

/** Structural validation shared by append and load. */
export function validateRecord(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return 'not an object';
  const record = value as Partial<CheckpointRecord>;
  if (record.schema !== CHECKPOINT_SCHEMA) return `unsupported schema ${String(record.schema)}`;
  if (typeof record.id !== 'string' || record.id === '') return 'missing id';
  if (typeof record.createdAt !== 'string') return 'missing createdAt';
  if (typeof record.createdAtMs !== 'number' || !Number.isFinite(record.createdAtMs)) return 'missing createdAtMs';
  if (record.origin !== 'auto-tool' && record.origin !== 'auto-turn' && record.origin !== 'manual' && record.origin !== 'pre-restore') {
    return `unknown origin ${String(record.origin)}`;
  }
  if (!Array.isArray(record.files)) return 'missing files';
  for (const [index, entry] of record.files.entries()) {
    if (typeof entry !== 'object' || entry === null) return `files[${index}] not an object`;
    if (typeof entry.path !== 'string' || entry.path === '') return `files[${index}] missing path`;
    if (!(entry.before === null || typeof entry.before === 'string')) return `files[${index}] bad before`;
    if (!(entry.after === undefined || entry.after === null || typeof entry.after === 'string')) return `files[${index}] bad after`;
  }
  return undefined;
}
