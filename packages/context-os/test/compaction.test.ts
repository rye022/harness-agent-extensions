/**
 * What survives a compaction.
 *
 * The brief asks for "task completion before and after compaction". Measuring
 * completion needs a live model, which this repository cannot call from a test,
 * so this file measures the property compaction must not break: after the
 * transcript is replaced by a summary, the facts an agent needs to finish the
 * job are still reachable — (a) inside a budgeted brief, and (b) by recall of
 * the original record.
 *
 * The scenario mirrors a real turn: a user request, a goal, an open error and a
 * file in flight, then `compaction/summary` for the whole range.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildBrief } from '../src/core/brief.ts'
import { ingestEvent } from '../src/core/ingest.ts'
import { ContextStore } from '../src/core/store.ts'
import type { MemoryScope } from '../src/core/types.ts'

const workspace: MemoryScope = { kind: 'workspace', id: 'ws_compaction' }
const session: MemoryScope = { kind: 'session', id: 's_compaction' }

const request = '把右下角的余额小鲸鱼挂件去掉，别动别的东西'
const goal = '交付两个可独立安装的 Harness 插件'

/** Feed one synthetic session event through ingest, like the plugin does. */
function feed(store: ContextStore, event: { type: string; data: Record<string, unknown> }): void {
  const inputs = ingestEvent(event, { scope: workspace, sessionId: 's_compaction', now: 1_700_000_000_000 })
  for (const input of inputs) {
    // The plugin pins L1 records to the session scope so a parallel session in
    // the same workspace cannot inherit them.
    store.remember(input.layer === 'L1' ? { ...input, scope: session } : input)
  }
}

function transcript(store: ContextStore): void {
  feed(store, { type: 'user/message', data: { text: request } })
  feed(store, { type: 'goal/change', data: { goal } })
  feed(store, {
    type: 'tool/result',
    data: { error: { name: 'ToolError', code: 'SQLITE_BUSY', reason: 'database is locked' } },
  })
  feed(store, {
    type: 'tool/call',
    data: { name: 'edit', arguments: JSON.stringify({ file_path: 'src/widgets/whale.ts' }) },
  })
}

test('the brief still carries request, goal, error and file after compaction', () => {
  const store = new ContextStore({ path: ':memory:', now: () => 1_700_000_000_000 })
  try {
    transcript(store)
    // Compaction replaces the transcript with a summary covering seqs 1..40.
    feed(store, {
      type: 'compaction/summary',
      data: { summary: 'user asked to remove a widget; an agent read src/widgets/whale.ts', shadowedSeqs: [1, 40] },
    })

    const brief = buildBrief(store, { scope: [session, workspace], maxTokens: 900 })
    assert.equal(brief.truncated, false)
    assert.match(brief.text, /余额小鲸鱼/) // the user's own words
    assert.match(brief.text, /两个可独立安装的 Harness 插件/) // the goal
    assert.match(brief.text, /database is locked/) // the still-open error
    assert.match(brief.text, /src\/widgets\/whale\.ts/) // the file in flight
    // The L3 summary itself is long-term, not part of the short brief.
    assert.doesNotMatch(brief.text, /shadowed/)
  } finally {
    store.close()
  }
})

test('recall can still reach the original request after the summary replaced it', () => {
  const store = new ContextStore({ path: ':memory:', now: () => 1_700_000_000_000 })
  try {
    transcript(store)
    feed(store, { type: 'compaction/summary', data: { summary: 'condensed transcript', shadowedSeqs: [1, 40] } })

    // The model asks about the original instruction, not the summary wording.
    const hits = [session, workspace].flatMap((scope) => store.recall({ text: '挂件', scope }))
    assert.ok(hits.length > 0)
    assert.ok(hits.some((hit) => hit.record.body.includes('余额小鲸鱼')))
    // L3 keeps the summary for later, searchable by its own words.
    const summaryHits = store.recall({ text: 'condensed', layers: ['L3'] })
    assert.equal(summaryHits.length, 1)
  } finally {
    store.close()
  }
})
