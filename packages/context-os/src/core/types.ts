/**
 * Shared vocabulary for Context OS.
 *
 * The three layers are not storage tiers of the same data — they answer
 * different questions and age differently:
 *
 * - **L1 (active)** — what the current turn needs right now: the user's
 *   request, the newest errors, the files in flight. Short-lived, rewritten
 *   constantly, never retrieved by similarity.
 * - **L2 (working memory)** — what the *task* needs across turns: architecture
 *   decisions, interface contracts, progress, open questions. Written by the
 *   agent (`co_remember`) or captured from goals/todos/compaction summaries.
 * - **L3 (long-term)** — what *other* tasks may need later: compaction
 *   summaries, past session digests, documentation notes. Retrieved by FTS5.
 *
 * Every record carries provenance (`source`), a scope (session/workspace/
 * global) and an expiry mechanism (`expiresAt`, `stale`), because a memory
 * without provenance cannot be trusted and a memory without a scope leaks
 * between unrelated tasks.
 */

/** Memory layer. */
export type MemoryLayer = 'L1' | 'L2' | 'L3'

/** What the record is, used for filtering and for the brief's section order. */
export type MemoryKind =
  | 'goal'
  | 'user-request'
  | 'decision'
  | 'contract'
  | 'progress'
  | 'todo'
  | 'error'
  | 'file'
  | 'note'
  | 'compaction-summary'
  | 'session-digest'
  | 'checkpoint'

/** Where the record came from — the trust boundary of every memory. */
export type MemorySourceKind =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'compaction'
  | 'checkpoint'
  | 'session'
  | 'manual'

/** Provenance: which event, tool call, checkpoint or compaction produced this. */
export interface MemorySource {
  kind: MemorySourceKind
  /** Session event seq, tool call id, checkpoint id, compaction id, … */
  ref?: string
}

/** Scope: a record belongs to one session, one workspace, or the whole install. */
export type MemoryScopeKind = 'session' | 'workspace' | 'global'

export interface MemoryScope {
  kind: MemoryScopeKind
  id: string
}

/** A stored memory record. */
export interface MemoryRecord {
  id: string
  layer: MemoryLayer
  kind: MemoryKind
  scope: MemoryScope
  title: string
  body: string
  tags: string[]
  source: MemorySource
  /** 0..3 — 3 is "must survive compaction". */
  importance: number
  createdAt: number
  updatedAt: number
  /** Epoch millis; past this instant the record is archived (not returned). */
  expiresAt?: number
  /** Marks a record whose underlying files/decisions may have been rolled back. */
  stale?: boolean
  contentHash: string
}

/** Input accepted by `ContextStore.remember` — ids and timestamps are assigned. */
export interface RememberInput {
  layer: MemoryLayer
  kind: MemoryKind
  scope: MemoryScope
  title: string
  body: string
  tags?: string[]
  source?: MemorySource
  importance?: number
  /** Time-to-live in milliseconds from now. */
  ttlMs?: number
  /** Deterministic id for idempotent upserts (e.g. one record per turn). */
  key?: string
}

/** Filters accepted by `recall` and `list`. */
export interface RecallQuery {
  /** Free text. Empty means "no text filter" (list by importance/recency). */
  text?: string
  layers?: MemoryLayer[]
  kinds?: MemoryKind[]
  scope?: MemoryScope
  /** Only records with at least this importance. */
  minImportance?: number
  limit?: number
  /** Include expired records (default false). */
  includeExpired?: boolean
  /** Include records flagged stale (default true — the caller decides). */
  includeStale?: boolean
}

/** One scored hit. */
export interface RecallHit {
  record: MemoryRecord
  /** Higher is better; composed from FTS5 bm25, importance and recency. */
  score: number
  /** Which signals produced the score, for debugging and for the UI. */
  reasons: string[]
}

/** Context window accounting for one session at one moment. */
export interface ContextUsage {
  /** Best-effort total tokens currently in the model's view. */
  totalTokens: number
  /** How the total was obtained. */
  basis: 'usage' | 'estimated' | 'none'
  /** Session event revision the measurement describes. */
  revision: number
  /**
   * Context window the measurement belongs to, when the harness reports one.
   * Prefer this over the configured fallback: a configuration default can be
   * orders of magnitude off the real window (131 072 against a 1 048 576-token
   * route, for example), which makes every pressure decision wrong.
   */
  windowTokens?: number
}

/** Budget policy names. */
export type BudgetMode = 'conservative' | 'balanced' | 'saver'

/** A budget decision for one step. */
export interface BudgetDecision {
  mode: BudgetMode
  /** True when the brief should be contributed to this step. */
  injectBrief: boolean
  /** Hard cap for the brief, in tokens. */
  briefTokens: number
  /** Tokens that must remain free after the brief is added. */
  retainTokens: number
  /** Human-readable reason, surfaced in `co_status`. */
  reason: string
  /** Fraction of the window currently used (0..1+). */
  pressure: number
}
