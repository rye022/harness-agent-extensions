/**
 * Framework-free core of Context OS. Everything here runs without Cordis or a
 * running Harness, which is what makes it testable in isolation.
 */
export * from './types.ts'
export { ContextStore, CONTEXT_OS_SCHEMA, memoryHash, newMemoryId, clampImportance } from './store.ts'
export type { StoreOptions, StoreStats } from './store.ts'
export { toSearchText, toMatchQuery, extractIdentifiers, isCjkCodePoint } from './tokenize.ts'
export { BUDGET_PROFILES, decideBudget, resolveProfile } from './budget.ts'
export type { BudgetOptions, BudgetProfile } from './budget.ts'
export { buildBrief, snippet } from './brief.ts'
export type { Brief, BriefOptions, BriefSection } from './brief.ts'
export { ingestEvent, textOf, errorOf, touchedPath, isIngestible, INGESTED_TYPES, LAYER_KINDS } from './ingest.ts'
export type { EventLike, IngestContext } from './ingest.ts'
