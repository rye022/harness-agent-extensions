/**
 * Benchmark: context-os brief construction — the cooperative half of compression.
 *
 * What is measured, and why it matters:
 *   - coverage@budget: of the records an agent must not lose (the user request,
 *     open errors, decisions), how many survive a brief capped at N tokens?
 *     This is the honest proxy for "task completion after compaction": the brief
 *     is the only channel through which pre-compaction facts reach the model.
 *   - compression ratio: full corpus tokens / brief tokens at the same budget.
 *   - latency: building a brief must be cheap enough to run before every turn.
 *   - budget decisions: which mode injects at which pressure (a table, not a
 *     pass/fail number, because the thresholds are policy).
 *
 * Run: `node benchmarks/bench-brief.ts`
 */
import { ContextStore } from '../packages/context-os/src/core/store.ts'
import { buildBrief } from '../packages/context-os/src/core/brief.ts'
import { decideBudget, resolveProfile } from '../packages/context-os/src/core/budget.ts'
import { estimateTokens } from '../packages/shared/src/index.ts'
import { makeTempDir, removeDir, nowMs, round, percentile, prng } from './lib/fixture.ts'
import type { BenchResult } from './lib/fixture.ts'
import type { BudgetMode, MemoryScope } from '../packages/context-os/src/core/types.ts'

export async function run(): Promise<BenchResult> {
  const dir = makeTempDir('co-brief')
  const store = new ContextStore({ path: `${dir}/context.db` })
  const session: MemoryScope = { kind: 'session', id: 's_bench' }
  const workspace: MemoryScope = { kind: 'workspace', id: 'ws_bench000001' }
  const globalScope: MemoryScope = { kind: 'global', id: 'global' }
  const cases: BenchResult['cases'] = []
  const notes: string[] = []
  try {
    const rand = prng(23)
    const criticalIds: string[] = []
    let corpusTokens = 0

    const critical: Array<{ layer: 'L1' | 'L2'; kind: 'user-request' | 'error' | 'decision' | 'file'; scope: MemoryScope; title: string }> = [
      { layer: 'L1', kind: 'user-request', scope: session, title: 'user asked for offline DM replies' },
      { layer: 'L1', kind: 'error', scope: session, title: 'typecheck fails in packages/context-os/src/core/store.ts' },
      { layer: 'L1', kind: 'file', scope: session, title: 'editing packages/shared/src/diff.ts' },
      { layer: 'L2', kind: 'decision', scope: workspace, title: 'use node:sqlite FTS5, no embedding API' },
      { layer: 'L2', kind: 'decision', scope: workspace, title: 'restore requires force when the plan is unsafe' },
      { layer: 'L2', kind: 'decision', scope: workspace, title: 'never start a second compaction loop' },
      { layer: 'L2', kind: 'file', scope: workspace, title: 'capture before fs/write-intent resolves' },
      { layer: 'L2', kind: 'error', scope: workspace, title: 'profile add fails with ERR_PNPM_FETCH_404 until overrides' },
    ]
    critical.forEach((c) => {
      const body = `${c.title}. Pinned detail: ${c.kind} must survive compression because losing it changes the task.`
      const record = store.remember({ layer: c.layer, kind: c.kind, scope: c.scope, title: c.title, body, importance: 3 })
      criticalIds.push(record.id)
      corpusTokens += estimateTokens(`${c.title}\n${body}`)
    })

    const filler = ['checkpoint', 'restore', 'context', 'session', 'plugin', 'budget', 'retrieval', 'workspace']
    for (let i = 0; i < 600; i += 1) {
      const word = filler[Math.floor(rand() * filler.length)]!
      const title = `${word} progress note ${i}`
      const body = `${word} filler body ${i} that should mostly be left out of a tight brief.`
      store.remember({
        layer: i % 3 === 0 ? 'L3' : 'L2',
        kind: i % 4 === 0 ? 'progress' : 'note',
        scope: i % 5 === 0 ? globalScope : workspace,
        title,
        body,
        importance: (i % 3) as 0 | 1 | 2,
      })
      corpusTokens += estimateTokens(`${title}\n${body}`)
    }

    for (const budget of [300, 900, 3000]) {
      const latencies: number[] = []
      let brief = buildBrief(store, { scope: [session, workspace, globalScope], query: 'store.ts typecheck', maxTokens: budget })
      for (let i = 0; i < 10; i += 1) {
        const started = nowMs()
        brief = buildBrief(store, { scope: [session, workspace, globalScope], query: 'store.ts typecheck', maxTokens: budget })
        latencies.push(nowMs() - started)
      }
      const covered = criticalIds.filter((id) => brief.recordIds.includes(id)).length
      cases.push({
        label: `critical coverage @ ${budget} tokens`,
        value: round(covered / criticalIds.length, 4),
        unit: 'ratio',
        min: budget >= 900 ? 0.75 : 0.25,
        detail: `${covered}/${criticalIds.length} critical records, ${brief.tokens} tokens used, truncated=${brief.truncated}, ratio ${round(corpusTokens / Math.max(1, brief.tokens), 1)}x`,
      })
      cases.push({
        label: `build brief @ ${budget} tokens (p50)`,
        value: round(percentile(latencies, 50), 3),
        unit: 'ms',
        max: 100,
        detail: `p95 ${round(percentile(latencies, 95), 3)} ms; sections ${brief.sections.map((s) => `${s.title}(${s.lines.length})`).join(', ')}`,
      })
    }

    let wide = buildBrief(store, { scope: [session, workspace, globalScope], maxTokens: 100_000 })
    const wideStart = nowMs()
    for (let i = 0; i < 5; i += 1) wide = buildBrief(store, { scope: [session, workspace, globalScope], maxTokens: 100_000 })
    const wideMs = (nowMs() - wideStart) / 5
    cases.push({
      label: 'build brief, unbounded budget (p50)',
      value: round(wideMs, 3),
      unit: 'ms',
      max: 200,
      detail: `${wide.tokens} tokens, ${wide.recordIds.length} records, corpus≈${corpusTokens} tokens`,
    })

    const decisions: string[] = []
    for (const mode of ['conservative', 'balanced', 'saver'] as BudgetMode[]) {
      const profile = resolveProfile({ mode, windowTokens: 131_072 })
      const row: string[] = []
      // 91_751 rather than 131_072 * 0.7 (= 91_750.4) so the "70%" column is
      // genuinely at-or-above the balanced threshold instead of a rounding artefact.
      for (const used of [32_768, 65_536, 91_751, 120_000]) {
        const decision = decideBudget(
          { totalTokens: used, basis: 'estimated', revision: 1 },
          { mode, windowTokens: 131_072 },
        )
        row.push(`${Math.round((used / 131_072) * 100)}%→${decision.injectBrief ? `inject:${decision.briefTokens}` : 'skip'}`)
      }
      decisions.push(`${mode} (threshold ${profile.threshold}, cap ${profile.briefCapTokens}): ${row.join(' ')}`)
    }
    notes.push(...decisions)

    return { name: 'context-os / brief', cases, notes }
  } finally {
    store.close()
    removeDir(dir)
  }
}
