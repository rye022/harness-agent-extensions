/**
 * SQLite-backed memory store (node:sqlite, no native dependency).
 *
 * Design notes:
 * - One database per install (`<DSH_HOME>/context-os/context.db`) rather than
 *   one per session: L2/L3 memories must survive sessions and workspaces, and
 *   scope columns keep the namespaces apart.
 * - FTS5 is used for text recall; the index row is rewritten whenever a record
 *   changes, and `memories_fts` duplicates the search text instead of using an
 *   external-content table. That is a little more storage and a lot fewer
 *   triggers to get wrong.
 * - Every write is synchronous: the store is small (thousands of rows), and a
 *   synchronous API removes a whole class of race conditions from the plugin.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import type {
  MemoryKind,
  MemoryLayer,
  MemoryRecord,
  MemoryScope,
  RecallHit,
  RecallQuery,
  RememberInput,
} from './types.ts'
import { toMatchQuery, toSearchText } from './tokenize.ts'

/** Minimum SQLite schema version this build writes. */
export const CONTEXT_OS_SCHEMA = 1

/** Row shape as returned by SQLite. */
interface MemoryRow {
  id: string
  layer: string
  kind: string
  scope_kind: string
  scope_id: string
  title: string
  body: string
  tags: string
  source_kind: string
  source_ref: string | null
  importance: number
  created_at: number
  updated_at: number
  expires_at: number | null
  stale: number
  content_hash: string
}

export interface StoreOptions {
  /** Database file path, or `':memory:'` for tests. */
  path: string
  /** Injectable clock for deterministic tests. */
  now?: () => number
}

/** Counts per layer, plus database size. */
export interface StoreStats {
  total: number
  byLayer: Record<MemoryLayer, number>
  byKind: Partial<Record<MemoryKind, number>>
  expired: number
  stale: number
  bytes: number
  path: string
}

/** Compute the stable content hash used for de-duplication. */
export function memoryHash(input: Pick<RememberInput, 'layer' | 'kind' | 'scope' | 'title' | 'body'>): string {
  return createHash('sha256')
    .update(`${input.layer}|${input.kind}|${input.scope.kind}:${input.scope.id}|${input.title}|${input.body}`)
    .digest('hex')
}

