/**
 * Brief composition.
 *
 * A brief is the text Context OS contributes when the context window comes
 * under pressure. It is deliberately *not* a summary of the conversation — the
 * compaction machinery already produces one. It is the short list of facts that
 * a summary tends to lose and that a resumed task cannot proceed without:
 *
 * 1. what the user asked for (L1),
 * 2. errors still unresolved (L1),
 * 3. files in flight (L1),
 * 4. decisions and contracts that must not be contradicted (L2),
 * 5. the highest-scoring long-term memories for the current text (L3).
 *
 * Lines are added in that order until the token budget runs out, so a tiny
 * budget still yields the most important section instead of a truncated salad.
 */
import { estimateTokens } from '@harness-ext/shared'

import type { ContextStore } from './store.ts'
import type { MemoryKind, MemoryLayer, MemoryRecord, MemoryScope } from './types.ts'

export interface BriefOptions {
  /**
   * Scope(s) to read from, most specific first. A brief for a running session
   * passes `[session, workspace, global]`: L1 lives in the session namespace,
   * L2 in the workspace, L3 may be global.
   */
  scope: MemoryScope | MemoryScope[]
  /** Free text used for the L3 recall section (usually the latest user message). */
  query?: string
  /** Hard cap in tokens. */
  maxTokens: number
  /** How many recall hits to consider. */
  recallLimit?: number
  /** Include records whose files may have been rolled back. */
  includeStale?: boolean
  /** Heading shown above the brief. */
  heading?: string
}

export interface BriefSection {
  layer: MemoryLayer
  title: string
  lines: string[]
  tokens: number
}

export interface Brief {
  text: string
  tokens: number
  sections: BriefSection[]
  /** Ids included, so the caller can record what has been shown. */
  recordIds: string[]
  truncated: boolean
}

/**
 * Sections, in display order. Sections are keyed by *kind*, not by layer: an
 * error captured in a workspace scope is still an open error, and a decision
 * recorded against a session is still a decision. The layer in the spec only
 * decides the section label.
 */
const SECTION_SPECS: { layer: MemoryLayer; title: string; kinds: MemoryKind[]; limit: number }[] = [
  { layer: 'L1', title: 'Request', kinds: ['user-request', 'goal'], limit: 2 },
  { layer: 'L1', title: 'Open errors', kinds: ['error'], limit: 3 },
  { layer: 'L1', title: 'Files in flight', kinds: ['file'], limit: 4 },
  { layer: 'L2', title: 'Decisions & contracts', kinds: ['decision', 'contract'], limit: 5 },
  { layer: 'L2', title: 'Progress & todos', kinds: ['progress', 'todo'], limit: 4 },
]

const DEFAULT_HEADING = '[Context OS brief] Memory that must survive compaction:'

/** Compose a brief from the store, respecting `maxTokens`. */
export function buildBrief(store: ContextStore, options: BriefOptions): Brief {
  const sections: BriefSection[] = []
  const included = new Set<string>()
  const lines: string[] = []
  const heading = options.heading ?? DEFAULT_HEADING
  const scopes = Array.isArray(options.scope) ? options.scope : [options.scope]
  let used = estimateTokens(heading)
  let truncated = false
  let anyLine = false

  /** Query every scope in order and merge by record id, best score first. */
  const gather = (query: { text?: string; layers?: MemoryLayer[]; kinds?: MemoryKind[]; limit: number }): { record: MemoryRecord; score: number }[] => {
    const seen = new Set<string>()
    const scored: { record: MemoryRecord; score: number }[] = []
    for (const scope of scopes) {
      for (const hit of store.recall({
        ...(query.text === undefined ? {} : { text: query.text }),
        ...(query.layers === undefined ? {} : { layers: query.layers }),
        ...(query.kinds === undefined ? {} : { kinds: query.kinds }),
        scope,
        limit: query.limit,
        includeStale: options.includeStale === true,
      })) {
        if (seen.has(hit.record.id)) continue
        seen.add(hit.record.id)
        scored.push({ record: hit.record, score: hit.score })
      }
    }
    scored.sort((left, right) => right.score - left.score)
    return scored.slice(0, query.limit)
  }

  const push = (section: BriefSection, text: string): boolean => {
    const cost = estimateTokens(text)
    if (used + cost > options.maxTokens) {
      truncated = true
      return false
    }
    section.lines.push(text)
    section.tokens += cost
    used += cost
    anyLine = true
    return true
  }

  for (const spec of SECTION_SPECS) {
    const section: BriefSection = { layer: spec.layer, title: spec.title, lines: [], tokens: 0 }
    const headerCost = estimateTokens(`- ${spec.title}:`)
    const entries = gather({ kinds: spec.kinds, limit: spec.limit })
    if (entries.length === 0) continue
    if (used + headerCost > options.maxTokens) {
      truncated = true
      break
    }
    used += headerCost
    for (const entry of entries) {
      const record = entry.record
      if (included.has(record.id)) continue
      const text = `  - ${snippet(record)}`
      if (!push(section, text)) break
      included.add(record.id)
    }
    if (section.lines.length > 0) sections.push(section)
  }

  // Long-term recall: only when the budget still has room and there is a query.
  if (options.query !== undefined && options.query.trim() !== '') {
    const section: BriefSection = { layer: 'L3', title: 'Recalled', lines: [], tokens: 0 }
    const entries = gather({ text: options.query, limit: Math.max(1, options.recallLimit ?? 6) })
    const headerCost = estimateTokens('- Recalled:')
    if (entries.length > 0 && used + headerCost <= options.maxTokens) {
      used += headerCost
      for (const entry of entries) {
        if (included.has(entry.record.id)) continue
        if (entry.record.layer === 'L1' && entry.score < 0.5) continue
        const text = `  - ${snippet(entry.record)}`
        if (!push(section, text)) break
        included.add(entry.record.id)
      }
      if (section.lines.length > 0) sections.push(section)
    }
  }

  if (!anyLine) {
    return { text: '', tokens: 0, sections: [], recordIds: [], truncated: false }
  }

  const body: string[] = [heading]
  for (const section of sections) {
    body.push(`- ${section.title}:`)
    body.push(...section.lines)
  }
  const text = body.join('\n')
  return { text, tokens: estimateTokens(text), sections, recordIds: [...included], truncated }
}

/** Render a compact single-line representation of a memory. */
export function snippet(record: MemoryRecord, maxChars = 220): string {
  const body = record.body.replace(/\s+/g, ' ').trim()
  const label = record.kind === 'file' ? 'file' : record.kind
  const head = record.title.trim() === '' ? body : record.title.trim()
  const tail = body === '' || body === head ? '' : ` — ${body}`
  const text = `(${label}) ${head}${tail}`
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`
}
