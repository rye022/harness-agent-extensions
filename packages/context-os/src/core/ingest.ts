/**
 * Event → memory ingestion.
 *
 * This module is pure: it turns one session event into zero or more
 * `RememberInput`s. Keeping it free of Cordis and SQLite means the mapping is
 * unit-testable and the plugin layer stays a thin adapter.
 *
 * What is captured, and why not more:
 * - `user/message` → L1 request (the requirement the brief must never lose).
 * - `goal/change`, `todo/write` → L2 (explicit, stable intents).
 * - `tool/result` with an error → L1 error (unresolved-failure risk).
 * - `tool/call` touching a file → L1 file (what is in flight).
 * - `compaction/summary` → L3 (the summary plus which seqs it shadowed, so the
 *   original events can be re-read later).
 *
 * Everything else is ignored on purpose: assistant prose is the largest and
 * least reusable part of a transcript, and indexing it would make recall noisy.
 */
import type { MemoryKind, MemoryScope, RememberInput } from './types.ts'
import { extractIdentifiers } from './tokenize.ts'

/** Minimal structural view of a session event. */
export interface EventLike {
  type: string
  seq?: number
  data?: unknown
}

export interface IngestContext {
  scope: MemoryScope
  sessionId: string
  now: number
}

const HOUR = 3_600_000
const DAY = 86_400_000

/** Convert one event into memory inputs. */
export function ingestEvent(event: EventLike, ctx: IngestContext): RememberInput[] {
  const ref = event.seq === undefined ? undefined : String(event.seq)
  const source = (kind: RememberInput['source'] extends infer S ? (S extends { kind: infer K } ? K : never) : never): RememberInput['source'] =>
    ref === undefined ? { kind } : { kind, ref }
  const out: RememberInput[] = []

  switch (event.type) {
    case 'user/message': {
      const text = textOf(event.data)
      if (text.length < 2) break
      out.push({
        layer: 'L1',
        kind: 'user-request',
        scope: ctx.scope,
        title: firstLine(text, 60),
        body: clamp(text, 1200),
        importance: 3,
        ttlMs: 12 * HOUR,
        source: source('user'),
        tags: identifiers(text),
      })
      break
    }
    case 'goal/change': {
      const text = textOf(event.data)
      if (text.length < 2) break
      out.push({
        layer: 'L2',
        kind: 'goal',
        scope: ctx.scope,
        title: 'goal',
        body: clamp(text, 800),
        importance: 3,
        source: source('user'),
        tags: identifiers(text),
      })
      break
    }
    case 'todo/write': {
      const text = textOf(event.data)
      if (text.length < 2) break
      out.push({
        layer: 'L2',
        kind: 'todo',
        scope: ctx.scope,
        title: 'todo list',
        body: clamp(text, 1200),
        importance: 2,
        ttlMs: 3 * DAY,
        key: `todo:${ctx.sessionId}`,
        source: source('assistant'),
      })
      break
    }
    case 'tool/result': {
      const error = errorOf(event.data)
      if (error === undefined) break
      out.push({
        layer: 'L1',
        kind: 'error',
        scope: ctx.scope,
        title: firstLine(error, 80),
        body: clamp(error, 600),
        importance: 2,
        ttlMs: 2 * HOUR,
        source: source('tool'),
        tags: identifiers(error),
      })
      break
    }
    case 'tool/call': {
      const path = touchedPath(event.data)
      if (path === undefined) break
      out.push({
        layer: 'L1',
        kind: 'file',
        scope: ctx.scope,
        title: path,
        body: `touched by ${toolNameOf(event.data)} at seq ${ref ?? '?'}`,
        importance: 2,
        ttlMs: 2 * HOUR,
        key: `file:${ctx.sessionId}:${path}`,
        source: source('tool'),
        tags: ['file'],
      })
      break
    }
    case 'compaction/summary': {
      const text = textOf(event.data)
      const shadowed = shadowedOf(event.data)
      const body = `${text}${shadowed === undefined ? '' : `\n\nshadowed seqs: ${shadowed}`}`
      if (text.length < 2) break
      out.push({
        layer: 'L3',
        kind: 'compaction-summary',
        scope: ctx.scope,
        title: `compaction summary (seq ${ref ?? '?'})`,
        body: clamp(body, 4000),
        importance: 2,
        ttlMs: 30 * DAY,
        source: source('compaction'),
      })
      break
    }
    case 'session/title': {
      const text = textOf(event.data)
      if (text.length < 2) break
      out.push({
        layer: 'L3',
        kind: 'session-digest',
        scope: ctx.scope,
        title: 'session title',
        body: clamp(text, 300),
        importance: 1,
        ttlMs: 30 * DAY,
        key: `title:${ctx.sessionId}`,
        source: source('session'),
      })
      break
    }
    default:
      break
  }
  return out
}

