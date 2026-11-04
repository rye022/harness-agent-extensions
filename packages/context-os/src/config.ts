/**
 * Configuration for Context OS.
 *
 * Every field has a working default and `normalizeConfig` never throws: a typo
 * in a patch file degrades one knob, it does not prevent the Harness from
 * booting (a plugin that throws during mount takes its dependents with it).
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { BudgetMode } from './core/types.ts'

/** Configuration accepted by the Context OS bundle patch. */
export interface ContextOsConfig {
  enabled: boolean
  /** Store root; defaults to `<DSH_HOME>/context-os`. */
  root?: string
  /** Database file; defaults to `<root>/context.db`. */
  dbFile?: string
  /** Budget mode: conservative | balanced | saver. */
  mode: BudgetMode
  /** Effective context window used for pressure math, in tokens. */
  windowTokens: number
  /** Override the mode's pressure threshold (0..1). */
  threshold?: number
  /** Override the brief cap in absolute tokens. */
  briefCapTokens?: number
  /** Override the retention floor in absolute tokens. */
  retainTokens?: number
  capture: {
    userMessages: boolean
    toolErrors: boolean
    files: boolean
    compaction: boolean
    goals: boolean
  }
  retention: {
    /** Maximum rows kept in the store (0 = unlimited). */
    maxRecords: number
    /** L1 time-to-live, in hours. */
    l1TtlHours: number
    /** Prune on every turn end. */
    pruneOnTurnEnd: boolean
    /** Days after which compaction summaries are dropped. */
    summaryTtlDays: number
  }
  inject: {
    /**
     * EXPERIMENTAL: append the brief as a user message in `agent/pre-step`.
     * Off by default — a wrong message shape can break a turn, and the brief is
     * already available through `co_brief` plus the client panel.
     */
    enabled: boolean
    /** Minimum steps between injections for one session. */
    minSteps: number
  }
  tools: {
    enabled: boolean
    disabled: string[]
    /** Default number of hits returned by `co_recall`. */
    recallLimit: number
    /** Maximum characters of a body returned by `co_recall`. */
    maxChars: number
  }
}

/** Defaults matching the documented "balanced" mode. */
export const DEFAULT_CONFIG: ContextOsConfig = {
  enabled: true,
  mode: 'balanced',
  windowTokens: 131_072,
  capture: { userMessages: true, toolErrors: true, files: true, compaction: true, goals: true },
  retention: { maxRecords: 20_000, l1TtlHours: 12, pruneOnTurnEnd: true, summaryTtlDays: 30 },
  inject: { enabled: false, minSteps: 3 },
  tools: { enabled: true, disabled: [], recallLimit: 8, maxChars: 600 },
}

/** A problem found while normalising user input. */
export interface ConfigIssue {
  path: string
  message: string
  value?: unknown
}

/** Result of `normalizeConfig`. */
export interface NormalizedConfig {
  config: ContextOsConfig
  issues: ConfigIssue[]
}

/** `<DSH_HOME>` with the CLI's own fallback. */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.DSH_HOME
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/** Default store root. */
export function defaultRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(dshHome(env), 'context-os')
}

/** Resolve the database file for a config. */
export function resolveDbPath(config: ContextOsConfig, env: NodeJS.ProcessEnv = process.env): string {
  if (config.dbFile !== undefined && config.dbFile !== '') return config.dbFile
  return join(config.root ?? defaultRoot(env), 'context.db')
}

const MODES: BudgetMode[] = ['conservative', 'balanced', 'saver']

