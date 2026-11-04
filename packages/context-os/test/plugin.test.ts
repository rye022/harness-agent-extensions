/**
 * Plugin-level tests: mount against a fake Cordis context, capture events,
 * register tools, and dispose cleanly.
 *
 * The fake ctx mirrors the real one closely enough to exercise the same code
 * paths the Harness uses (`ctx.on`, `ctx.provide`, `ctx.effect`, `ctx.get`).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply } from '../src/plugin.ts'
import type { ContextOsService } from '../src/plugin.ts'

interface FakeTool {
  execute(args: any, exec?: any): Promise<any>
  name: string
}

function fakeContext(): {
  ctx: any
  handlers: Map<string, ((...args: any[]) => any)[]>
  tools: Map<string, FakeTool>
  provided: Map<string, unknown>
  warnings: string[]
  infos: string[]
  dispose: () => void
  emit(name: string, ...args: any[]): unknown
} {
  const handlers = new Map<string, ((...args: any[]) => any)[]>()
  const tools = new Map<string, FakeTool>()
  const provided = new Map<string, unknown>()
  const warnings: string[] = []
  const infos: string[] = []
  const disposers: (() => void)[] = []
  const ctx = {
    logger: {
      info: (message: string) => infos.push(message),
      warn: (message: string) => warnings.push(message),
      debug: () => undefined,
    },
    effect: (callback: () => void | (() => void)) => {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
    },
    on: (name: string, listener: (...args: any[]) => any) => {
      const list = handlers.get(name) ?? []
      list.push(listener)
      handlers.set(name, list)
      return () => undefined
    },
    provide: (name: string, value: unknown) => {
      provided.set(name, value)
    },
    get: (name: string) => provided.get(name),
    tools: {
      register: (definition: FakeTool) => {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }
  const emit = (name: string, ...args: any[]): unknown => {
    let result: unknown
    for (const listener of handlers.get(name) ?? []) result = listener(...args)
    return result
  }
  const dispose = () => {
    for (const disposer of disposers.reverse()) disposer()
  }
  return { ctx, handlers, tools, provided, warnings, infos, dispose, emit }
}

const session = { header: { id: 's1', cwd: 'C:/work/project' } }

function mount(): ReturnType<typeof fakeContext> & { service: ContextOsService } {
  const harness = fakeContext()
  apply(harness.ctx, { dbFile: ':memory:', mode: 'balanced', windowTokens: 10_000 })
  const service = harness.provided.get('contextOs') as ContextOsService
  assert.ok(service, 'contextOs service must be provided')
  return { ...harness, service }
}

test('mounting publishes the service and the five tools', () => {
  const { tools, service, infos, dispose } = mount()
  assert.equal(service.version, '0.1.0')
  assert.equal(service.enabled, true)
  for (const name of ['co_remember', 'co_recall', 'co_brief', 'co_status', 'co_forget']) {
    assert.ok(tools.has(name), `${name} must be registered`)
  }
  assert.ok(infos.some((line) => line.includes('context-os: ready')))
  dispose()
})

test('a user message becomes an L1 memory scoped to the session', () => {
  const { emit, service, dispose } = mount()
  emit('session/event', session, {
    type: 'user/message',
    seq: 3,
    data: { content: [{ type: 'text', text: '修复 build 失败并补测试' }] },
  })
  const stats = service.stats()
  assert.equal(stats.total, 1)
  assert.equal(stats.byLayer.L1, 1)
  // L1 is task-local: it is invisible to the workspace-scoped recall.
  assert.equal(service.recall({ query: 'build' }).length, 0)
  assert.equal(service.recall({ query: 'build', scope: 'session' }).length, 1)
  dispose()
})

test('goals land in L2 and are visible to the workspace', () => {
  const { emit, service, dispose } = mount()
  emit('session/event', session, { type: 'goal/change', seq: 7, data: 'Ship two plugins' })
  assert.equal(service.stats().byLayer.L2, 1)
  const hits = service.recall({ query: 'plugins' })
  assert.equal(hits.length, 1)
  assert.equal(hits[0]?.layer, 'L2')
  dispose()
})

test('failed tool results are recorded as open errors', () => {
  const { emit, service, dispose } = mount()
  emit('session/event', session, {
    type: 'tool/result',
    seq: 11,
    data: { error: { name: 'RestoreConflict', message: 'file changed since checkpoint' } },
  })
  const hits = service.recall({ query: 'checkpoint', scope: 'session' })
  assert.equal(hits.length, 1)
  assert.equal(hits[0]?.kind, 'error')
  assert.ok(hits[0]?.body.includes('file changed'))
  dispose()
})

test('co_remember writes and co_recall reads it back', async () => {
  const { tools, service, dispose } = mount()
  const remember = tools.get('co_remember')
  const recall = tools.get('co_recall')
  assert.ok(remember && recall)
  const stored = await remember.execute({ title: 'FTS5 chosen', body: 'because node:sqlite ships FTS5', layer: 'L2', kind: 'decision' })
  assert.match(stored.id, /^mem_/)
  const result = await recall.execute({ query: 'FTS5' })
  assert.equal(result.count, 1)
  assert.equal(result.hits[0].title, 'FTS5 chosen')
  const status = await tools.get('co_status')?.execute({})
  assert.equal(status?.l2, 1)
  dispose()
})

test('co_brief renders the request and honours the token cap', async () => {
  const { emit, tools, dispose } = mount()
  emit('session/event', session, {
    type: 'user/message',
    seq: 3,
    data: { content: [{ type: 'text', text: '把两个插件做完' }] },
  })
  const brief = await tools.get('co_brief')?.execute({ query: '插件', max_tokens: 500 })
  assert.ok(brief && brief.tokens <= 500)
  assert.ok(brief.text.length > 0)
  dispose()
})

test('disposal removes the tools and closes the store', async () => {
  const { tools, service, dispose } = mount()
  const remember = tools.get('co_remember')
  dispose()
  assert.equal(tools.size, 0)
  await assert.rejects(() => Promise.resolve(remember?.execute({ title: 'x', body: 'y' })))
  assert.equal(service.enabled, true)
})

test('a config with wrong types is reported but still mounts', () => {
  const harness = fakeContext()
  apply(harness.ctx, { dbFile: ':memory:', mode: 'nonsense', windowTokens: 'big', tools: { enabled: 'yes' } })
  const service = harness.provided.get('contextOs') as ContextOsService
  assert.ok(service)
  assert.equal(service.enabled, true)
  assert.ok(harness.warnings.some((line) => line.includes('config.mode')))
  assert.ok(harness.warnings.some((line) => line.includes('config.windowTokens')))
  harness.dispose()
})
