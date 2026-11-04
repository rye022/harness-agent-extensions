/**
 * Store tests: de-duplication, scoped recall, FTS ranking, pruning.
 *
 * These run against a real `node:sqlite` database (`:memory:`), so a broken
 * schema or a bad MATCH expression fails here instead of in a live turn.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { ContextStore } from '../src/core/store.ts'
import type { MemoryScope } from '../src/core/types.ts'

const workspace: MemoryScope = { kind: 'workspace', id: 'ws_test' }
const other: MemoryScope = { kind: 'workspace', id: 'ws_other' }
const session: MemoryScope = { kind: 'session', id: 's_test' }

function open(): ContextStore {
  return new ContextStore({ path: ':memory:', now: () => 1_700_000_000_000 })
}

test('remember stores a record and reports it through stats', () => {
  const store = open()
  const record = store.remember({ layer: 'L2', kind: 'decision', scope: workspace, title: 'Use SQLite FTS5', body: 'No native deps.' })
  assert.match(record.id, /^mem_/)
  assert.equal(record.layer, 'L2')
  assert.equal(record.kind, 'decision')
  const stats = store.stats()
  assert.equal(stats.total, 1)
  assert.equal(stats.byLayer.L2, 1)
  store.close()
})

test('identical memories de-duplicate and keep the higher importance', () => {
  const store = open()
  const input = { layer: 'L2', kind: 'contract', scope: workspace, title: 'tm_restore refuses conflicts', body: 'unless force' } as const
  const first = store.remember({ ...input, importance: 1 })
  const second = store.remember({ ...input, importance: 3 })
  assert.equal(second.id, first.id)
  assert.equal(second.importance, 3)
  assert.equal(store.stats().total, 1)
  store.close()
})

test('recall ranks a Chinese keyword hit and keeps scopes apart', () => {
  const store = open()
  store.remember({ layer: 'L2', kind: 'note', scope: workspace, title: '鬼畜视频清单', body: '张麻子鹅城FUNK 三百八十三万播放' })
  store.remember({ layer: 'L2', kind: 'note', scope: other, title: 'unrelated', body: 'nothing to do with the query' })
  const hits = store.recall({ text: '鬼畜', scope: workspace })
  assert.equal(hits.length, 1)
  assert.equal(hits[0]?.record.title, '鬼畜视频清单')
  assert.equal(store.recall({ text: '鬼畜', scope: other }).length, 0)
  store.close()
})

test('recall without text orders by importance then recency', () => {
  const store = open()
  store.remember({ layer: 'L2', kind: 'note', scope: workspace, title: 'low', body: 'b', importance: 1 })
  store.remember({ layer: 'L2', kind: 'note', scope: workspace, title: 'high', body: 'b', importance: 3 })
  const hits = store.recall({ scope: workspace })
  assert.equal(hits[0]?.record.title, 'high')
  store.close()
})

test('expired memories are hidden unless explicitly included', () => {
  let now = 1_000
  const store = new ContextStore({ path: ':memory:', now: () => now })
  store.remember({ layer: 'L1', kind: 'file', scope: session, title: 'a.ts', body: 'edited', ttlMs: 100 })
  assert.equal(store.recall({ scope: session }).length, 1)
  now += 200
  assert.equal(store.recall({ scope: session }).length, 0)
  assert.equal(store.recall({ scope: session, includeExpired: true }).length, 1)
  store.close()
})

test('markStale hides records from recall until includeStale', () => {
  const store = open()
  store.remember({ layer: 'L2', kind: 'note', scope: workspace, title: 'x', body: 'y' })
  assert.equal(store.markStale(workspace), 1)
  assert.equal(store.stats().stale, 1)
  assert.equal(store.recall({ scope: workspace }).length, 0)
  assert.equal(store.recall({ scope: workspace, includeStale: true }).length, 1)
  store.close()
})

test('forget removes a record and its index row', () => {
  const store = open()
  const record = store.remember({ layer: 'L2', kind: 'note', scope: workspace, title: 'temp', body: 'x' })
  assert.equal(store.forget(record.id), true)
  assert.equal(store.forget(record.id), false)
  assert.equal(store.recall({ text: 'temp', scope: workspace }).length, 0)
  store.close()
})

test('prune drops expired rows and enforces maxRecords', () => {
  let now = 1_000
  const store = new ContextStore({ path: ':memory:', now: () => now })
  store.remember({ layer: 'L1', kind: 'file', scope: session, title: 'gone', body: 'x', ttlMs: 10 })
  now += 50
  for (let index = 0; index < 5; index += 1) {
    store.remember({ layer: 'L2', kind: 'note', scope: workspace, title: `n${String(index)}`, body: 'x' })
  }
  const removed = store.prune({ maxRecords: 2 })
  assert.equal(removed.removed, 4)
  assert.equal(store.stats().total, 2)
  store.close()
})

test('a malformed MATCH expression falls back to LIKE instead of throwing', () => {
  const store = open()
  store.remember({ layer: 'L2', kind: 'note', scope: workspace, title: 'quote " test', body: 'ünïcode' })
  const hits = store.recall({ text: '"', scope: workspace })
  assert.ok(Array.isArray(hits))
  store.close()
})

test('a v0 database is migrated in place and keeps its rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'co-migrate-'))
  const file = join(dir, 'legacy.db')
  try {
    // Shape of the first release: no tags/source/importance/expiry/stale/content_hash.
    const legacy = new DatabaseSync(file)
    legacy.exec(`
      CREATE TABLE memories (
        id         TEXT PRIMARY KEY,
        layer      TEXT NOT NULL,
        kind       TEXT NOT NULL,
        scope_kind TEXT NOT NULL,
        scope_id   TEXT NOT NULL,
        title      TEXT NOT NULL,
        body       TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO memories VALUES ('mem_legacy', 'L2', 'decision', 'workspace', 'ws_test',
        'SQLite FTS5', 'chosen over a vector store', 1, 1);
      PRAGMA user_version = 0;
    `)
    legacy.close()

    const store = new ContextStore({ path: file, now: () => 1_700_000_000_000 })
    // The row survived, the missing columns exist, and its text is searchable.
    const record = store.get('mem_legacy')
    assert.equal(record?.title, 'SQLite FTS5')
    assert.equal(record?.importance, 1)
    assert.equal(record?.source.kind, 'manual')
    assert.deepEqual(store.recall({ text: 'vector', scope: workspace }).map((hit) => hit.record.id), ['mem_legacy'])
    // And the migrated table accepts new writes, including de-duplication.
    const fresh = store.remember({ layer: 'L2', kind: 'note', scope: workspace, title: 'new', body: 'row' })
    assert.equal(store.remember({ layer: 'L2', kind: 'note', scope: workspace, title: 'new', body: 'row' }).id, fresh.id)
    store.close()

    // Re-opening a migrated database is a no-op, not a second migration.
    const again = new ContextStore({ path: file })
    assert.equal(again.stats().total, 2)
    again.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a database from a newer build is refused instead of being rewritten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'co-future-'))
  const file = join(dir, 'future.db')
  try {
    const future = new DatabaseSync(file)
    future.exec('CREATE TABLE memories (id TEXT PRIMARY KEY); PRAGMA user_version = 99;')
    future.close()
    assert.throws(
      () => new ContextStore({ path: file }),
      /schema v99 is newer than this build \(v1\)/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unknown layer is rejected instead of being stored', () => {
  const store = new ContextStore({ path: ':memory:' })
  try {
    assert.throws(
      () =>
        store.remember({
          layer: 'session' as never,
          kind: 'progress',
          scope: { kind: 'workspace', id: 'ws_x' },
          title: 'coding task failed',
          body: 'a caller that confused layer with scope',
        }),
      /invalid memory layer "session"/,
    )
    assert.equal(store.stats().total, 0)
  } finally {
    store.close()
  }
})
