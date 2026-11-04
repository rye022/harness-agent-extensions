import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffTexts, formatHunks, globToRegExp, matchesAny, hasIgnoredSegment, DEFAULT_IGNORED_DIRECTORIES } from '../src/index.ts';

test('identical texts produce no hunks', () => {
  const result = diffTexts('a\nb\nc\n', 'a\nb\nc\n');
  assert.equal(result.hunks.length, 0);
  assert.equal(result.added, 0);
  assert.equal(result.removed, 0);
  assert.equal(result.coarse, false);
});

test('single line change yields one hunk with context', () => {
  const oldText = 'one\ntwo\nthree\nfour\nfive\n';
  const newText = 'one\ntwo\nTHREE\nfour\nfive\n';
  const result = diffTexts(oldText, newText);
  assert.equal(result.hunks.length, 1);
  assert.equal(result.added, 1);
  assert.equal(result.removed, 1);
  const hunk = result.hunks[0]!;
  assert.equal(hunk.oldStart, 1);
  assert.equal(hunk.oldLines, 5);
  const signs = hunk.lines.map((line) => line.sign).join('');
  assert.equal(signs, '  -+  ');
  assert.deepEqual(
    hunk.lines.filter((line) => line.sign !== ' ').map((line) => line.text),
    ['three', 'THREE'],
  );
});

test('separated changes farther than 2*context split into two hunks', () => {
  const oldLines = Array.from({ length: 20 }, (_, index) => `line${index}`);
  const newLines = [...oldLines];
  newLines[1] = 'changed1';
  newLines[18] = 'changed18';
  const result = diffTexts(`${oldLines.join('\n')}\n`, `${newLines.join('\n')}\n`, { contextLines: 2 });
  assert.equal(result.hunks.length, 2);
  assert.equal(result.added, 2);
  assert.equal(result.removed, 2);
});

test('pure addition at end', () => {
  const result = diffTexts('a\nb\n', 'a\nb\nc\n');
  assert.equal(result.added, 1);
  assert.equal(result.removed, 0);
  assert.equal(result.hunks.length, 1);
});

test('empty to content and back', () => {
  const grown = diffTexts('', 'a\nb\n');
  assert.equal(grown.added, 2);
  assert.equal(grown.removed, 0);
  const shrunk = diffTexts('a\nb\n', '');
  assert.equal(shrunk.added, 0);
  assert.equal(shrunk.removed, 2);
});

test('large rewrite degrades to coarse instead of hanging', () => {
  const oldText = Array.from({ length: 5000 }, (_, index) => `old-${index}`).join('\n');
  const newText = Array.from({ length: 5000 }, (_, index) => `new-${index}`).join('\n');
  const result = diffTexts(oldText, newText, { maxEditDistance: 50 });
  assert.equal(result.coarse, true);
  assert.equal(result.hunks.length, 1);
  assert.equal(result.added, 5000);
  assert.equal(result.removed, 5000);
});

test('formatHunks emits unified headers', () => {
  const result = diffTexts('a\n', 'b\n');
  const text = formatHunks(result.hunks);
  assert.match(text, /^@@ -1,1 \+1,1 @@/m);
  assert.match(text, /^-a$/m);
  assert.match(text, /^\+b$/m);
});

test('CRLF input is treated as line separators', () => {
  const result = diffTexts('a\r\nb\r\n', 'a\r\nc\r\n');
  assert.equal(result.added, 1);
  assert.equal(result.removed, 1);
});

test('glob matching: ** crosses directories, * does not', () => {
  assert.equal(globToRegExp('**/*.log').test('a/b/c.log'), true);
  assert.equal(globToRegExp('**/*.log').test('c.log'), true);
  assert.equal(globToRegExp('*.log').test('a/c.log'), false);
  assert.equal(globToRegExp('.env.*').test('.env.local'), true);
  assert.equal(matchesAny('src/app.min.js', ['*.min.js']), true);
});

test('ignored directory segments are detected at any depth', () => {
  assert.equal(hasIgnoredSegment('a/node_modules/b.js', DEFAULT_IGNORED_DIRECTORIES), true);
  assert.equal(hasIgnoredSegment('node_modules', DEFAULT_IGNORED_DIRECTORIES), true);
  assert.equal(hasIgnoredSegment('src/node_modules.js', DEFAULT_IGNORED_DIRECTORIES), false);
  assert.equal(hasIgnoredSegment('src/app.ts', DEFAULT_IGNORED_DIRECTORIES), false);
});
