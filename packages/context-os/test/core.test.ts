/**
 * Budget, brief and ingestion tests.
 *
 * The budget is the part that can quietly ruin a session ("compress until the
 * task breaks"), so its boundaries are asserted explicitly rather than through
 * the plugin.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BUDGET_PROFILES, decideBudget, resolveProfile } from '../src/core/budget.ts'
import { buildBrief } from '../src/core/brief.ts'
import { ingestEvent } from '../src/core/ingest.ts'
import { ContextStore } from '../src/core/store.ts'
import type { ContextUsage, MemoryScope } from '../src/core/types.ts'

const workspace: MemoryScope = { kind: 'workspace', id: 'ws_test' }
const windowTokens = 100_000

function usage(tokens: number): ContextUsage {
  return { totalTokens: tokens, basis: 'estimated', revision: 1 }
}

test('resolveProfile turns fractions into absolute tokens', () => {
  const balanced = resolveProfile({ mode: 'balanced', windowTokens })
  assert.equal(balanced.threshold, BUDGET_PROFILES.balanced.threshold)
  assert.equal(balanced.retainTokens, 20_000)
  assert.equal(balanced.briefCapTokens, 900)
  assert.equal(balanced.recallLimit, BUDGET_PROFILES.balanced.recallLimit)
})

test('no brief is contributed below the mode threshold', () => {
  const decision = decideBudget(usage(60_000), { mode: 'balanced', windowTokens })
  assert.equal(decision.injectBrief, false)
  assert.equal(decision.briefTokens, 0)
  assert.match(decision.reason, /below the balanced threshold/)
})

test('modes differ in how early they contribute', () => {
  const u = usage(60_000)
  assert.equal(decideBudget(u, { mode: 'conservative', windowTokens }).injectBrief, false)
  assert.equal(decideBudget(u, { mode: 'balanced', windowTokens }).injectBrief, false)
  assert.equal(decideBudget(u, { mode: 'saver', windowTokens }).injectBrief, true)
})

test('the reserve is capped at half of the remaining room', () => {
  // 92% used: 8 000 free, balanced's 20 000 floor would eat all of it. The cap
  // keeps half free (4 000), so the 900-token brief still fits.
  const decision = decideBudget(usage(92_000), { mode: 'balanced', windowTokens })
  assert.equal(decision.injectBrief, true)
  assert.equal(decision.briefTokens, 900)
})

test('a context that is already over the window has no room for a brief', () => {
  const decision = decideBudget(usage(104_000), { mode: 'balanced', windowTokens })
  assert.equal(decision.injectBrief, false)
  assert.match(decision.reason, /no room/)
})

test('a brief that cannot reach 80 tokens is refused', () => {
  // 99.95% used → 50 tokens free, half of them reserved: no usable brief.
  const decision = decideBudget(usage(99_950), { mode: 'balanced', windowTokens })
  assert.equal(decision.injectBrief, false)
  assert.match(decision.reason, /< 80/)
})

test('explicit overrides are honoured', () => {
  const decision = decideBudget(usage(50_000), {
    mode: 'balanced',
    windowTokens,
    threshold: 0.4,
    briefCapTokens: 500,
    retainTokens: 1_000,
  })
  assert.equal(decision.injectBrief, true)
  assert.equal(decision.briefTokens, 500)
})

test('the brief prefers the live request over background decisions', () => {
  const store = new ContextStore({ path: ':memory:', now: () => 1_700_000_000_000 })
  store.remember({ layer: 'L2', kind: 'decision', scope: workspace, title: 'Chose FTS5', body: 'no native deps', importance: 2 })
  store.remember({ layer: 'L1', kind: 'user-request', scope: workspace, title: 'Build two plugins', body: 'time machine and context os', importance: 3 })
  store.remember({ layer: 'L1', kind: 'error', scope: workspace, title: 'ENOENT on rename', body: 'putBuffer raced the stream', importance: 2 })
  const brief = buildBrief(store, { scope: workspace, query: 'plugins', maxTokens: 2_000 })
  assert.match(brief.text, /Build two plugins/)
  assert.ok(brief.text.indexOf('Build two plugins') < brief.text.indexOf('Chose FTS5'))
  assert.ok(brief.text.includes('[Context OS brief]'))
  assert.ok(brief.recordIds.length >= 3)
  store.close()
})

test('sections follow the kind, not the layer', () => {
  const store = new ContextStore({ path: ':memory:', now: () => 1_700_000_000_000 })
  // Errors and files are usually captured in the session scope, but a workspace
  // record of the same kind must not be silently dropped from the brief.
  store.remember({ layer: 'L2', kind: 'error', scope: workspace, title: 'ERR_PNPM_FETCH_404', body: 'overrides missing', importance: 3 })
  store.remember({ layer: 'L2', kind: 'file', scope: workspace, title: 'packages/context-os/src/core/brief.ts', body: 'section filter', importance: 2 })
  store.remember({ layer: 'L1', kind: 'user-request', scope: workspace, title: 'keep the build green', body: 'no regressions', importance: 3 })
  const brief = buildBrief(store, { scope: workspace, maxTokens: 2_000 })
  assert.match(brief.text, /Open errors:/)
  assert.match(brief.text, /Files in flight:/)
  assert.match(brief.text, /ERR_PNPM_FETCH_404/)
  assert.match(brief.text, /brief\.ts/)
  store.close()
})

test('a tiny budget truncates instead of overflowing', () => {
  const store = new ContextStore({ path: ':memory:', now: () => 1_700_000_000_000 })
  for (let index = 0; index < 20; index += 1) {
    store.remember({
      layer: 'L2',
      kind: 'decision',
      scope: workspace,
      title: `decision ${String(index)}`,
      body: 'x'.repeat(400),
    })
  }
  const brief = buildBrief(store, { scope: workspace, maxTokens: 200 })
  assert.equal(brief.truncated, true)
  assert.ok(brief.tokens <= 400)
  assert.ok(brief.text.length < 20 * 400)
  store.close()
})

test('ingest maps user messages, errors and file touches', () => {
  const ctx = { scope: workspace, sessionId: 's1', now: 1_700_000_000_000 }
  const user = ingestEvent({ type: 'user/message', seq: 3, data: { content: [{ type: 'text', text: '修复 build 失败' }] } }, ctx)
  assert.equal(user.length, 1)
  assert.equal(user[0]?.layer, 'L1')
  assert.equal(user[0]?.kind, 'user-request')
  assert.equal(user[0]?.importance, 3)
  assert.equal(user[0]?.source.ref, '3')

  const error = ingestEvent({ type: 'tool/result', seq: 9, data: { error: { name: 'TypeError', message: 'x is undefined' } } }, ctx)
  assert.equal(error[0]?.kind, 'error')
  assert.match(error[0]?.body ?? '', /x is undefined/)

  const file = ingestEvent(
    { type: 'tool/call', seq: 10, data: { name: 'write', arguments: JSON.stringify({ file_path: 'src/app.ts' }) } },
    ctx,
  )
  assert.equal(file[0]?.kind, 'file')
  assert.equal(file[0]?.title, 'src/app.ts')
  assert.equal(file[0]?.key, 'file:s1:src/app.ts')
})

test('ingest ignores events that carry no reusable knowledge', () => {
  const ctx = { scope: workspace, sessionId: 's1', now: 1_700_000_000_000 }
  assert.equal(ingestEvent({ type: 'assistant/message', seq: 4, data: 'long prose' }, ctx).length, 0)
  assert.equal(ingestEvent({ type: 'step/start', seq: 5, data: { turn: 1, step: 1 } }, ctx).length, 0)
  assert.equal(ingestEvent({ type: 'user/message', seq: 6, data: 'x' }, ctx).length, 0)
})

test('a measured context window overrides the configured fallback', () => {
  // 900 000 of 1 048 576 tokens is 85.8%: over the conservative 85% threshold.
  // Against the configured 131 072-token fallback the same usage would look
  // impossible (free < 0) and silently suppress every brief, which is exactly
  // what happened on a 1 M-token route.
  const usage = { totalTokens: 900_000, basis: 'usage' as const, revision: 7, windowTokens: 1_048_576 }
  const decision = decideBudget(usage, { mode: 'conservative', windowTokens: 131_072 })
  assert.equal(decision.injectBrief, true)
  assert.ok(decision.pressure > 0.85 && decision.pressure < 0.87, 'pressure is measured against the real window')

  const fallback = decideBudget({ totalTokens: 900_000, basis: 'usage', revision: 7 }, { mode: 'conservative', windowTokens: 131_072 })
  assert.equal(fallback.injectBrief, false, 'without a measured window the configured fallback still decides')
})
