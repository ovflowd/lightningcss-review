/**
 * Snippets, diff excerpts, fences and table cells.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ELLIPSIS, EMPTY_SET } from '../glyphs.js';
import { diffExcerpt, fence, mdCell, snippet, snippetWords } from '../text.js';

describe('text helpers', () => {
  test('snippetWords cuts at a word boundary', () => {
    assert.equal(snippetWords('alpha beta gamma delta', 15), `alpha beta${ELLIPSIS}`);
    assert.equal(snippetWords('short', 15), 'short');
    assert.equal(snippetWords(null, 15), '');
    // The cut drops the punctuation left before it; without a space in the second half it is plain.
    assert.equal(snippetWords('alpha beta, gamma delta', 13), `alpha beta${ELLIPSIS}`);
    assert.equal(snippetWords('a abcdefghij, klm', 12), `a abcdefghi${ELLIPSIS}`);
  });

  test('snippet counts code points and marks missing values', () => {
    assert.equal(snippet(null, 5), EMPTY_SET);
    assert.equal(snippet('abcdef', 5), `abcd${ELLIPSIS}`);
    assert.equal(snippet('\u{1F600}\u{1F600}\u{1F600}', 3), '\u{1F600}\u{1F600}\u{1F600}');
    assert.equal(snippet(1.5, 5), '1.5');
    assert.equal(snippet(true, 5), 'True');
  });

  test('diffExcerpt shows the changed part', () => {
    const before = `${'x'.repeat(500)}color:red${'y'.repeat(500)}`;
    const after = `${'x'.repeat(500)}color:blue${'y'.repeat(500)}`;
    const text = diffExcerpt(before, after, 200);

    assert.ok(text.includes('color:red'));
    assert.ok(text.includes('color:blue'));
    assert.ok(text.length < 400);
  });

  test('diffExcerpt is a unified diff for multi-line outputs', () => {
    const lines = (/** @type {string} */ changed) => ['a', 'b', 'c', changed, 'e', 'f'].join('\n');

    assert.equal(
      diffExcerpt(lines('d'), lines('D'), 200),
      '--- base\n+++ head\n@@ -3,3 +3,3 @@\n c\n-d\n+D\n e',
    );
  });

  test('fence grows past backticks in the text', () => {
    assert.equal(fence('a```b', 'rust'), '````rust\na```b\n````');
    assert.equal(fence(null, 'css'), '```css\n\n```');
    assert.equal(fence('x \n\n', 'css'), '```css\nx\n```');
  });

  test('mdCell escapes pipes and flattens newlines', () => {
    assert.equal(mdCell('a|b\nc'), 'a\\|b c');
    assert.equal(mdCell(null), 'None');
  });
});
