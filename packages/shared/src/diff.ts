/**
 * Line diff with hunks, used for checkpoint comparisons and restore previews.
 *
 * The implementation is a plain Myers edit script with a hard search budget.
 * When the budget is exceeded (very large or heavily rewritten files) the diff
 * degrades to a single coarse hunk that replaces every line, and says so via
 * `coarse`, so callers can warn the user instead of pretending the comparison
 * was line-accurate.
 *
 * @module @harness-ext/shared/diff
 */

/** One user-visible line of a hunk. */
export interface DiffLine {
  sign: ' ' | '+' | '-';
  text: string;
}

/** A contiguous region of change with surrounding context. */
export interface DiffHunk {
  /** 1-based first line of the hunk in the old file (0 when the old file is empty). */
  oldStart: number;
  oldLines: number;
  /** 1-based first line of the hunk in the new file (0 when the new file is empty). */
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

/** Options controlling diff cost and context. */
export interface DiffOptions {
  /** Context lines kept around each change. Defaults to 3. */
  contextLines?: number;
  /** Upper bound of edit-script length explored before degrading. Defaults to 4000. */
  maxEditDistance?: number;
  /** Files with more lines on either side than this degrade immediately. Defaults to 200000. */
  maxLines?: number;
}

/** Result of a line comparison. */
export interface DiffResult {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /** True when the comparison degraded to one whole-file replacement. */
  coarse: boolean;
  oldLineCount: number;
  newLineCount: number;
}

type OpKind = 'equal' | 'insert' | 'delete';

interface DiffOp {
  kind: OpKind;
  oldIndex: number;
  newIndex: number;
}

/**
 * Split text into lines, treating CRLF, CR and LF as separators.
 *
 * A single trailing separator does not create an extra empty line: `"a\n"`
 * has one line, not two. This keeps hunk headers and change counts identical
 * to what `git diff` reports for newline-terminated files.
 */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function diffRaw(a: readonly string[], b: readonly string[], maxEditDistance: number): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  const v = new Map<number, number>();
  v.set(1, 0);
  const trace: Map<number, number>[] = [];
  const limit = Math.min(n + m, maxEditDistance);
  for (let d = 0; d <= limit; d += 1) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))) {
        x = v.get(k + 1) ?? 0;
      } else {
        x = (v.get(k - 1) ?? 0) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v.set(k, x);
      if (x >= n && y >= m) return backtrack(trace, a.length, b.length, d);
    }
  }
  return null;
}

function backtrack(trace: readonly Map<number, number>[], oldSize: number, newSize: number, distance: number): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = oldSize;
  let y = newSize;
  for (let depth = distance; depth > 0; depth -= 1) {
    const layer = trace[depth]!;
    const k = x - y;
    const down = k === -depth || (k !== depth && (layer.get(k - 1) ?? -1) < (layer.get(k + 1) ?? -1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = layer.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: 'equal', oldIndex: x - 1, newIndex: y - 1 });
      x -= 1;
      y -= 1;
    }
    if (down) {
      ops.push({ kind: 'insert', oldIndex: x, newIndex: y - 1 });
      y -= 1;
    } else {
      ops.push({ kind: 'delete', oldIndex: x - 1, newIndex: y });
      x -= 1;
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: 'equal', oldIndex: x - 1, newIndex: y - 1 });
    x -= 1;
    y -= 1;
  }
  return ops.reverse();
}

function coarseResult(oldLines: readonly string[], newLines: readonly string[]): DiffResult {
  const lines: DiffLine[] = [
    ...oldLines.map((text): DiffLine => ({ sign: '-', text })),
    ...newLines.map((text): DiffLine => ({ sign: '+', text })),
  ];
  return {
    hunks:
      lines.length === 0
        ? []
        : [
            {
              oldStart: oldLines.length === 0 ? 0 : 1,
              oldLines: oldLines.length,
              newStart: newLines.length === 0 ? 0 : 1,
              newLines: newLines.length,
              lines,
            },
          ],
    added: newLines.length,
    removed: oldLines.length,
    coarse: true,
    oldLineCount: oldLines.length,
    newLineCount: newLines.length,
  };
}

