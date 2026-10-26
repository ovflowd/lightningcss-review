/**
 * Python's `textwrap.wrap` with its default options, for the help text of `lcr -h`.
 *
 * Stage: CLI. argparse wraps every help string with textwrap, so `lcr <command> -h` prints the
 * same lines as py-final only if words split and lines fill the way textwrap does it: break at
 * whitespace and after the hyphen of a hyphenated word, drop whitespace at line edges, and cut a
 * word longer than a line.
 */

/** textwrap's whitespace: ASCII only. */
const WHITESPACE = String.raw`[\t\n\v\f\r ]`;
const NOT_WHITESPACE = String.raw`[^\t\n\v\f\r ]`;
/** Python's `\w`. */
const WORD = String.raw`[\p{L}\p{N}_]`;
/** textwrap's `word_punct`: a word character or sentence punctuation. */
const WORD_PUNCT = String.raw`[\p{L}\p{N}_!"'&.,?]`;
/** textwrap's `letter`, `[^\d\W]`: a word character that is not a decimal digit. */
const LETTER = String.raw`[\p{L}\p{Nl}\p{No}_]`;

/**
 * textwrap's `wordsep_re`: runs of whitespace, em-dashes between words, and words that may end
 * after the hyphen of a hyphenated word.
 */
const WORD_SEPARATOR = new RegExp(
  [
    `(${WHITESPACE}+`,
    `|(?<=${WORD_PUNCT})-{2,}(?=${WORD})`,
    `|${NOT_WHITESPACE}+?(?:`,
    `-(?:(?<=${LETTER}{2}-)|(?<=${LETTER}-${LETTER}-))(?=${LETTER}-?${LETTER})`,
    `|(?=${WHITESPACE}|$)`,
    `|(?<=${WORD_PUNCT})(?=-{2,}${WORD})`,
    '))',
  ].join(''),
  'u',
);
const ANY_WHITESPACE = new RegExp(WHITESPACE, 'gu');
const ONLY_WHITESPACE = new RegExp(`^${WHITESPACE}*$`, 'u');

/**
 * Wrap `text` into lines of at most `width` characters (`textwrap.wrap(text, width)`).
 *
 * @param {string} text
 * @param {number} width
 * @returns {string[]}
 */
export function wrap(text, width) {
  // replace_whitespace: every whitespace character becomes a space. (textwrap expands tabs first;
  // argparse has already collapsed all whitespace to single spaces, so there are none here.)
  const chunks = text.replace(ANY_WHITESPACE, ' ').split(WORD_SEPARATOR).filter(Boolean);

  return wrapChunks(chunks, width);
}

/**
 * Fill lines greedily with chunks (`TextWrapper._wrap_chunks`, drop_whitespace on).
 *
 * @param {string[]} chunks Words and whitespace runs, in order.
 * @param {number} width
 * @returns {string[]}
 */
function wrapChunks(chunks, width) {
  /** @type {string[]} */
  const lines = [];
  const pending = chunks.toReversed();

  while (pending.length > 0) {
    /** @type {string[]} */
    const line = [];
    let length = 0;

    if (lines.length > 0 && isBlank(/** @type {string} */ (pending.at(-1)))) {
      pending.pop();
    }

    while (pending.length > 0 && length + /** @type {string} */ (pending.at(-1)).length <= width) {
      const chunk = /** @type {string} */ (pending.pop());

      line.push(chunk);
      length += chunk.length;
    }

    if (pending.length > 0 && /** @type {string} */ (pending.at(-1)).length > width) {
      breakLongWord(pending, line, width < 1 ? 1 : width - length);
    }

    if (line.length > 0 && isBlank(/** @type {string} */ (line.at(-1)))) {
      line.pop();
    }

    if (line.length > 0) {
      lines.push(line.join(''));
    }
  }

  return lines;
}

/**
 * Put as much of an over-long word on the line as fits, preferring to cut after a hyphen
 * (`TextWrapper._handle_long_word`, break_long_words and break_on_hyphens on).
 *
 * @param {string[]} pending Remaining chunks, reversed.
 * @param {string[]} line
 * @param {number} spaceLeft
 * @returns {void}
 */
function breakLongWord(pending, line, spaceLeft) {
  if (spaceLeft <= 0) {
    // The line is full: the word starts the next one, unless nothing else would ever fit.
    if (line.length === 0) {
      line.push(/** @type {string} */ (pending.pop()));
    }

    return;
  }

  const chunk = /** @type {string} */ (pending.at(-1));
  let end = spaceLeft;

  if (chunk.length > spaceLeft) {
    const hyphen = chunk.lastIndexOf('-', spaceLeft - 1);

    if (hyphen > 0 && /[^-]/.test(chunk.slice(0, hyphen))) {
      end = hyphen + 1;
    }
  }

  line.push(chunk.slice(0, end));
  pending[pending.length - 1] = chunk.slice(end);
}

/**
 * @param {string} chunk
 * @returns {boolean}
 */
function isBlank(chunk) {
  return ONLY_WHITESPACE.test(chunk);
}
