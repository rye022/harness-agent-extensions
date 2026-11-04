/**
 * CJK-aware text normalisation for SQLite FTS5.
 *
 * FTS5's `unicode61` tokenizer treats a run of CJK characters as ONE token
 * (`主人喜欢鬼畜视频` is a single term), so a query for `鬼畜` matches nothing
 * unless we pre-tokenize. We index a *search text* where every CJK character is
 * its own token and Latin/digit runs stay whole, and we build phrase queries
 * (`"鬼 畜"`) so adjacent characters must appear in order. That keeps recall
 * for Chinese/Japanese/Korean text without pulling in a segmenter, and it keeps
 * identifiers such as `BV187po6qE7Y` searchable as one term.
 */

/** True for CJK ideographs, kana, and hangul — scripts without word spaces. */
export function isCjkCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK extension A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK unified ideographs
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // compatibility ideographs
    (codePoint >= 0x3040 && codePoint <= 0x30ff) || // hiragana + katakana
    (codePoint >= 0xac00 && codePoint <= 0xd7af) || // hangul syllables
    (codePoint >= 0x20000 && codePoint <= 0x2fa1f) // CJK extensions B..F
  )
}

/** Characters that end an alphanumeric run. */
function isAsciiWordChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x61 && code <= 0x7a) || // a-z (input is lowercased)
    (code >= 0x41 && code <= 0x5a) || // A-Z (defensive)
    code === 0x5f // _
  )
}

/**
 * Normalise text into the form stored in the FTS index.
 *
 * @example toSearchText('主人喜欢鬼畜视频BV1RJHV6pECP') === '主 人 喜 欢 鬼 畜 视 频 bv1rj hv6pecp'
 */
export function toSearchText(input: string): string {
  const text = input.toLowerCase()
  const out: string[] = []
  let word = ''
  const flush = (): void => {
    if (word !== '') {
      out.push(word)
      word = ''
    }
  }
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (isCjkCodePoint(code)) {
      flush()
      out.push(ch)
      continue
    }
    if (isAsciiWordChar(code)) {
      word += ch
      continue
    }
    flush()
  }
  flush()
  return out.join(' ')
}

/** Escape a literal term for FTS5 (double quotes inside are doubled). */
function quoteTerm(term: string): string {
  return `"${term.replace(/"/g, '""')}"`
}

/**
 * Build an FTS5 MATCH expression from free text.
 *
 * Every whitespace-separated segment becomes one conjunct. A segment with CJK
 * characters becomes a phrase of its characters (`"鬼 畜"`), a segment of Latin
 * letters/digits becomes a single term. Unknown punctuation is dropped by
 * `toSearchText` before this runs, so user input cannot inject FTS syntax.
 *
 * @returns the MATCH expression, or `undefined` when nothing is searchable.
 */
export function toMatchQuery(input: string): string | undefined {
  const normalised = toSearchText(input)
  if (normalised === '') return undefined
  const segments = normalised.split(' ')
  const conjuncts = new Map<string, string>()
  let run: string[] = []
  const flushRun = (): void => {
    if (run.length === 0) return
    const phrase = quoteTerm(run.join(' '))
    conjuncts.set(phrase, phrase)
    run = []
  }
  for (const segment of segments) {
    if (segment === '') continue
    if (isCjkCodePoint(segment.codePointAt(0) ?? 0)) {
      run.push(segment)
      continue
    }
    flushRun()
    const term = quoteTerm(segment)
    if (!conjuncts.has(term)) conjuncts.set(term, term)
  }
  flushRun()
  const list = [...conjuncts.values()]
  if (list.length === 0) return undefined
  return list.join(' ')
}

/** Extract `co_` style keywords the brief should always keep (paths, ids, errors). */
export function extractIdentifiers(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(/(?:[A-Za-z]:[\\/]|\.{1,2}[\\/])?[\w.@-]*[\\/][\w.@\\/-]+/g)) {
    const value = match[0]
    if (value.length >= 3) found.add(value)
  }
  for (const match of text.matchAll(/\bBV[0-9A-Za-z]{10}\b/g)) found.add(match[0])
  for (const match of text.matchAll(/\b[A-Z][A-Z0-9_]{3,}\b/g)) found.add(match[0])
  for (const match of text.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g)) found.add(match[0])
  return [...found]
}