/** Flatten the many shapes an event payload uses into plain text. */
export function textOf(value: unknown, depth = 0): string {
  if (depth > 6 || value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map((item) => textOf(item, depth + 1)).filter((item) => item !== '').join('\n')
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['text', 'content', 'message', 'body', 'summary', 'title', 'description', 'goal', 'todos']) {
      if (key in record) {
        const text = textOf(record[key], depth + 1)
        if (text !== '') return text
      }
    }
    // Unknown payload: keep it searchable instead of dropping it silently.
    try {
      const json = JSON.stringify(value)
      return json.length <= 2000 ? json : json.slice(0, 2000)
    } catch {
      return ''
    }
  }
  return ''
}

/** Extract the error text of a failed tool result. */
export function errorOf(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const record = data as Record<string, unknown>
  const error = record.error
  if (error === null || error === undefined) return undefined
  if (typeof error === 'string') return error
  if (typeof error === 'object') {
    const fields = error as Record<string, unknown>
    const name = typeof fields.name === 'string' ? fields.name : undefined
    const reason = typeof fields.reason === 'string' ? fields.reason : undefined
    const message = typeof fields.message === 'string' ? fields.message : undefined
    const parts = [name, message ?? reason].filter((part): part is string => part !== undefined && part !== '')
    if (parts.length > 0) return parts.join(': ')
    return textOf(error)
  }
  return undefined
}

/** Path argument of a file-touching tool call. */
export function touchedPath(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const record = data as Record<string, unknown>
  const tool = typeof record.name === 'string' ? record.name : ''
  if (!['write', 'edit', 'read', 'apply_patch', 'str_replace_editor', 'multi_edit'].includes(tool)) return undefined
  const raw = record.arguments
  let args: unknown = raw
  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw) as unknown
    } catch {
      return undefined
    }
  }
  if (args === null || typeof args !== 'object') return undefined
  const fields = args as Record<string, unknown>
  for (const key of ['file_path', 'path', 'target', 'file']) {
    const value = fields[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/** Tool name of a `tool/call` payload. */
export function toolNameOf(data: unknown): string {
  if (data !== null && typeof data === 'object') {
    const name = (data as Record<string, unknown>).name
    if (typeof name === 'string') return name
  }
  return 'tool'
}

/** Shadowed seq list of a compaction summary, when present. */
function shadowedOf(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const record = data as Record<string, unknown>
  const shadowed = record.shadowedSeqs
  if (Array.isArray(shadowed)) return shadowed.map((item) => String(item)).join(',')
  return undefined
}

/** Identifiers worth indexing as tags (paths, BV ids, constants, uuids). */
function identifiers(text: string): string[] {
  return extractIdentifiers(text).slice(0, 12)
}

function clamp(text: string, max: number): string {
  const normalised = text.replace(/\r\n/g, '\n').trim()
  return normalised.length <= max ? normalised : `${normalised.slice(0, max)}…`
}

function firstLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}

/** Kinds the ingester can produce for a given event type, for tests/docs. */
export const INGESTED_TYPES = [
  'user/message',
  'goal/change',
  'todo/write',
  'tool/result',
  'tool/call',
  'compaction/summary',
  'session/title',
] as const

/** Type guard used by the plugin to skip work for unrelated events. */
export function isIngestible(type: string): type is (typeof INGESTED_TYPES)[number] {
  return (INGESTED_TYPES as readonly string[]).includes(type)
}

/** Kinds per layer, exposed for the client panel legend. */
export const LAYER_KINDS: Record<'L1' | 'L2' | 'L3', MemoryKind[]> = {
  L1: ['user-request', 'error', 'file', 'goal'],
  L2: ['decision', 'contract', 'progress', 'todo', 'goal', 'note'],
  L3: ['compaction-summary', 'session-digest', 'checkpoint', 'note'],
}
