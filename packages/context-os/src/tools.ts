/**
 * Model-facing tools of `@harness-ext/context-os`.
 *
 * The tools are the only way the model itself can write into L2 and read from
 * all three layers. They are thin adapters over {@link ContextOsRuntime}; the
 * plugin owns scope resolution and the token budget, so a tool call cannot
 * escape its session or blow the budget by accident.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { ContextUsage, MemoryKind, MemoryLayer, MemoryRecord } from './core/types.ts'
import type { BudgetDecision } from './core/types.ts'

/** A plain text block, structurally compatible with the harness `ContentBlock`. */
type ContentBlock = { type: 'text'; text: string }

function blocks(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** Memory scopes a tool may target. */
export type ToolScope = 'session' | 'workspace' | 'global'

/** One flattened hit for a tool result. */
export interface HitSummary {
  id: string
  layer: string
  kind: string
  title: string
  body: string
  importance: number
  score: number
  updatedAt: string
  stale: boolean
}

/** Status payload. */
export interface ContextOsStatus {
  mode: string
  pressure: number
  usage: ContextUsage | null
  decision: BudgetDecision | null
  records: number
  byLayer: Record<MemoryLayer, number>
  expired: number
  stale: number
  path: string
  tools: string[]
}

/** Options the plugin implements. */
export interface ContextOsRuntime {
  readonly enabled: boolean
  /** Store a memory; returns the stored record. */
  remember(input: {
    layer?: MemoryLayer
    kind?: MemoryKind
    title: string
    body: string
    tags?: string[]
    importance?: number
    ttlMs?: number
    scope?: ToolScope
    sessionId?: string
  }): MemoryRecord
  /** Search memories. */
  recall(input: { query?: string; layers?: MemoryLayer[]; limit?: number; scope?: ToolScope; sessionId?: string }): HitSummary[]
  /** Compose a brief now. */
  brief(input: { query?: string; maxTokens?: number; sessionId?: string }): { text: string; tokens: number; truncated: boolean }
  /** Snapshot of usage + storage. */
  status(sessionId?: string): ContextOsStatus
  /** Delete one record. */
  forget(id: string): boolean
}

/** Flatten a record for a tool result, truncating the body. */
export function toHitSummary(record: MemoryRecord, score: number, maxChars: number): HitSummary {
  const body = record.body.length <= maxChars ? record.body : `${record.body.slice(0, maxChars)}…`
  return {
    id: record.id,
    layer: record.layer,
    kind: record.kind,
    title: record.title,
    body,
    importance: record.importance,
    score: Math.round(score * 1000) / 1000,
    updatedAt: new Date(record.updatedAt).toISOString(),
    stale: record.stale === true,
  }
}

const LAYERS: MemoryLayer[] = ['L1', 'L2', 'L3']

/** Register every enabled `co_*` tool; returns the disposers. */
export function registerTools(runtime: ContextOsRuntime, options: {
  enabled: boolean
  disabled: readonly string[]
  recallLimit: number
  maxChars: number
  register(definition: ReturnType<typeof defineTool>): () => void
  logger: { warn(message: string): void }
}): (() => void)[] {
  if (!options.enabled) return []
  const disposers: (() => void)[] = []
  const disabled = new Set(options.disabled)
  const add = (name: string, definition: ReturnType<typeof defineTool>): void => {
    if (disabled.has(name)) return
    try {
      disposers.push(options.register(definition))
    } catch (error) {
      options.logger.warn(`context-os: could not register ${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  add(
    'co_remember',
    defineTool({
      name: 'co_remember',
      description:
        'Store a durable memory for this task: an architecture decision, an interface contract, a progress note, an open question, or a fact worth keeping after the conversation is compacted. Use L2 for task knowledge and L3 for knowledge other sessions may need. Do not store conversation transcripts or secrets.',
      parameters: {
        title: { type: 'string', description: 'One-line title.', required: true },
        body: { type: 'string', description: 'The full memory. Be specific: paths, signatures, constraints, numbers.', required: true },
        layer: { type: 'string', enum: LAYERS, description: 'L2 (task, default) or L3 (long-term).' },
        kind: {
          type: 'string',
          enum: ['decision', 'contract', 'progress', 'todo', 'note'],
          description: 'Memory kind; defaults to note.',
        },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for filtering.' },
        importance: { type: 'integer', description: '0..3; 3 means it must survive compaction (default 2).' },
        ttl_hours: { type: 'number', description: 'Optional expiry in hours; omit for no expiry.' },
        scope: { type: 'string', enum: ['session', 'workspace', 'global'], description: 'Defaults to workspace.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', description: 'Memory id.', required: true },
            layer: { type: 'string', description: 'Stored layer.', required: true },
            updated: { type: 'boolean', description: 'True when an identical memory already existed.', required: true },
          },
        },
        render(_args, value) {
          return blocks(`${value.updated ? 'Updated' : 'Stored'} ${value.layer} memory ${value.id}.`)
        },
      },
      async execute(args) {
        const layer = args.layer ?? 'L2'
        const record = runtime.remember({
          layer,
          kind: args.kind ?? 'note',
          title: args.title,
          body: args.body,
          ...(args.tags === undefined ? {} : { tags: args.tags }),
          ...(args.importance === undefined ? {} : { importance: args.importance }),
          ...(args.ttl_hours === undefined ? {} : { ttlMs: args.ttl_hours * 3_600_000 }),
          ...(args.scope === undefined ? {} : { scope: args.scope }),
        })
        return { id: record.id, layer: record.layer, updated: record.createdAt !== record.updatedAt }
      },
    }),
  )

  add(
    'co_recall',
    defineTool({
      name: 'co_recall',
      description:
        'Search stored memories (L1 active context, L2 working memory, L3 long-term) by keyword. Use it after a compaction, when resuming a task, or before re-deriving a decision that may already be recorded. Full-text search, Chinese included.',
      parameters: {
        query: { type: 'string', description: 'Keywords or a short phrase. Omit to list the most important memories.' },
        layer: { type: 'string', enum: LAYERS, description: 'Restrict to one layer.' },
        limit: { type: 'integer', description: 'Maximum hits (default from config).' },
        scope: { type: 'string', enum: ['session', 'workspace', 'global'], description: 'Defaults to workspace.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            count: { type: 'integer', description: 'Number of hits.', required: true },
            hits: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  layer: { type: 'string', required: true },
                  kind: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  body: { type: 'string', required: true },
                  score: { type: 'number', required: true },
                  stale: { type: 'boolean', required: true },
                },
              },
            },
          },
        },
        render(_args, value) {
          if (value.count === 0) return blocks('No matching memories.')
          const lines = value.hits.map(
            (hit) =>
              `- [${hit.layer}/${hit.kind}] ${hit.title} (score ${String(hit.score)}${hit.stale ? ', stale' : ''})\n  ${hit.body.replace(/\n/g, '\n  ')}`,
          )
          return blocks(`${String(value.count)} hit(s):\n${lines.join('\n')}`)
        },
      },
      async execute(args) {
        const hits = runtime.recall({
          ...(args.query === undefined ? {} : { query: args.query }),
          ...(args.layer === undefined ? {} : { layers: [args.layer] }),
          limit: Math.max(1, Math.min(args.limit ?? options.recallLimit, 50)),
          ...(args.scope === undefined ? {} : { scope: args.scope }),
        })
        return {
          count: hits.length,
          hits: hits.map((hit) => ({
            id: hit.id,
            layer: hit.layer,
            kind: hit.kind,
            title: hit.title,
            body: hit.body,
            score: hit.score,
            stale: hit.stale,
          })),
        }
      },
    }),
  )

  add(
    'co_brief',
    defineTool({
      name: 'co_brief',
      description:
        'Render the context brief: the user request, unresolved errors, files in flight, decisions and the best long-term recall, trimmed to a token budget. Use it when the conversation feels lossy or after a compaction.',
      parameters: {
        query: { type: 'string', description: 'What the brief should recall for; defaults to the latest user message.' },
        max_tokens: { type: 'integer', description: 'Budget for the brief; defaults to the active mode cap.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tokens: { type: 'integer', description: 'Estimated tokens of the brief.', required: true },
            truncated: { type: 'boolean', description: 'True when the budget cut the brief.', required: true },
            text: { type: 'string', description: 'The brief text.', required: true },
          },
        },
        render(_args, value) {
          return blocks(value.text === '' ? 'The brief is empty: nothing important is stored yet.' : value.text)
        },
      },
      async execute(args) {
        const brief = runtime.brief({
          ...(args.query === undefined ? {} : { query: args.query }),
          ...(args.max_tokens === undefined ? {} : { maxTokens: args.max_tokens }),
        })
        return { tokens: brief.tokens, truncated: brief.truncated, text: brief.text }
      },
    }),
  )

  add(
    'co_status',
    defineTool({
      name: 'co_status',
      description: 'Report Context OS state: budget mode, current context pressure, memory counts per layer, and the store location.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            mode: { type: 'string', required: true },
            pressure: { type: 'number', required: true },
            totalTokens: { type: 'integer', required: true },
            basis: { type: 'string', required: true },
            l1: { type: 'integer', required: true },
            l2: { type: 'integer', required: true },
            l3: { type: 'integer', required: true },
            stale: { type: 'integer', required: true },
            expired: { type: 'integer', required: true },
            inject: { type: 'boolean', required: true },
            path: { type: 'string', required: true },
          },
        },
        render(_args, value) {
          const pct = (value.pressure * 100).toFixed(1)
          return blocks(
            `mode=${value.mode} pressure=${pct}% (${String(value.totalTokens)} tokens, ${value.basis})\n` +
              `memory: L1=${String(value.l1)} L2=${String(value.l2)} L3=${String(value.l3)} (stale ${String(value.stale)}, expired ${String(value.expired)})\n` +
              `brief injection: ${value.inject ? 'on' : 'off'}\nstore: ${value.path}`,
          )
        },
      },
      async execute() {
        const status = runtime.status()
        return {
          mode: status.mode,
          pressure: Math.round(status.pressure * 1000) / 1000,
          totalTokens: status.usage?.totalTokens ?? 0,
          basis: status.usage?.basis ?? 'none',
          l1: status.byLayer.L1,
          l2: status.byLayer.L2,
          l3: status.byLayer.L3,
          stale: status.stale,
          expired: status.expired,
          inject: status.decision?.injectBrief === true,
          path: status.path,
        }
      },
    }),
  )

  add(
    'co_forget',
    defineTool({
      name: 'co_forget',
      description: 'Delete one memory by id. Use it for facts that became wrong; prefer remembering a corrected fact over silent edits.',
      parameters: {
        id: { type: 'string', description: 'Memory id from co_recall.', required: true },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            removed: { type: 'boolean', required: true },
          },
        },
        render(_args, value) {
          return blocks(value.removed ? 'Memory removed.' : 'No memory with that id.')
        },
      },
      async execute(args) {
        return { removed: runtime.forget(args.id) }
      },
    }),
  )

  return disposers
}
