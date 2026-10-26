/**
 * Text helpers of the report renderers: snippets, diff excerpts, Markdown fences and table cells.
 *
 * Stage: report (report.md, report.json evidence, the chat summary). Lengths and cuts count code
 * points, as py-final's `len()` and slicing did, so a snippet of text with emoji or astral
 * characters cuts at the same place.
 */
import { unifiedDiff } from '../core/difflib.js';
import { pyLen, pyRstrip, pySlice, pySplitlines, pyStr } from '../core/py.js';
import { ELLIPSIS, EM_DASH, EMPTY_SET } from './glyphs.js';

/** What `snippetWords` strips from the end of a cut before adding the ellipsis. */
const TRAILING_PUNCTUATION = ` ,;:${EM_DASH}-`;

/** A diff excerpt is a unified diff once both sides have more than this many newlines. */
const DIFF_MIN_NEWLINES = 3;

/** Lines of context around each change in a unified-diff excerpt. */
const DIFF_CONTEXT_LINES = 1;

/** Characters kept around the changed part of a single-line excerpt: at least this many... */
const MIN_CONTEXT_CHARS = 40;

/** ...or this fraction of the snippet limit. */
const CONTEXT_LIMIT_DIVISOR = 6;

/**
 * At most `limit` code points of `text`, the last one replaced by an ellipsis when cut; `∅` for a
 * missing value.
 *
 * @param {unknown} text
 * @param {number} limit
 * @returns {string}
 */
export function snippet(text, limit) {
  if (text === null || text === undefined) {
    return EMPTY_SET;
  }

  const value = pyStr(text);

  return pyLen(value) <= limit ? value : pySlice(value, 0, limit - 1) + ELLIPSIS;
}

/**
 * Like `snippet`, but cuts at the last space when one falls in the second half, and drops the
 * punctuation left at the cut.
 *
 * @param {unknown} text
 * @param {number} limit
 * @returns {string}
 */
export function snippetWords(text, limit) {
  const value = text === null || text === undefined ? '' : pyStr(text);

  if (pyLen(value) <= limit) {
    return value;
  }

  const cut = Array.from(value).slice(0, limit - 1);
  const space = cut.lastIndexOf(' ');
  const kept = space > Math.floor(limit / 2) ? cut.slice(0, space) : cut;

  return pyRstrip(kept.join(''), TRAILING_PUNCTUATION) + ELLIPSIS;
}

/**
 * The part of two outputs that differs: a unified diff (one line of context) when both are
 * multi-line, otherwise a window around the first and last differing character of each side.
 *
 * @param {string | null | undefined} base
 * @param {string | null | undefined} head
 * @param {number} limit
 * @returns {string}
 */
export function diffExcerpt(base, head, limit) {
  const before = base || '';
  const after = head || '';

  if (countNewlines(before) > DIFF_MIN_NEWLINES && countNewlines(after) > DIFF_MIN_NEWLINES) {
    const lines = unifiedDiff(pySplitlines(before), pySplitlines(after), {
      fromfile: 'base',
      tofile: 'head',
      context: DIFF_CONTEXT_LINES,
      lineterm: '',
    });

    return snippet(lines.join('\n'), 2 * limit);
  }

  const window = changedWindow(Array.from(before), Array.from(after), limit);

  return `base: ${snippet(window(before), limit)}\nhead: ${snippet(window(after), limit)}`;
}

/**
 * @param {string} text
 * @returns {number}
 */
function countNewlines(text) {
  return text.split('\n').length - 1;
}

/**
 * A function cutting either side down to the changed part plus some context: the common prefix
 * and suffix are measured once over both sides, so both windows show the same region.
 *
 * @param {string[]} before Code points.
 * @param {string[]} after Code points.
 * @param {number} limit
 * @returns {(text: string) => string}
 */
function changedWindow(before, after, limit) {
  const shorter = Math.min(before.length, after.length);
  let prefix = 0;

  while (prefix < shorter && before[prefix] === after[prefix]) {
    prefix++;
  }

  let suffix = 0;

  while (suffix < shorter - prefix && before.at(-1 - suffix) === after.at(-1 - suffix)) {
    suffix++;
  }

  const context = Math.max(MIN_CONTEXT_CHARS, Math.floor(limit / CONTEXT_LIMIT_DIVISOR));

  return (text) => {
    const chars = Array.from(text);
    const start = Math.max(0, prefix - context);
    const end = Math.min(chars.length, chars.length - suffix + context);
    const lead = start ? ELLIPSIS : '';
    const tail = end < chars.length ? ELLIPSIS : '';

    return lead + chars.slice(start, end).join('') + tail;
  };
}

/**
 * A fenced Markdown code block that survives backticks in the text (the fence grows until the
 * text does not contain it).
 *
 * @param {unknown} text
 * @param {string} lang The info string (`css`, `diff`, `rust`, `sh`).
 * @returns {string}
 */
export function fence(text, lang) {
  const value = text === null || text === undefined ? '' : pyStr(text);
  let ticks = '```';

  while (value.includes(ticks)) {
    ticks += '`';
  }

  return `${ticks}${lang}\n${pyRstrip(value)}\n${ticks}`;
}

/**
 * Text safe inside a Markdown table cell: pipes escaped, newlines flattened.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function mdCell(text) {
  return pyStr(text).replaceAll('|', '\\|').replaceAll('\n', ' ');
}
