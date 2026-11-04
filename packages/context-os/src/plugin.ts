/**
 * `@harness-ext/context-os` — layered memory + a token budget for the Harness.
 *
 * What it adds, and why each piece is where it is:
 *
 * - **Memory capture** rides `session/event`. The shipped event stream already
 *   carries everything worth remembering (user asks, failures, edited files,
 *   compactions, todos), so the plugin never wraps a tool and can never double
 *   execute one.
 * - **Storage** is SQLite (`node:sqlite`, built into Node 24) with an FTS5
 *   index; there is no native dependency and no embedding API.
 * - **Budget** is a policy: at most `briefCapTokens`, never eating the room a
 *   turn needs. It is not a second compaction loop — `compaction-basic` and
 *   `billion-context` own that, and this plugin only contributes text.
 * - **Injection** (the model actually seeing the brief mid-turn) is off by
 *   default: it rewrites the pre-step message list, which is the one place a
 *   plugin can break a turn. `co_brief` gives the same text on demand.
 */
import { createHash } from 'node:crypto'

import { TypedBus } from '@harness-ext/shared'

import { decideBudget, resolveProfile, type BudgetOptions } from './core/budget.ts'
import { buildBrief, type Brief } from './core/brief.ts'
import { ingestEvent } from './core/ingest.ts'
import { ContextStore, type StoreStats } from './core/store.ts'
import type {
  BudgetDecision,
  ContextUsage,
  MemoryKind,
  MemoryLayer,
  MemoryRecord,
  MemoryScope,
} from './core/types.ts'
import { defaultRoot, normalizeConfig, resolveDbPath, type ContextOsConfig } from './config.ts'
import { registerTools, toHitSummary, type ContextOsRuntime, type ContextOsStatus, type HitSummary, type ToolScope } from './tools.ts'

/** Plugin name used in fiber diagnostics. */
export const name = 'harness-ext-context-os'
/** Services this plugin needs before it loads. */
export const inject = ['tools']
/** Semantic version of the plugin implementation. */
export const version = '0.1.0'

/** Minimal structural view of the Cordis context this plugin uses. */
export interface PluginContext {
  logger: {
    info(message: string): void
    warn(message: string): void
    debug?(message: string): void
  }
  effect(callback: () => void | (() => void)): void
  on(event: string, listener: (...args: any[]) => any, options?: { prepend?: boolean }): unknown
  provide(name: string, value: unknown): void
  get(name: string, strict?: boolean): any
  tools: { register(definition: unknown): () => void }
}

/** Events published on `ctx.contextOs.events`. */
export interface ContextOsEventMap {
  'memory/added': { id: string; layer: MemoryLayer; kind: MemoryKind; title: string }
  'memory/stale': { scope: MemoryScope; count: number }
  'brief/built': { tokens: number; truncated: boolean; records: number }
  'budget/decided': { decision: BudgetDecision }
  'store/error': { message: string }
}

/** Published service: `ctx.contextOs`. */
export interface ContextOsService extends ContextOsRuntime {
  version: string
  enabled: boolean
  events: TypedBus<ContextOsEventMap>
  /** Absolute path of the SQLite database, or the intended one if opening failed. */
  path: string
  /** Populated when the store could not be opened. */
  openError?: string
  /** Most recent measurement for a session, when a token meter is available. */
  usage(sessionId?: string): ContextUsage | null
  /** Budget decision for a session, combining usage and config. */
  decision(sessionId?: string): BudgetDecision | null
  /** Store counts. */
  stats(): StoreStats & { enabled: boolean }
  /** Mark memories of a scope as possibly stale (used by Time Machine interop). */
  markStale(scope: MemoryScope, kinds?: MemoryKind[]): number
  /** Close the database. */
  close(): void
}

/** A brief plus the records it cited. */
type BuiltBrief = Brief & { recordIds: string[] }

/**
 * Mount Context OS.
 *
 * Configuration problems are logged and degraded, never thrown: a plugin that
 * throws while mounting takes the whole profile down with it.
 */
