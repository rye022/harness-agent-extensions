/**
 * Token estimation.
 *
 * The harness exposes exact usage through `@deepseek-ai/dsh-token-meter`; this
 * module only exists for content the meter has not seen (retrieved memory
 * records, stored documents, a draft compression summary). Every number coming
 * out of here is an estimate and every caller must label it as one.
 *
 * The heuristic is deliberately simple and documented: one token per CJK
 * character, and one token per four non-CJK characters, which tracks the
 * provider tokenizers closely enough for budgeting decisions but is not a
 * tokenizer.
 *
 * @module @harness-ext/shared/tokens
 */
const CJK = /[\u1100-\u11ff\u2e80-\u303f\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/u;

/** Rough token count for a text. */
export function estimateTokens(text: string): number {
  if (text === '') return 0;
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (CJK.test(char)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/** Rough token count for a JSON-serialisable value. */
export function estimateTokensOf(value: unknown): number {
  if (typeof value === 'string') return estimateTokens(value);
  try {
    return estimateTokens(JSON.stringify(value));
  } catch {
    return 0;
  }
}
