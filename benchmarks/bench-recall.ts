/**
 * Benchmark: context-os retrieval quality and latency on a seeded corpus.
 *
 * The corpus is deliberately adversarial in the cheap way: 1 200 filler memories
 * share the vocabulary with the 40 targets, and every target carries one unique
 * token (Latin identifier or Chinese phrase). A query for that token must return
 * its record in the top 5; if it does not, ranking is broken, not "approximate".
 *
 * Measured: hit@1, hit@5, MRR, p50/p95 latency, plus scope isolation (a query in
 * workspace A must never return a record of workspace B).
 *
 * Run: `node benchmarks/bench-recall.ts`
 */
import { ContextStore } from '../packages/context-os/src/core/store.ts'
import { makeTempDir, removeDir, nowMs, round, percentile, prng } from './lib/fixture.ts'
import type { BenchResult } from './lib/fixture.ts'
import type { MemoryScope } from '../packages/context-os/src/core/types.ts'

const FILLER_WORDS = [
  'checkpoint', 'restore', 'context', 'compaction', 'session', 'workspace', 'memory',
  'retrieval', 'budget', 'token', 'plugin', 'harness', 'sandbox', 'journal', 'digest',
]

const CN_FILLER = ['检查点', '上下文', '压缩', '记忆', '检索', '预算', '插件', '工作区']

const TARGET_TOKENS = [
  'sig_9f3ac2', 'sig_77b1de', 'sig_0c4a91', 'sig_f2e88b', 'sig_51ad03',
  'sig_be90f7', 'sig_3d6c45', 'sig_a8b712', 'sig_6e04cf', 'sig_c15927',
  'zh_紫电青霜', 'zh_孤舟蓑笠', 'zh_青鸾衔月', 'zh_铁马冰河', 'zh_雪落长街',
  'zh_断桥残雪', 'zh_暗香浮动', 'zh_月涌大江', 'zh_星垂平野', 'zh_霜刃未试',
  'sig_42e7a8', 'sig_98c50b', 'sig_d30f16', 'sig_7a12c9', 'sig_bb8e34',
  'sig_0f5d72', 'sig_e41b93', 'sig_25af60', 'sig_c08d4e', 'sig_63b9a1',
  'zh_长风破浪', 'zh_沉舟侧畔', 'zh_千帆过尽', 'zh_病树前头', 'zh_万木春深',
  'zh_山高水长', 'zh_风正帆悬', 'zh_潮平岸阔', 'zh_海日生残', 'zh_江春入旧',
]

export async function run(): Promise<BenchResult> {
  const dir = makeTempDir('co-bench')
  const dbPath = `${dir}/context.db`
  const store = new ContextStore({ path: dbPath })
  const scopeA: MemoryScope = { kind: 'workspace', id: 'ws_aaaaaaaaaaaa' }
  const scopeB: MemoryScope = { kind: 'workspace', id: 'ws_bbbbbbbbbbbb' }
  const cases: BenchResult['cases'] = []
  const notes: string[] = []
  try {
    const rand = prng(11)
    const rememberStart = nowMs()
    for (let i = 0; i < 1200; i += 1) {
      const latin = FILLER_WORDS[Math.floor(rand() * FILLER_WORDS.length)]!
      const chinese = CN_FILLER[Math.floor(rand() * CN_FILLER.length)]!
      store.remember({
        layer: 'L2',
        kind: i % 5 === 0 ? 'decision' : i % 3 === 0 ? 'progress' : 'note',
        scope: i % 4 === 0 ? scopeB : scopeA,
        title: `${latin} note ${i}`,
        body: `${latin} ${chinese} detail for record ${i}; ${latin} keeps the corpus realistic.`,
        tags: [latin],
        importance: (i % 4) as 0 | 1 | 2 | 3,
      })
    }

    const targetIds: string[] = []
    TARGET_TOKENS.forEach((token, i) => {
      const record = store.remember({
        layer: 'L2',
        kind: i % 2 === 0 ? 'decision' : 'contract',
        scope: i % 6 === 0 ? scopeB : scopeA,
        title: `target ${token}`,
        body: `This record is the only place that mentions ${token}. context checkpoint memory retrieval budget.`,
        tags: ['target'],
        importance: 3,
      })
      targetIds.push(record.id)
    })
    const rememberMs = nowMs() - rememberStart

    cases.push({
      label: `seed ${1200 + TARGET_TOKENS.length} memories`,
      value: round(rememberMs),
      unit: 'ms',
      max: 30000,
      detail: `${round(rememberMs / (1200 + TARGET_TOKENS.length), 3)} ms/record`,
    })

    const latencies: number[] = []
    let hit1 = 0
    let hit5 = 0
    let reciprocal = 0
    const misses: string[] = []
    TARGET_TOKENS.forEach((token, i) => {
      const started = nowMs()
      const hits = store.recall({ text: token, limit: 5 })
      latencies.push(nowMs() - started)
      const expected = targetIds[i]!
      const rank = hits.findIndex((hit) => hit.record.id === expected)
      if (rank === 0) hit1 += 1
      if (rank >= 0 && rank < 5) hit5 += 1
      if (rank >= 0) reciprocal += 1 / (rank + 1)
      if (rank < 0) misses.push(token)
    })
    const total = TARGET_TOKENS.length
    cases.push({
      label: `hit@1 over ${total} unique-token queries`,
      value: round(hit1 / total, 4),
      unit: 'ratio',
      min: 0.8,
      detail: `${hit1}/${total}`,
    })
    cases.push({
      label: 'hit@5',
      value: round(hit5 / total, 4),
      unit: 'ratio',
      min: 0.95,
      detail: `${hit5}/${total}${misses.length ? ` misses: ${misses.slice(0, 3).join(', ')}` : ''}`,
    })
    cases.push({
      label: 'MRR',
      value: round(reciprocal / total, 4),
      unit: 'ratio',
      min: 0.85,
      detail: 'mean reciprocal rank',
    })
    cases.push({
      label: 'recall latency p50',
      value: round(percentile(latencies, 50), 3),
      unit: 'ms',
      max: 50,
      detail: `p95 ${round(percentile(latencies, 95), 3)} ms`,
    })

    // Scope isolation: same token vocabulary, two workspaces.
    store.remember({
      layer: 'L2', kind: 'decision', scope: scopeA,
      title: 'isolation probe A', body: 'scope-isolation-probe alpha payload', importance: 3,
    })
    store.remember({
      layer: 'L2', kind: 'decision', scope: scopeB,
      title: 'isolation probe B', body: 'scope-isolation-probe beta payload', importance: 3,
    })
    const scopedA = store.recall({ text: 'scope-isolation-probe', scope: scopeA, limit: 10 })
    const leaked = scopedA.filter((hit) => hit.record.scope.id !== scopeA.id).length
    cases.push({
      label: 'scope leak (records from another workspace in a scoped query)',
      value: leaked,
      unit: 'count',
      max: 0,
      detail: `${scopedA.length} hits in scope A`,
    })

    const stats = store.stats()
    notes.push(`store stats: ${JSON.stringify(stats)}`)
    notes.push(`database file: ${(store as unknown as { path?: string }).path ?? 'n/a'}`)

    return { name: 'context-os / recall', cases, notes }
  } finally {
    store.close()
    removeDir(dir)
  }
}