export function apply(ctx: PluginContext, rawConfig?: unknown): void {
  const { config, issues } = normalizeConfig(rawConfig)
  for (const issue of issues) {
    ctx.logger.warn(`context-os: config.${issue.path === '' ? '(root)' : issue.path}: ${issue.message}`)
  }

  const events = new TypedBus<ContextOsEventMap>()
  const dbPath = resolveDbPath(config)
  const sessions = new Map<string, unknown>()
  const cwdBySession = new Map<string, string>()
  let lastSessionId: string | undefined
  let store: ContextStore | null = null
  let openError: string | undefined

  if (config.enabled) {
    try {
      store = new ContextStore({ path: dbPath })
    } catch (error) {
      openError = messageOf(error)
      ctx.logger.warn(`context-os: cannot open ${dbPath}: ${openError}; memory features stay disabled`)
      events.emit('store/error', { message: openError })
    }
  }

  const workspaceScopes = new Map<string, MemoryScope>()
  const workspaceScopeOf = (cwd: string | undefined): MemoryScope => {
    const key = cwd ?? ''
    const cached = workspaceScopes.get(key)
    if (cached !== undefined) return cached
    const scope: MemoryScope = { kind: 'workspace', id: `ws_${createHash('sha256').update(key).digest('hex').slice(0, 12)}` }
    workspaceScopes.set(key, scope)
    return scope
  }
  const globalScope = (): MemoryScope => ({ kind: 'global', id: 'global' })
  const sessionScopeOf = (id: string | undefined): MemoryScope => ({ kind: 'session', id: `s_${id ?? 'unknown'}` })

  const activeCwd = (sessionId?: string): string | undefined => {
    const id = sessionId ?? lastSessionId
    const cwd = id === undefined ? undefined : cwdBySession.get(id)
    return cwd ?? (lastSessionId === undefined ? undefined : cwdBySession.get(lastSessionId))
  }

  const resolveScope = (scope: ToolScope | undefined, sessionId?: string): MemoryScope => {
    if (scope === 'global') return globalScope()
    if (scope === 'session') return sessionScopeOf(sessionId ?? lastSessionId)
    return workspaceScopeOf(activeCwd(sessionId))
  }

  const budgetOptions = (): BudgetOptions => ({
    windowTokens: config.windowTokens,
    mode: config.mode,
    ...(config.threshold === undefined ? {} : { threshold: config.threshold }),
    ...(config.briefCapTokens === undefined ? {} : { briefCapTokens: config.briefCapTokens }),
    ...(config.retainTokens === undefined ? {} : { retainTokens: config.retainTokens }),
  })

  const measureUsage = (sessionId?: string): ContextUsage | null => {
    const meter = ctx.get('tokenMeter') as
      | undefined
      | { measure(session: unknown, header?: unknown): { totalTokens?: number; logRevision?: number; baseline?: { kind?: string } } }
    if (meter === undefined) return null
    const id = sessionId ?? lastSessionId
    if (id === undefined) return null
    const session = sessions.get(id)
    if (session === undefined) return null
    try {
      const measured = meter.measure(session)
      const kind = measured.baseline?.kind
      const basis: ContextUsage['basis'] = kind === 'usage' ? 'usage' : kind === 'estimated' ? 'estimated' : 'none'
      return {
        totalTokens: Math.max(0, Math.round(measured.totalTokens ?? 0)),
        basis,
        revision: Math.max(0, Math.round(measured.logRevision ?? 0)),
      }
    } catch (error) {
      ctx.logger.debug?.(`context-os: token measurement failed: ${messageOf(error)}`)
      return null
    }
  }

  const recallScoped = (input: {
    query?: string
    layers?: MemoryLayer[]
    limit: number
    scope: MemoryScope
    kinds?: MemoryKind[]
  }): HitSummary[] => {
    if (store === null) return []
    const scopes = input.scope.kind === 'global' ? [input.scope] : [input.scope, globalScope()]
    const hits: { record: MemoryRecord; score: number }[] = []
    for (const scope of scopes) {
      for (const hit of store.recall({
        ...(input.query === undefined ? {} : { text: input.query }),
        ...(input.layers === undefined ? {} : { layers: input.layers }),
        ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
        scope,
        limit: input.limit,
      })) {
        hits.push({ record: hit.record, score: hit.score })
      }
    }
    hits.sort((left, right) => right.score - left.score)
    const seen = new Set<string>()
    const out: HitSummary[] = []
    for (const hit of hits) {
      if (seen.has(hit.record.id)) continue
      seen.add(hit.record.id)
      out.push(toHitSummary(hit.record, hit.score, config.tools.maxChars))
      if (out.length >= input.limit) break
    }
    return out
  }

  const buildBriefFor = (input: { query?: string; maxTokens?: number; sessionId?: string }): BuiltBrief => {
    if (store === null) return { text: '', tokens: 0, sections: [], recordIds: [], truncated: false }
    const decision = buildDecision(input.sessionId)
    const cap = Math.max(120, input.maxTokens ?? decision?.briefTokens ?? resolveProfile(budgetOptions()).briefCapTokens)
    const sessionId = input.sessionId ?? lastSessionId
    const brief = buildBrief(store, {
      scope: [sessionScopeOf(sessionId), workspaceScopeOf(activeCwd(sessionId)), globalScope()],
      ...(input.query === undefined ? {} : { query: input.query }),
      maxTokens: cap,
      recallLimit: resolveProfile(budgetOptions()).recallLimit,
    })
    const recordIds = (brief as BuiltBrief).recordIds ?? []
    events.emit('brief/built', { tokens: brief.tokens, truncated: brief.truncated, records: recordIds.length })
    return { ...brief, recordIds }
  }

  const buildDecision = (sessionId?: string): BudgetDecision | null => {
    const usage = measureUsage(sessionId)
    if (usage === null) return null
    return decideBudget(usage, budgetOptions())
  }

  const captureEnabled = (kind: MemoryKind): boolean => {
    switch (kind) {
      case 'user-request':
        return config.capture.userMessages
      case 'error':
        return config.capture.toolErrors
      case 'file':
        return config.capture.files
      case 'compaction-summary':
        return config.capture.compaction
      case 'goal':
        return config.capture.goals
      default:
        return true
    }
  }

  const service: ContextOsService = {
    version,
    enabled: store !== null,
    events,
    path: dbPath,
    ...(openError === undefined ? {} : { openError }),
    remember(input) {
      if (store === null) throw new Error('context-os: the memory store is not available')
      const scope = resolveScope(input.scope, input.sessionId)
      const record = store.remember({
        layer: input.layer ?? 'L2',
        kind: input.kind ?? 'note',
        scope,
        title: input.title,
        body: input.body,
        ...(input.tags === undefined ? {} : { tags: input.tags }),
        ...(input.importance === undefined ? {} : { importance: input.importance }),
        ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
        source: { kind: 'manual' },
      })
      events.emit('memory/added', { id: record.id, layer: record.layer, kind: record.kind, title: record.title })
      return record
    },
    recall(input) {
      return recallScoped({
        ...(input.query === undefined ? {} : { query: input.query }),
        ...(input.layers === undefined ? {} : { layers: input.layers }),
        limit: Math.max(1, Math.min(input.limit ?? config.tools.recallLimit, 50)),
        scope: resolveScope(input.scope, input.sessionId),
      })
    },
    brief(input) {
      const brief = buildBriefFor({
        ...(input.query === undefined ? {} : { query: input.query }),
        ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      })
      return { text: brief.text, tokens: brief.tokens, truncated: brief.truncated }
    },
    status(sessionId) {
      const usage = measureUsage(sessionId)
      const decision = usage === null ? null : decideBudget(usage, budgetOptions())
      const stats = store === null ? emptyStats(dbPath) : store.stats()
      const status: ContextOsStatus = {
        mode: config.mode,
        pressure: decision?.pressure ?? 0,
        usage,
        decision,
        records: stats.total,
        byLayer: stats.byLayer,
        expired: stats.expired,
        stale: stats.stale,
        path: dbPath,
        tools: ['co_remember', 'co_recall', 'co_brief', 'co_status', 'co_forget'],
      }
      return status
    },
    forget(id) {
      return store === null ? false : store.forget(id)
    },
    usage(sessionId) {
      return measureUsage(sessionId)
    },
    decision(sessionId) {
      const usage = measureUsage(sessionId)
      if (usage === null) return null
      const decision = decideBudget(usage, budgetOptions())
      events.emit('budget/decided', { decision })
      return decision
    },
    stats() {
      return store === null ? { ...emptyStats(dbPath), enabled: false } : { ...store.stats(), enabled: true }
    },
    markStale(scope, kinds) {
      if (store === null) return 0
      const count = store.markStale(scope, kinds)
      events.emit('memory/stale', { scope, count })
      return count
    },
    close() {
      store?.close()
      store = null
    },
  }

  ctx.provide('contextOs', service)

  // ---- optional Time Machine interop --------------------------------------
  // Both plugins are usable alone; when `timeMachine` is present, checkpoints
  // and restores are mirrored into memory so a restored workspace does not keep
  // citing facts that were rolled back.
  const injectFn = (ctx as unknown as { inject?: (deps: string[], callback: (sub: any) => void) => unknown }).inject
  if (typeof injectFn === 'function' && store !== null && config.enabled) {
    try {
      injectFn.call(ctx, ['timeMachine'], (sub: any) => {
        const timeMachine = sub?.timeMachine ?? sub?.get?.('timeMachine')
        const bus = timeMachine?.events
        if (bus === undefined || typeof bus.on !== 'function') return
        const recordCheckpoint = (payload: any): void => {
          try {
            const record = payload?.record
            if (record === undefined || store === null) return
            const files = Array.isArray(record.files) ? record.files.length : 0
            store.remember({
              layer: 'L2',
              kind: 'checkpoint',
              scope: workspaceScopeOf(record.workspaceRoot ?? activeCwd()),
              title: `checkpoint ${String(record.id)}`,
              body: `${String(record.origin)} checkpoint${record.label === undefined ? '' : ` "${String(record.label)}"`} covering ${String(files)} file(s)${record.turn === undefined ? '' : ` (turn ${String(record.turn)})`}; restore it with tm_restore to roll those files back`,
              importance: 1,
            })
          } catch (error) {
            ctx.logger.debug?.(`context-os: could not record checkpoint: ${messageOf(error)}`)
          }
        }
        const noteRestore = (payload: any): void => {
          try {
            const record = payload?.record
            const plan = payload?.plan
            if (record === undefined || store === null) return
            const files = Array.isArray(record.files) ? record.files.length : 0
            const scope = workspaceScopeOf(record.workspaceRoot ?? activeCwd())
            // File/decision memories older than the restore may no longer match
            // what is on disk; keep them, but never present them as current.
            service.markStale(scope, ['file', 'decision', 'contract', 'progress'])
            store.remember({
              layer: 'L2',
              kind: 'checkpoint',
              scope,
              title: `restored ${String(record.id)}`,
              body: `restored ${String(files)} file(s) from checkpoint ${String(record.id)} (${String(plan?.summary?.writes ?? '?')} writes, ${String(plan?.summary?.deletes ?? '?')} deletes); file summaries recorded before the restore are marked stale`,
              importance: 3,
            })
          } catch (error) {
            ctx.logger.debug?.(`context-os: could not record restore: ${messageOf(error)}`)
          }
        }
        const offCreated = bus.on('checkpoint/created', recordCheckpoint)
        const offRestored = bus.on('checkpoint/restored', noteRestore)
        const dispose = (): void => {
          if (typeof offCreated === 'function') offCreated()
          if (typeof offRestored === 'function') offRestored()
        }
        if (typeof sub?.effect === 'function') sub.effect(() => dispose)
        else ctx.effect(() => dispose)
      })
    } catch (error) {
      ctx.logger.debug?.(`context-os: Time Machine interop unavailable: ${messageOf(error)}`)
    }
  }

  // ---- capture ------------------------------------------------------------
  const rememberInputs = (sessionId: string, event: any): number => {
    if (store === null) return 0
    const workspace = workspaceScopeOf(cwdBySession.get(sessionId))
    const inputs = ingestEvent(event, { scope: workspace, sessionId, now: Date.now() })
    let added = 0
    for (const input of inputs) {
      if (!captureEnabled(input.kind)) continue
      // L1 is task-local: keep it in the session namespace so another session in
      // the same workspace does not inherit this task's transient state.
      const scope = input.layer === 'L1' ? sessionScopeOf(sessionId) : input.scope
      try {
        const record = store.remember({ ...input, scope })
        events.emit('memory/added', { id: record.id, layer: record.layer, kind: record.kind, title: record.title })
        added += 1
      } catch (error) {
        ctx.logger.warn(`context-os: could not store ${input.kind} memory: ${messageOf(error)}`)
      }
    }
    return added
  }

  ctx.on('session/event', (session: any, event: any) => {
    try {
      if (config.enabled !== true || event === null || typeof event !== 'object') return
      const header = session?.header
      const id = typeof header?.id === 'string' ? header.id : typeof session?.id === 'string' ? session.id : 'unknown'
      sessions.set(id, session)
      if (typeof header?.cwd === 'string') cwdBySession.set(id, header.cwd)
      lastSessionId = id
      rememberInputs(id, event)
      if (event.type === 'turn/end' && config.retention.pruneOnTurnEnd && store !== null) {
        const { removed } = store.prune({ maxRecords: config.retention.maxRecords })
        if (removed > 0) ctx.logger.debug?.(`context-os: pruned ${String(removed)} memories`)
      }
    } catch (error) {
      ctx.logger.warn(`context-os: capture failed: ${messageOf(error)}`)
    }
  })

  ctx.on('session/disposed', (session: any) => {
    const id = typeof session?.header?.id === 'string' ? session.header.id : undefined
    if (id !== undefined) {
      sessions.delete(id)
      cwdBySession.delete(id)
    }
  })

  // ---- optional experimental brief injection ------------------------------
  const injectedTurns = new Set<string>()
  if (config.inject.enabled) {
    ctx.logger.warn('context-os: inject.enabled is EXPERIMENTAL — the brief is appended to the pre-step message list')
    ctx.on(
      'agent/pre-step',
      async (payload: any, next: () => Promise<any>) => {
        const result = await next()
        try {
          if (result?.kind !== 'enter' || !Array.isArray(result.messages)) return result
          const sessionId: string | undefined = payload?.agent?.session?.header?.id
          const turn: number | undefined = payload?.turn
          const step: number | undefined = payload?.step
          if (sessionId === undefined || step === undefined || step < config.inject.minSteps) return result
          const turnKey = `${sessionId}:${String(turn ?? 0)}`
          if (injectedTurns.has(turnKey)) return result
          const decision = buildDecision(sessionId)
          if (decision === null || !decision.injectBrief) return result
          const brief = buildBriefFor({ maxTokens: decision.briefTokens, sessionId })
          if (brief.text === '') return result
          if (result.messages.some((message: any) => containsMarker(message))) return result
          injectedTurns.add(turnKey)
          return {
            ...result,
            messages: [...result.messages, { role: 'user', content: [{ type: 'text', text: brief.text }] }],
          }
        } catch (error) {
          ctx.logger.warn(`context-os: brief injection skipped: ${messageOf(error)}`)
          return result
        }
      },
      { prepend: true },
    )
  }

  // ---- tools --------------------------------------------------------------
  const disposers = registerTools(service, {
    enabled: config.tools.enabled && store !== null,
    disabled: config.tools.disabled,
    recallLimit: config.tools.recallLimit,
    maxChars: config.tools.maxChars,
    register: (definition) => ctx.tools.register(definition),
    logger: ctx.logger,
  })

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // A tool that is already gone is not an error.
      }
    }
    events.clear()
    sessions.clear()
    cwdBySession.clear()
    store?.close()
    store = null
  })

  ctx.logger.info(
    `context-os: ready (mode=${config.mode}, ${store === null ? 'store disabled' : `store=${dbPath}`})`,
  )
}

/** Marker prefix used to recognise an injected brief. */
export const BRIEF_MARKER = '[Context OS brief]'

function containsMarker(message: any): boolean {
  const content = message?.content
  if (typeof content === 'string') return content.includes(BRIEF_MARKER)
  if (Array.isArray(content)) {
    return content.some((block: any) => typeof block?.text === 'string' && block.text.includes(BRIEF_MARKER))
  }
  return false
}

function emptyStats(path: string): StoreStats {
  return { total: 0, byLayer: { L1: 0, L2: 0, L3: 0 }, byKind: {}, expired: 0, stale: 0, bytes: 0, path }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Default store root, re-exported for the CLI helpers and tests. */
export { defaultRoot }
