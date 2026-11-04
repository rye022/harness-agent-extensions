/**
 * Integration test against the REAL Cordis runtime (`@deepseek-ai/cordis@4.0.5`).
 *
 * The unit tests in `plugin.test.ts` use a hand-written fake context. This file
 * mounts the same plugin through `ctx.plugin()` so the inject gates, service
 * provisioning, event waterfall dispatch and `ctx.effect()` disposal are the
 * ones DSH itself will use. Nothing here touches a real workspace: the `fs`
 * service is a stub whose `processPath()` returns `target.hostPath`, and the
 * `tools` service records whatever the plugin registers.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'

import * as timeMachine from '../src/index.ts'

/** Tools registered through the stubbed `tools` service. */
const tools = new Map<string, { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }>()

/** Session object shaped like the fields the plugin reads. */
const session = { id: 'session-1', header: { id: 'session-1', cwd: '' } }

/** Minimal `fs` service: only `processPath` is used by the plugin. */
const fakeFs = {
  processPath: (target: { hostPath: string } | null | undefined): string => target?.hostPath ?? '',
}

/** Minimal `tools` service: `register` returns a disposer, like the real one. */
const fakeTools = {
  register(definition: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }): () => void {
    tools.set(definition.name, definition)
    return () => {
      tools.delete(definition.name)
    }
  },
}

let workspace = ''
let root = ''
let ctx: Context | undefined
let fiber: { dispose: () => Promise<void> } | undefined

before(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'tm-cordis-ws-'))
  root = join(workspace, '.time-machine')
  session.header.cwd = workspace

  ctx = new Context()
  ctx.provide('fs', fakeFs)
  ctx.provide('tools', fakeTools)

  fiber = ctx.plugin(timeMachine, { root }) as unknown as { dispose: () => Promise<void> }
  // `inject` makes the plugin a dependent fiber: give the registry a tick to
  // resolve it before dispatching events.
  await new Promise((resolve) => setTimeout(resolve, 20))
})

after(async () => {
  await fiber?.dispose()
  if (workspace !== '') rmSync(workspace, { recursive: true, force: true })
})

test('the plugin mounts under real Cordis and registers its tools', () => {
  assert.ok(ctx !== undefined)
  assert.deepEqual([...tools.keys()].sort(), ['tm_checkpoint', 'tm_diff', 'tm_list', 'tm_restore', 'tm_status'])
  // Provided services become properties on the context.
  const service = (ctx as unknown as { timeMachine?: { version: string } }).timeMachine
  assert.equal(service?.version, timeMachine.version)
})

test('fs/write-intent captures a pre-image that a turn checkpoint keeps', async () => {
  const file = join(workspace, 'a.txt')
  writeFileSync(file, 'before\n', 'utf8')

  ctx!.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
  await ctx!.waterfall(
    'fs/write-intent',
    { hostPath: file },
    { name: 'write', callId: 'call-1', session },
    async () => ({ ok: true }),
  )
  // The write itself happens after the hook returns, exactly like DSH's fs layer.
  writeFileSync(file, 'after\n', 'utf8')

  ctx!.emit('session/event', session, { type: 'turn/end', data: { turn: 1 } })

  const service = (ctx as unknown as {
    timeMachine: { list: (options?: { limit?: number }) => { id: string; files: { path: string; before: string | null }[] }[] }
  }).timeMachine
  const collected = await waitFor(async () => {
    const listed = service.list({ limit: 10 })
    return listed.length > 0 ? listed : undefined
  })
  assert.equal(collected.length, 1)
  const entry = collected[0]!.files.find((item) => item.path === 'a.txt')
  assert.ok(entry !== undefined, 'the checkpoint should list a.txt')
  assert.notEqual(entry.before, null)
})

test('tm_restore round-trips a file through the tool surface', async () => {
  const service = (ctx as unknown as { timeMachine: { list: () => { id: string }[] } }).timeMachine
  const listed = service.list()
  const id = listed[0]!.id
  const tool = tools.get('tm_restore')
  assert.ok(tool !== undefined)
  const output = (await tool.execute({ id, side: 'before', force: true }, { callId: 'call-2', session })) as {
    writes?: number
    safetyCheckpoint?: string
    message?: string
  }
  assert.equal(output.writes, 1)
  assert.equal(typeof output.safetyCheckpoint, 'string')
})

test('disposal removes the tools and the provided service', async () => {
  await fiber!.dispose()
  fiber = undefined
  assert.equal(tools.size, 0)
  assert.equal((ctx as unknown as { timeMachine?: unknown }).timeMachine, undefined)
})

/** Poll until `probe` returns a value (checkpoint finalization is async). */
async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value !== undefined) return value
    } catch (error) {
      last = error
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for a value${last === undefined ? '' : `: ${String(last)}`}`)
}