/** Clamp `raw` into the documented shape, collecting issues instead of throwing. */
export function normalizeConfig(raw: unknown): NormalizedConfig {
  const issues: ConfigIssue[] = []
  const config: ContextOsConfig = {
    ...DEFAULT_CONFIG,
    capture: { ...DEFAULT_CONFIG.capture },
    retention: { ...DEFAULT_CONFIG.retention },
    inject: { ...DEFAULT_CONFIG.inject },
    tools: { ...DEFAULT_CONFIG.tools, disabled: [] },
  }
  if (raw === null || raw === undefined) return { config, issues }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ path: '', message: 'config must be an object', value: raw })
    return { config, issues }
  }
  const input = raw as Record<string, unknown>

  const bool = (key: string, target: (value: boolean) => void): void => {
    const value = input[key]
    if (value === undefined) return
    if (typeof value !== 'boolean') {
      issues.push({ path: key, message: 'expected a boolean', value })
      return
    }
    target(value)
  }
  const num = (key: string, target: (value: number) => void, min: number, max: number): void => {
    const value = input[key]
    if (value === undefined) return
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      issues.push({ path: key, message: 'expected a finite number', value })
      return
    }
    if (value < min || value > max) {
      issues.push({ path: key, message: `expected a number in [${String(min)}, ${String(max)}]`, value })
      return
    }
    target(value)
  }
  const str = (key: string, target: (value: string) => void): void => {
    const value = input[key]
    if (value === undefined) return
    if (typeof value !== 'string') {
      issues.push({ path: key, message: 'expected a string', value })
      return
    }
    if (value !== '') target(value)
  }

  bool('enabled', (value) => {
    config.enabled = value
  })
  str('root', (value) => {
    config.root = value
  })
  str('dbFile', (value) => {
    config.dbFile = value
  })
  const mode = input.mode
  if (mode !== undefined) {
    if (typeof mode === 'string' && (MODES as string[]).includes(mode)) config.mode = mode as BudgetMode
    else issues.push({ path: 'mode', message: `expected one of ${MODES.join(' | ')}`, value: mode })
  }
  num('windowTokens', (value) => {
    config.windowTokens = Math.round(value)
  }, 1000, 100_000_000)
  num('threshold', (value) => {
    config.threshold = value
  }, 0, 1)
  num('briefCapTokens', (value) => {
    config.briefCapTokens = Math.round(value)
  }, 80, 200_000)
  num('retainTokens', (value) => {
    config.retainTokens = Math.round(value)
  }, 0, 1_000_000)

  const capture = asObject(input.capture, 'capture', issues)
  if (capture !== undefined) {
    for (const key of ['userMessages', 'toolErrors', 'files', 'compaction', 'goals'] as const) {
      const value = capture[key]
      if (value === undefined) continue
      if (typeof value === 'boolean') config.capture[key] = value
      else issues.push({ path: `capture.${key}`, message: 'expected a boolean', value })
    }
  }
  const retention = asObject(input.retention, 'retention', issues)
  if (retention !== undefined) {
    const maxRecords = retention.maxRecords
    if (typeof maxRecords === 'number' && Number.isFinite(maxRecords) && maxRecords >= 0) config.retention.maxRecords = Math.round(maxRecords)
    else if (maxRecords !== undefined) issues.push({ path: 'retention.maxRecords', message: 'expected a non-negative number', value: maxRecords })
    const ttl = retention.l1TtlHours
    if (typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0) config.retention.l1TtlHours = ttl
    else if (ttl !== undefined) issues.push({ path: 'retention.l1TtlHours', message: 'expected a positive number', value: ttl })
    const prune = retention.pruneOnTurnEnd
    if (typeof prune === 'boolean') config.retention.pruneOnTurnEnd = prune
    else if (prune !== undefined) issues.push({ path: 'retention.pruneOnTurnEnd', message: 'expected a boolean', value: prune })
    const summaryTtl = retention.summaryTtlDays
    if (typeof summaryTtl === 'number' && Number.isFinite(summaryTtl) && summaryTtl > 0) config.retention.summaryTtlDays = summaryTtl
    else if (summaryTtl !== undefined) issues.push({ path: 'retention.summaryTtlDays', message: 'expected a positive number', value: summaryTtl })
  }
  const inject = asObject(input.inject, 'inject', issues)
  if (inject !== undefined) {
    const enabled = inject.enabled
    if (typeof enabled === 'boolean') config.inject.enabled = enabled
    else if (enabled !== undefined) issues.push({ path: 'inject.enabled', message: 'expected a boolean', value: enabled })
    const minSteps = inject.minSteps
    if (typeof minSteps === 'number' && Number.isFinite(minSteps) && minSteps >= 0) config.inject.minSteps = Math.round(minSteps)
    else if (minSteps !== undefined) issues.push({ path: 'inject.minSteps', message: 'expected a non-negative number', value: minSteps })
  }
  const tools = asObject(input.tools, 'tools', issues)
  if (tools !== undefined) {
    const enabled = tools.enabled
    if (typeof enabled === 'boolean') config.tools.enabled = enabled
    else if (enabled !== undefined) issues.push({ path: 'tools.enabled', message: 'expected a boolean', value: enabled })
    const disabled = tools.disabled
    if (Array.isArray(disabled)) {
      config.tools.disabled = disabled.filter((item): item is string => typeof item === 'string')
      if (config.tools.disabled.length !== disabled.length) issues.push({ path: 'tools.disabled', message: 'ignored non-string entries', value: disabled })
    } else if (disabled !== undefined) issues.push({ path: 'tools.disabled', message: 'expected a string array', value: disabled })
    const recallLimit = tools.recallLimit
    if (typeof recallLimit === 'number' && Number.isFinite(recallLimit) && recallLimit >= 1) config.tools.recallLimit = Math.round(recallLimit)
    else if (recallLimit !== undefined) issues.push({ path: 'tools.recallLimit', message: 'expected a number >= 1', value: recallLimit })
    const maxChars = tools.maxChars
    if (typeof maxChars === 'number' && Number.isFinite(maxChars) && maxChars >= 80) config.tools.maxChars = Math.round(maxChars)
    else if (maxChars !== undefined) issues.push({ path: 'tools.maxChars', message: 'expected a number >= 80', value: maxChars })
  }
  return { config, issues }
}

function asObject(value: unknown, path: string, issues: ConfigIssue[]): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ path, message: 'expected an object', value })
    return undefined
  }
  return value as Record<string, unknown>
}
