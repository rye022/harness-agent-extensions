/**
 * Dynamic token budget.
 *
 * The three modes trade context fidelity against cost. They are *policies for
 * contributing a brief*, never for compacting: Context OS does not own the
 * compaction loop (billion-context/compaction-basic do), it only decides when
 * the extra memory text is worth its tokens.
 *
 * - `conservative` — inject late (85% of the window) with a generous cap, so a
 *   running task is left alone until it is genuinely under pressure.
 * - `balanced` — inject from 70%.
 * - `saver` — inject early (50%) with a small cap, so the model re-reads a
 *   short digest instead of carrying history.
 *
 * `retainTokens` is a floor on free space: the brief is not allowed to eat into
 * the room a turn needs to finish, which is the failure mode of naive "compress
 * to make room" loops. The floor is capped at half of the remaining room, so at
 * high pressure a short brief can still fit instead of being locked out by a
 * reserve that is larger than what is left.
 */
import type { BudgetDecision, BudgetMode, ContextUsage } from './types.ts'

/** Smallest brief worth contributing: below this it is noise, not memory. */
const MIN_BRIEF_TOKENS = 80

/** Per-mode defaults, as fractions of the context window. */
export interface BudgetProfile {
  /** Pressure at which the brief starts being contributed. */
  threshold: number
  /** Maximum tokens the brief may occupy. */
  briefCapTokens: number
  /** Tokens that must stay free for the turn itself. */
  retainTokens: number
  /** Extra memories to pull in, used as the "aggressiveness" knob. */
  recallLimit: number
}

/** Profiles keyed by mode. Values are fractions of the window except recallLimit. */
export const BUDGET_PROFILES: Record<BudgetMode, BudgetProfile> = {
  /**
   * Conservative fires late (85 %), so its reserve has to be smaller than the
   * 15 % that is still free at that point — otherwise the reserve check can
   * never pass and the mode silently never contributes a brief. 10 % leaves a
   * 5 % band (85–90 %) in which a brief is allowed.
   */
  conservative: { threshold: 0.85, briefCapTokens: 0.012, retainTokens: 0.1, recallLimit: 4 },
  balanced: { threshold: 0.7, briefCapTokens: 0.009, retainTokens: 0.2, recallLimit: 6 },
  saver: { threshold: 0.5, briefCapTokens: 0.006, retainTokens: 0.15, recallLimit: 8 },
}

export interface BudgetOptions {
  /** Effective context window for the current route, in tokens. */
  windowTokens: number
  mode: BudgetMode
  /** Replace the profile's threshold (0..1). */
  threshold?: number
  /** Replace the profile's brief cap, in tokens. */
  briefCapTokens?: number
  /** Replace the profile's retain floor, in tokens (not a fraction). */
  retainTokens?: number
}

/** Resolve a profile into absolute token numbers. */
export function resolveProfile(options: BudgetOptions): { threshold: number; briefCapTokens: number; retainTokens: number; recallLimit: number } {
  const base = BUDGET_PROFILES[options.mode]
  const window = Math.max(1, Math.round(options.windowTokens))
  const threshold = clamp01(options.threshold ?? base.threshold)
  const briefCapTokens = Math.max(120, Math.round(options.briefCapTokens ?? base.briefCapTokens * window))
  const retainTokens = Math.max(0, Math.round(options.retainTokens ?? base.retainTokens * window))
  return { threshold, briefCapTokens, retainTokens, recallLimit: base.recallLimit }
}

/** Decide whether this step gets a brief and how large it may be. */
export function decideBudget(usage: ContextUsage, options: BudgetOptions): BudgetDecision {
  /**
   * The measured window wins over the configured one: config is a fallback for
   * harnesses that do not report a window, and a stale default silently turns
   * every pressure decision into nonsense (free tokens come out negative).
   */
  const effectiveWindow =
    usage.windowTokens !== undefined && usage.windowTokens > 0 ? usage.windowTokens : options.windowTokens
  const effectiveOptions: BudgetOptions = { ...options, windowTokens: effectiveWindow }
  const profile = resolveProfile(effectiveOptions)
  const window = Math.max(1, Math.round(effectiveWindow))
  const used = Math.max(0, Math.round(usage.totalTokens))
  const pressure = used / window
  const free = window - used

  if (pressure < profile.threshold) {
    return {
      mode: options.mode,
      injectBrief: false,
      briefTokens: 0,
      retainTokens: profile.retainTokens,
      reason: `pressure ${(pressure * 100).toFixed(1)}% is below the ${options.mode} threshold ${(profile.threshold * 100).toFixed(0)}%`,
      pressure,
    }
  }
  /**
   * The reserve is capped at half of the remaining room.
   *
   * Honouring a 10–20 % floor literally at high pressure makes the brief
   * impossible exactly when it matters most: with 8 000 tokens free and a
   * 20 000-token floor the old rule reported "nothing left" although a
   * 900-token brief would have fit. Half the headroom is the most a
   * contributor may take; the other half stays for the turn itself.
   */
  const reserve = Math.min(profile.retainTokens, Math.max(0, Math.floor(free / 2)))
  const available = free - reserve
  if (available < MIN_BRIEF_TOKENS) {
    return {
      mode: options.mode,
      injectBrief: false,
      briefTokens: 0,
      retainTokens: profile.retainTokens,
      reason: `no room for a brief: ${String(Math.max(0, free))} tokens free, ${String(reserve)} reserved, ${String(Math.max(0, available))} usable (< ${String(MIN_BRIEF_TOKENS)})`,
      pressure,
    }
  }
  const briefTokens = Math.min(profile.briefCapTokens, available)
  if (briefTokens < MIN_BRIEF_TOKENS) {
    return {
      mode: options.mode,
      injectBrief: false,
      briefTokens: 0,
      retainTokens: profile.retainTokens,
      reason: `budget left for a brief is only ${String(briefTokens)} tokens (< ${String(MIN_BRIEF_TOKENS)})`,
      pressure,
    }
  }
  return {
    mode: options.mode,
    injectBrief: true,
    briefTokens,
    retainTokens: profile.retainTokens,
    reason: `pressure ${(pressure * 100).toFixed(1)}% ≥ ${(profile.threshold * 100).toFixed(0)}% (${options.mode}), contributing up to ${String(briefTokens)} tokens`,
    pressure,
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}
