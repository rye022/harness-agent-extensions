/**
 * Both plugins running at once, under the real Cordis runtime.
 *
 * The brief requires the two plugins to be independently installable, so nobody
 * should ever have to mount them together — but when an operator does, three
 * things must hold: the tool namespaces stay disjoint, each service is visible
 * only under its own name, and Time Machine checkpoints reach Context OS memory
 * through the optional interop (rather than through a hard dependency).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'

import * as contextOs from '../packages/context-os/src/index.ts'
import * as timeMachine from '../packages/time-machine/src/index.ts'

const tools = new Map<string, { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }>()
const session = { id: 'session-1', header: { id: 'session-1', cwd: '' } }
const fakeFs = { processPath: (target: { hostPath: string } | null | undefined): string => target?.hostPath ?? '' }
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
let tmFiber: { dispose: () => Promise<void> } | undefined
let coFiber: { dispose: () => Promise<void> } | undefined

before(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'interop-ws-'))
  root = join(workspace, '.plugins')
  session.header.cwd = workspace

  ctx = new Context()
  ctx.provide('fs', fakeFs)
  ctx.provide('tools', fakeTools)

  tmFiber = ctx.plugin(timeMachine, { root: join(root, 'tm') }) as unknown as { dispose: () => Promise<void> }
  await new Promise((resolve) => setTimeout(resolve, 20))
  coFiber = ctx.plugin(contextOs, { root: join(root, 'co') }) as unknown as { dispose: () => Promise<void> }
  await new Promise((resolve) => setTimeout(resolve, 20))
})

after(async () => {
  await coFiber?.dispose()
  await tmFiber?.dispose()
  if (workspace !== '') rmSync(workspace, { recursive: true, force: true })
})

test('both plugins mount side by side with disjoint tool namespaces', () => {
  const names = [...tools.keys()].sort()
  assert.deepEqual(
    names.filter((name) => name.startsWith('tm_')),
    ['tm_checkpoint', 'tm_diff', 'tm_list', 'tm_restore', 'tm_status'],
  )
  assert.deepEqual(
    names.filter((name) => name.startsWith('co_')),
    ['co_brief', 'co_forget', 'co_recall', 'co_remember', 'co_status'],
  )
  const services = ctx as unknown as { timeMachine?: { version: string }; contextOs?: { version: string } }
  assert.equal(services.timeMachine?.version, timeMachine.version)
  assert.equal(services.contextOs?.version, contextOs.version)
})

test('a checkpoint surfaces as an L2 memory through the optional interop', async () => {
  const file = join(workspace, 'notes.txt')
  writeFileSync(file, 'before\n', 'utf8')

  ctx!.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
  await ctx!.waterfall(
    'fs/write-intent',
    { hostPath: file },
    { name: 'write', callId: 'call-1', session },
    async () => ({ ok: true }),
  )
  writeFileSync(file, 'after\n', 'utf8')
  ctx!.emit('session/event', session, { type: 'turn/end', data: { turn: 1 } })

  const service = (ctx as unknown as { timeMachine: { list: () => { id: string }[] } }).timeMachine
  const listed = await waitFor(async () => {
    const items = service.list()
    return items.length > 0 ? items : undefined
  })
  const id = listed[0]!.id

  // The interop writes synchronously into the Context OS database, so poll the
  // database file rather than the (asynchronous) checkpoint event.
  const dbPath = join(root, 'co', 'context.db')
  const titles = await waitFor(async () => {
    const db = new DatabaseSync(dbPath)
    try {
      const rows = db.prepare("SELECT title FROM memories WHERE kind = 'checkpoint'").all() as { title: string }[]
      return rows.length > 0 ? rows.map((row) => row.title) : undefined
    } finally {
      db.close()
    }
  })
  assert.ok(titles.includes(`checkpoint ${id}`), `expected a memory for checkpoint ${id}, got ${JSON.stringify(titles)}`)
})

test('disposing Context OS leaves Time Machine tools and service intact', async () => {
  await coFiber!.dispose()
  coFiber = undefined
  assert.deepEqual([...tools.keys()].sort(), ['tm_checkpoint', 'tm_diff', 'tm_list', 'tm_restore', 'tm_status'])
  const services = ctx as unknown as { timeMachine?: unknown; contextOs?: unknown }
  assert.notEqual(services.timeMachine, undefined)
  assert.equal(services.contextOs, undefined)
})

/** Poll until `probe` returns a value. */
async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
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