/** Generate a sortable id: `mem_<base36 time>_<8 hex>`. */
export function newMemoryId(now: number, random: () => number = Math.random): string {
  const suffix = Math.floor(random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0')
  return `mem_${now.toString(36)}_${suffix}`
}

/**
 * Durable memory store.
 *
 * All methods are synchronous. The class never throws on malformed query text:
 * a broken MATCH expression falls back to a LIKE scan, because losing a recall
 * must never break a turn.
 */
export class ContextStore {
  private readonly db: DatabaseSync
  private readonly now: () => number
  private readonly path: string

  constructor(options: StoreOptions) {
    this.path = options.path
    this.now = options.now ?? (() => Date.now())
    if (this.path !== ':memory:') mkdirSync(join(this.path, '..'), { recursive: true })
    this.db = new DatabaseSync(this.path)
    try {
      this.db.exec('PRAGMA journal_mode = WAL')
      this.db.exec('PRAGMA synchronous = NORMAL')
      this.migrate()
    } catch (error) {
      // A refused/failed migration must not leak the handle: on Windows an open
      // SQLite file cannot even be deleted by the caller that is handling it.
      this.db.close()
      throw error
    }
  }

  /** Create or upgrade the schema, refusing a database from a newer build. */
  private migrate(): void {
    const version = this.schemaVersion()
    if (version > CONTEXT_OS_SCHEMA) {
      throw new Error(
        `context-os database schema v${String(version)} is newer than this build (v${String(CONTEXT_OS_SCHEMA)}); ` +
          'upgrade @harness-ext/context-os, or point config.dbFile at a different file',
      )
    }
    this.createTable()
    this.addLegacyColumns()
    this.createIndexes()
    // A v0 database has no FTS rows yet; rebuild the index for everything found.
    if (version < CONTEXT_OS_SCHEMA) this.reindexAll()
    this.db.exec(`PRAGMA user_version = ${String(CONTEXT_OS_SCHEMA)}`)
  }

  /** Current `PRAGMA user_version` (0 for a database written before v1 existed). */
  private schemaVersion(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
    return Number(row?.user_version ?? 0)
  }

  private createTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id           TEXT PRIMARY KEY,
        layer        TEXT NOT NULL,
        kind         TEXT NOT NULL,
        scope_kind   TEXT NOT NULL,
        scope_id     TEXT NOT NULL,
        title        TEXT NOT NULL,
        body         TEXT NOT NULL,
        tags         TEXT NOT NULL DEFAULT '',
        source_kind  TEXT NOT NULL,
        source_ref   TEXT,
        importance   INTEGER NOT NULL DEFAULT 1,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        expires_at   INTEGER,
        stale        INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL
      );
    `)
  }

  /**
   * Add columns that a v0 table lacks.
   *
   * `CREATE TABLE IF NOT EXISTS` cannot widen an existing table, so a database
   * written by an earlier build would otherwise keep its old column set and fail
   * on the first insert. `content_hash` stays unique by giving legacy rows a
   * synthetic per-id hash before the unique index is created.
   */
  private addLegacyColumns(): void {
    const rows = this.db.prepare('PRAGMA table_info(memories)').all() as { name: string }[]
    const have = new Set(rows.map((row) => row.name))
    const missing: [string, string][] = [
      ['tags', "TEXT NOT NULL DEFAULT ''"],
      ['source_kind', "TEXT NOT NULL DEFAULT 'manual'"],
      ['source_ref', 'TEXT'],
      ['importance', 'INTEGER NOT NULL DEFAULT 1'],
      ['expires_at', 'INTEGER'],
      ['stale', 'INTEGER NOT NULL DEFAULT 0'],
      ['content_hash', "TEXT NOT NULL DEFAULT ''"],
    ]
    let changed = false
    for (const [name, ddl] of missing) {
      if (have.has(name)) continue
      this.db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${ddl}`)
      changed = true
    }
    if (changed || !have.has('content_hash')) {
      this.db.exec(`UPDATE memories SET content_hash = 'legacy:' || id WHERE content_hash = '' OR content_hash IS NULL`)
    }
  }

  private createIndexes(): void {
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS memories_dedupe
        ON memories (content_hash, scope_kind, scope_id);
      CREATE INDEX IF NOT EXISTS memories_scope ON memories (scope_kind, scope_id, layer);
      CREATE INDEX IF NOT EXISTS memories_updated ON memories (updated_at DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
        USING fts5(memory_id UNINDEXED, search_text, tokenize = 'unicode61 remove_diacritics 2');
    `)
  }

  /** Rebuild every FTS row from the table (used when upgrading a v0 database). */
  private reindexAll(): void {
    const rows = this.db
      .prepare(
        `SELECT m.id AS id, m.title AS title, m.body AS body
           FROM memories m
          WHERE NOT EXISTS (SELECT 1 FROM memories_fts f WHERE f.memory_id = m.id)`,
      )
      .all() as { id: string; title: string; body: string }[]
    for (const row of rows) this.reindex(row.id, row.title, row.body)
  }

  /** Insert or refresh a memory; returns the stored record. */
  remember(input: RememberInput): MemoryRecord {
    const now = this.now()
    const hash = memoryHash(input)
    const existing = this.db
      .prepare('SELECT * FROM memories WHERE content_hash = ? AND scope_kind = ? AND scope_id = ?')
      .get(hash, input.scope.kind, input.scope.id) as MemoryRow | undefined

    const expiresAt = input.ttlMs === undefined ? null : now + input.ttlMs
    if (existing !== undefined) {
      const importance = Math.max(existing.importance, input.importance ?? 1)
      const tags = mergeTags(existing.tags, input.tags)
      this.db
        .prepare('UPDATE memories SET updated_at = ?, importance = ?, tags = ?, expires_at = ?, stale = 0 WHERE id = ?')
        .run(now, importance, tags, expiresAt, existing.id)
      this.reindex(existing.id, existing.title, existing.body)
      return this.get(existing.id) as MemoryRecord
    }

    const id = input.key ?? newMemoryId(now)
    const record: MemoryRecord = {
      id,
      layer: input.layer,
      kind: input.kind,
      scope: input.scope,
      title: clampText(input.title, 300),
      body: clampText(input.body, 20_000),
      tags: input.tags ?? [],
      source: input.source ?? { kind: 'manual' },
      importance: clampImportance(input.importance ?? 1),
      createdAt: now,
      updatedAt: now,
      contentHash: hash,
    }
    if (expiresAt !== null) record.expiresAt = expiresAt
    const sourceRef = record.source.ref ?? null
    this.db
      .prepare(
        `INSERT INTO memories
          (id, layer, kind, scope_kind, scope_id, title, body, tags, source_kind, source_ref,
           importance, created_at, updated_at, expires_at, stale, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title, body = excluded.body, tags = excluded.tags,
           source_kind = excluded.source_kind, source_ref = excluded.source_ref,
           importance = excluded.importance, updated_at = excluded.updated_at,
           expires_at = excluded.expires_at, stale = 0`,
      )
      .run(
        record.id,
        record.layer,
        record.kind,
        record.scope.kind,
        record.scope.id,
        record.title,
        record.body,
        record.tags.join(','),
        record.source.kind,
        sourceRef,
        record.importance,
        record.createdAt,
        record.updatedAt,
        expiresAt,
        hash,
      )
    this.reindex(record.id, record.title, record.body)
    return record
  }

  /** Rewrite the FTS row for one memory. */
  private reindex(id: string, title: string, body: string): void {
    this.db.prepare('DELETE FROM memories_fts WHERE memory_id = ?').run(id)
    this.db
      .prepare('INSERT INTO memories_fts (memory_id, search_text) VALUES (?, ?)')
      .run(id, `${toSearchText(title)}\n${toSearchText(body)}`)
  }

  /** Fetch one record by id, expired or not. */
  get(id: string): MemoryRecord | undefined {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined
    return row === undefined ? undefined : rowToRecord(row)
  }

  /** Delete a record and its index row. */
  forget(id: string): boolean {
    const info = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM memories_fts WHERE memory_id = ?').run(id)
    return info.changes > 0
  }

  /** Flag records whose underlying state may have been rolled back. */
  markStale(scope: MemoryScope, kinds?: MemoryKind[]): number {
    const now = this.now()
    if (kinds === undefined) {
      const info = this.db
        .prepare('UPDATE memories SET stale = 1, updated_at = ? WHERE scope_kind = ? AND scope_id = ?')
        .run(now, scope.kind, scope.id)
      return Number(info.changes)
    }
    let total = 0
    for (const kind of kinds) {
      const info = this.db
        .prepare('UPDATE memories SET stale = 1, updated_at = ? WHERE scope_kind = ? AND scope_id = ? AND kind = ?')
        .run(now, scope.kind, scope.id, kind)
      total += Number(info.changes)
    }
    return total
  }

  /**
   * Score and return memories.
   *
   * Scoring = FTS5 bm25 (negated, so higher is better) 脳 importance boost 脳
   * recency boost. Without a text query the ranking is purely
   * importance/recency, which is what the brief wants.
   */
  recall(query: RecallQuery = {}): RecallHit[] {
    const limit = Math.max(1, Math.min(query.limit ?? 20, 200))
    const now = this.now()
    const filters: string[] = []
    const params: (string | number)[] = []
    if (query.scope !== undefined) {
      filters.push('m.scope_kind = ? AND m.scope_id = ?')
      params.push(query.scope.kind, query.scope.id)
    }
    if (query.layers !== undefined && query.layers.length > 0) {
      filters.push(`m.layer IN (${query.layers.map(() => '?').join(', ')})`)
      params.push(...query.layers)
    }
    if (query.kinds !== undefined && query.kinds.length > 0) {
      filters.push(`m.kind IN (${query.kinds.map(() => '?').join(', ')})`)
      params.push(...query.kinds)
    }
    if (query.minImportance !== undefined) {
      filters.push('m.importance >= ?')
      params.push(query.minImportance)
    }
    if (query.includeExpired !== true) {
      filters.push('(m.expires_at IS NULL OR m.expires_at > ?)')
      params.push(now)
    }
    if (query.includeStale !== true) filters.push('m.stale = 0')

    const match = query.text === undefined || query.text.trim() === '' ? undefined : toMatchQuery(query.text)
    if (match !== undefined) {
      const where = filters.length === 0 ? '' : ` AND ${filters.join(' AND ')}`
      try {
        const rows = this.db
          .prepare(
            `SELECT m.*, bm25(memories_fts) AS rank
               FROM memories_fts
               JOIN memories m ON m.id = memories_fts.memory_id
              WHERE memories_fts MATCH ?${where}
              ORDER BY rank
              LIMIT ?`,
          )
          .all(match, ...params, limit * 4) as unknown as (MemoryRow & { rank: number })[]
        return rankHits(rows, now, limit, 'fts')
      } catch {
        // Malformed MATCH (or an FTS build without the tokenizer): fall through
        // to the LIKE scan below rather than failing the caller.
      }
      const like = `%${query.text ?? ''}%`
      const whereLike = filters.length === 0 ? '' : ` AND ${filters.join(' AND ')}`
      const rows = this.db
        .prepare(
          `SELECT m.*, 0 AS rank FROM memories m
            WHERE (m.title LIKE ? OR m.body LIKE ?)${whereLike}
            ORDER BY m.importance DESC, m.updated_at DESC
            LIMIT ?`,
        )
        .all(like, like, ...params, limit * 4) as unknown as (MemoryRow & { rank: number })[]
      return rankHits(rows, now, limit, 'like')
    }

    const where = filters.length === 0 ? '' : ` WHERE ${filters.join(' AND ')}`
    const rows = this.db
      .prepare(
        `SELECT m.*, 0 AS rank FROM memories m${where}
          ORDER BY m.importance DESC, m.updated_at DESC
          LIMIT ?`,
      )
      .all(...params, limit * 4) as unknown as (MemoryRow & { rank: number })[]
    return rankHits(rows, now, limit, 'list')
  }

  /** Delete expired records and trim the oldest L1 rows beyond `maxRecords`. */
  prune(options: { maxRecords?: number; dropExpired?: boolean } = {}): { removed: number } {
    const now = this.now()
    let removed = 0
    if (options.dropExpired !== false) {
      const info = this.db.prepare('DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now)
      removed += Number(info.changes)
    }
    const maxRecords = options.maxRecords ?? 0
    if (maxRecords > 0) {
      const info = this.db
        .prepare(
          `DELETE FROM memories WHERE id IN (
             SELECT id FROM memories ORDER BY updated_at DESC LIMIT -1 OFFSET ?
           )`,
        )
        .run(maxRecords)
      removed += Number(info.changes)
    }
    // Drop index rows whose memory is gone.
    this.db.exec('DELETE FROM memories_fts WHERE memory_id NOT IN (SELECT id FROM memories)')
    return { removed }
  }

  /** Counts for the status tool and the UI panel. */
  stats(): StoreStats {
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }
    const byLayer: Record<MemoryLayer, number> = { L1: 0, L2: 0, L3: 0 }
    for (const row of this.db.prepare('SELECT layer, COUNT(*) AS n FROM memories GROUP BY layer').all() as { layer: string; n: number }[]) {
      if (row.layer === 'L1' || row.layer === 'L2' || row.layer === 'L3') byLayer[row.layer] = Number(row.n)
    }
    const byKind: Partial<Record<MemoryKind, number>> = {}
    for (const row of this.db.prepare('SELECT kind, COUNT(*) AS n FROM memories GROUP BY kind').all() as { kind: string; n: number }[]) {
      byKind[row.kind as MemoryKind] = Number(row.n)
    }
    const now = this.now()
    const expired = this.db
      .prepare('SELECT COUNT(*) AS n FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?')
      .get(now) as { n: number }
    const stale = this.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE stale = 1').get() as { n: number }
    let bytes = 0
    try {
      const pageCount = this.db.prepare('PRAGMA page_count').get() as { page_count: number } | undefined
      const pageSize = this.db.prepare('PRAGMA page_size').get() as { page_size: number } | undefined
      bytes = (pageCount?.page_count ?? 0) * (pageSize?.page_size ?? 0)
    } catch {
      bytes = 0
    }
    return {
      total: Number(total.n),
      byLayer,
      byKind,
      expired: Number(expired.n),
      stale: Number(stale.n),
      bytes,
      path: this.path,
    }
  }

  /** Close the database handle. */
  close(): void {
    try {
      this.db.close()
    } catch {
      // Already closed.
    }
  }
}

/** Combine existing and new tag lists, de-duplicated. */
function mergeTags(existing: string, incoming: string[] | undefined): string {
  const set = new Set(existing === '' ? [] : existing.split(','))
  for (const tag of incoming ?? []) {
    if (tag.trim() !== '') set.add(tag.trim())
  }
  return [...set].join(',')
}

/** Clamp importance into 0..3. */
export function clampImportance(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(0, Math.min(3, Math.round(value)))
}

/** Truncate long text on a word/character boundary. */
function clampText(text: string, max: number): string {
  const normalised = text.replace(/\r\n/g, '\n').trim()
  if (normalised.length <= max) return normalised
  return `${normalised.slice(0, max)}\n鈥?(truncated)`
}

/** Map a SQLite row to a record. */
function rowToRecord(row: MemoryRow): MemoryRecord {
  const record: MemoryRecord = {
    id: row.id,
    layer: row.layer as MemoryLayer,
    kind: row.kind as MemoryKind,
    scope: { kind: row.scope_kind as MemoryScope['kind'], id: row.scope_id },
    title: row.title,
    body: row.body,
    tags: row.tags === '' ? [] : row.tags.split(','),
    source: {
      kind: row.source_kind as MemoryRecord['source']['kind'],
      ...(row.source_ref === null ? {} : { ref: row.source_ref }),
    },
    importance: row.importance,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    contentHash: row.content_hash,
  }
  if (row.expires_at !== null) record.expiresAt = row.expires_at
  if (row.stale === 1) record.stale = true
  return record
}

/**
 * Turn raw rows into scored hits.
 *
 * bm25 in SQLite is negative (more negative = more relevant), so the FTS
 * component is `-rank`. Importance and recency are multiplicative boosts, and
 * an expired-but-included row is penalised instead of dropped.
 */
function rankHits(rows: (MemoryRow & { rank: number })[], now: number, limit: number, basis: 'fts' | 'like' | 'list'): RecallHit[] {
  const hits: RecallHit[] = []
  for (const row of rows) {
    const record = rowToRecord(row)
    const reasons: string[] = [basis]
    let score = basis === 'fts' ? Math.max(0.0001, -row.rank) : basis === 'like' ? 0.5 : 1
    const importanceBoost = 1 + 0.35 * clampImportance(record.importance)
    score *= importanceBoost
    if (record.importance > 0) reasons.push(`importance脳${importanceBoost.toFixed(2)}`)
    const ageMs = Math.max(0, now - record.updatedAt)
    const ageDays = ageMs / 86_400_000
    const recency = 1 / (1 + ageDays / 14)
    score *= recency
    reasons.push(`recency脳${recency.toFixed(2)}`)
    if (record.expiresAt !== undefined && record.expiresAt <= now) {
      score *= 0.2
      reasons.push('expired脳0.2')
    }
    if (record.stale === true) {
      score *= 0.5
      reasons.push('stale脳0.5')
    }
    hits.push({ record, score, reasons })
  }
  hits.sort((a, b) => (b.score === a.score ? b.record.updatedAt - a.record.updatedAt : b.score - a.score))
  return hits.slice(0, limit)
}
