/**
 * Tokenizer for computed values: text, numbers (with units) and colors.
 *
 * Stage: oracle (analysis image, compare.mjs). Computed values are compared token by token
 * (normalize.mjs), so `rgb(0, 0, 0) 1px` and `rgb(0, 0, 0.0001) 1.0001px` line up. Colors are whole
 * tokens (`rgb(…)`, `#fff`, `red`) because their difference is measured in a color space, not per
 * channel. Deterministic and allocation-light: every matcher is sticky at the current offset.
 */

/**
 * @typedef {{ t: 'text', v: string }
 *   | { t: 'color', v: string, fn: string }
 *   | { t: 'num', v: number, unit: string, raw: string }} Token
 */

/** CSS named colors (css-color-4 §6.1) plus `transparent`, so `red` tokenizes as a color. */
export const NAMED_COLORS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown ' +
    'burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan ' +
    'darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid ' +
    'darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet ' +
    'deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ' +
    'ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
    'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow ' +
    'lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray ' +
    'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine ' +
    'mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise ' +
    'mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab ' +
    'orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru ' +
    'pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown ' +
    'seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan ' +
    'teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen transparent'
  ).split(' '),
);

/** Functions whose whole call is one color token. */
const COLOR_FUNCTIONS = new Set([
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color',
  'color-mix',
  'light-dark',
]);

const FUNCTION_START = /([a-z-]+)\(/iy;
const WORD = /[a-z]+/iy;
const HEX_COLOR = /#[0-9a-f]{3,8}\b/iy;
const NUMBER = /[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?([a-z%]*)/iy;

const IDENT_CHAR = /[a-z0-9-]/i;
/** A number glued to one of these (`h1`, `x-2`) is part of an identifier, not a number. */
const NUMBER_PREFIX_CHAR = /[a-z0-9_-]/i;

/**
 * Run a sticky matcher at `offset`.
 *
 * @param {RegExp} pattern
 * @param {string} value
 * @param {number} offset
 * @returns {RegExpExecArray | null}
 */
function matchAt(pattern, value, offset) {
  pattern.lastIndex = offset;

  return pattern.exec(value);
}

/**
 * Whether a token may start at `offset`: not in the middle of an identifier.
 *
 * @param {string} value
 * @param {number} offset
 * @returns {boolean}
 */
function atWordStart(value, offset) {
  return offset === 0 || !IDENT_CHAR.test(value[offset - 1]);
}

/**
 * Whether a token may end at `end`: not in the middle of an identifier.
 *
 * @param {string} value
 * @param {number} end
 * @returns {boolean}
 */
function atWordEnd(value, end) {
  return end >= value.length || !IDENT_CHAR.test(value[end]);
}

/**
 * The end (exclusive) of the function call opening at `start`: after its matching `)`, or the end
 * of the value when it never closes.
 *
 * @param {string} value
 * @param {number} start
 * @returns {number}
 */
function callEnd(value, start) {
  let depth = 0;

  for (let i = start; i < value.length; i++) {
    if (value[i] === '(') {
      depth++;
    } else if (value[i] === ')') {
      depth--;

      if (depth === 0) {
        return i + 1;
      }
    }
  }

  return value.length + 1;
}

/**
 * The color or number token at `offset`, with its length; null for plain text.
 *
 * @param {string} value
 * @param {number} offset
 * @returns {{ token: Token, length: number } | null}
 */
function tokenAt(value, offset) {
  const call = matchAt(FUNCTION_START, value, offset);

  if (call && COLOR_FUNCTIONS.has(call[1].toLowerCase()) && atWordStart(value, offset)) {
    const end = callEnd(value, offset);

    return {
      token: { t: 'color', v: value.slice(offset, end), fn: call[1].toLowerCase() },
      length: end - offset,
    };
  }

  const word = matchAt(WORD, value, offset);

  if (
    word &&
    NAMED_COLORS.has(word[0].toLowerCase()) &&
    atWordStart(value, offset) &&
    atWordEnd(value, offset + word[0].length)
  ) {
    return { token: { t: 'color', v: word[0], fn: 'named' }, length: word[0].length };
  }

  const hex = matchAt(HEX_COLOR, value, offset);

  if (hex && atWordStart(value, offset)) {
    return { token: { t: 'color', v: hex[0], fn: 'hex' }, length: hex[0].length };
  }

  const number = matchAt(NUMBER, value, offset);

  if (number && (offset === 0 || !NUMBER_PREFIX_CHAR.test(value[offset - 1]))) {
    const unit = number[1] || '';

    return {
      token: { t: 'num', v: parseFloat(number[0]), unit: unit.toLowerCase(), raw: number[0] },
      length: number[0].length,
    };
  }

  return null;
}

/**
 * Split a computed value into text, number and color tokens.
 *
 * @param {string} value
 * @returns {Token[]}
 */
export function tokenize(value) {
  /** @type {Token[]} */
  const tokens = [];
  let text = '';
  let offset = 0;

  while (offset < value.length) {
    const found = tokenAt(value, offset);

    if (!found) {
      text += value[offset];
      offset++;
      continue;
    }

    if (text) {
      tokens.push({ t: 'text', v: text });
    }

    text = '';
    tokens.push(found.token);
    offset += found.length;
  }

  if (text) {
    tokens.push({ t: 'text', v: text });
  }

  return tokens;
}