/** Compare two texts line by line and return hunks plus counts. */
export function diffTexts(oldText: string, newText: string, options: DiffOptions = {}): DiffResult {
  const contextLines = options.contextLines ?? 3;
  const maxEditDistance = options.maxEditDistance ?? 4000;
  const maxLines = options.maxLines ?? 200000;
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  if (oldLines.length > maxLines || newLines.length > maxLines) return coarseResult(oldLines, newLines);

  const ops = diffRaw(oldLines, newLines, maxEditDistance);
  if (ops === null) return coarseResult(oldLines, newLines);

  const hunks: DiffHunk[] = [];
  let added = 0;
  let removed = 0;
  let index = 0;
  while (index < ops.length) {
    const op = ops[index]!;
    if (op.kind === 'equal') {
      index += 1;
      continue;
    }
    // Collect a run of changes, allowing equal runs shorter than 2*context to
    // be absorbed into the same hunk.
    let last = index;
    let probe = index;
    while (probe < ops.length) {
      if (ops[probe]!.kind === 'equal') {
        let gap = 0;
        while (probe + gap < ops.length && ops[probe + gap]!.kind === 'equal') gap += 1;
        if (gap > contextLines * 2) break;
        probe += gap;
      } else {
        last = probe;
        probe += 1;
      }
    }
    const changeStart = index;
    const changeEnd = last;
    const contextBefore = Math.min(contextLines, countLeadingEqual(ops, changeStart));
    const contextAfter = Math.min(contextLines, countTrailingEqual(ops, changeEnd + 1));
    const slice = ops.slice(changeStart - contextBefore, changeEnd + 1 + contextAfter);
    let oldStart = 0;
    let newStart = 0;
    let oldLinesInHunk = 0;
    let newLinesInHunk = 0;
    const lines: DiffLine[] = [];
    for (const entry of slice) {
      if (entry.kind === 'equal') {
        const text = oldLines[entry.oldIndex] ?? '';
        if (oldStart === 0) oldStart = entry.oldIndex + 1;
        if (newStart === 0) newStart = entry.newIndex + 1;
        oldLinesInHunk += 1;
        newLinesInHunk += 1;
        lines.push({ sign: ' ', text });
      } else if (entry.kind === 'delete') {
        const text = oldLines[entry.oldIndex] ?? '';
        if (oldStart === 0) oldStart = entry.oldIndex + 1;
        oldLinesInHunk += 1;
        removed += 1;
        lines.push({ sign: '-', text });
      } else {
        const text = newLines[entry.newIndex] ?? '';
        if (newStart === 0) newStart = entry.newIndex + 1;
        newLinesInHunk += 1;
        added += 1;
        lines.push({ sign: '+', text });
      }
    }
    hunks.push({ oldStart, oldLines: oldLinesInHunk, newStart, newLines: newLinesInHunk, lines });
    index = changeEnd + 1 + contextAfter;
  }
  return {
    hunks,
    added,
    removed,
    coarse: false,
    oldLineCount: oldLines.length,
    newLineCount: newLines.length,
  };
}

function countLeadingEqual(ops: readonly DiffOp[], changeStart: number): number {
  let count = 0;
  let index = changeStart - 1;
  while (index >= 0 && ops[index]!.kind === 'equal') {
    count += 1;
    index -= 1;
  }
  return count;
}

function countTrailingEqual(ops: readonly DiffOp[], from: number): number {
  let count = 0;
  let index = from;
  while (index < ops.length && ops[index]!.kind === 'equal') {
    count += 1;
    index += 1;
  }
  return count;
}

/** Render hunks as a unified diff body (without file headers). */
export function formatHunks(hunks: readonly DiffHunk[]): string {
  const out: string[] = [];
  for (const hunk of hunks) {
    out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) out.push(`${line.sign}${line.text}`);
  }
  return out.join('\n');
}
