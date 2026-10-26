// Computed-value comparison with explicit, documented tolerances. Deterministic: the same two
// strings always produce the same classification.
import Color from 'colorjs.io';

export const TOLERANCE = {
  numberAbs: 0.002, // px-scale absolute noise (LayoutUnit is 1/64px; float printing differences)
  numberRel: 1e-4,
  deltaEOKNoise: 0.0005, // same engine: invisible rounding of channel values
  deltaEOKNoiseLowering: 0.005, // lowering to 8-bit sRGB: quantization alone reaches ~0.003
  deltaEOKNear: 0.02, // CSS gamut-mapping JND; above this a person could see it
  alphaNoise: 0.002,
};

// CSS named colors (css-color-4 §6.1) + transparent/currentcolor, so `red` tokenizes as a color.
const NAMED = new Set('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen transparent'.split(' '));

const COLOR_FUNCS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'light-dark']);
const LEGACY_FUNCS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb']);
export const GRADIENT_PROPS = new Set(['background-image', 'mask-image', '-webkit-mask-image', 'border-image-source', 'list-style-image', 'content', 'mask-border-source', '-webkit-mask-box-image-source']);

/** Split a computed value into text, number and color tokens. */
export function tokenize(value) {
  const tokens = [];
  let i = 0;
  let text = '';
  const flush = () => {
    if (text) tokens.push({ t: 'text', v: text });
    text = '';
  };
  while (i < value.length) {
    const rest = value.slice(i);
    const fn = /^([a-z-]+)\(/i.exec(rest);
    if (fn && COLOR_FUNCS.has(fn[1].toLowerCase()) && (i === 0 || !/[a-z0-9-]/i.test(value[i - 1]))) {
      let depth = 0;
      let j = i;
      for (; j < value.length; j++) {
        if (value[j] === '(') depth++;
        else if (value[j] === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      flush();
      tokens.push({ t: 'color', v: value.slice(i, j + 1), fn: fn[1].toLowerCase() });
      i = j + 1;
      continue;
    }
    const word = /^[a-z]+/i.exec(rest);
    if (word && NAMED.has(word[0].toLowerCase()) && (i === 0 || !/[a-z0-9-]/i.test(value[i - 1])) && !/^[a-z0-9-]/i.test(value.slice(i + word[0].length, i + word[0].length + 1))) {
      flush();
      tokens.push({ t: 'color', v: word[0], fn: 'named' });
      i += word[0].length;
      continue;
    }
    const hex = /^#[0-9a-f]{3,8}\b/i.exec(rest);
    if (hex && (i === 0 || !/[a-z0-9-]/i.test(value[i - 1]))) {
      flush();
      tokens.push({ t: 'color', v: hex[0], fn: 'hex' });
      i += hex[0].length;
      continue;
    }
    const num = /^[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?([a-z%]*)/i.exec(rest);
    if (num && (i === 0 || !/[a-z0-9_-]/i.test(value[i - 1]) || /[\s(,/]/.test(value[i - 1]))) {
      flush();
      const unit = num[1] || '';
      tokens.push({ t: 'num', v: parseFloat(num[0]), unit: unit.toLowerCase(), raw: num[0] });
      i += num[0].length;
      continue;
    }
    text += value[i];
    i++;
  }
  flush();
  return tokens;
}

function parseColor(s) {
  try {
    return new Color(s);
  } catch {
    return null;
  }
}

function deltaEOK(a, b) {
  try {
    return a.deltaE(b, 'OK');
  } catch {
    try {
      return Color.deltaE(a, b, { method: 'OK' });
    } catch {
      return Infinity;
    }
  }
}

function alphaOf(c) {
  const a = c.alpha;
  return typeof a === 'number' ? a : Number(a && a.valueOf ? a.valueOf() : 1);
}

export function toSrgbGamut(color) {
  try {
    return color.clone().toGamut({ space: 'srgb', method: 'css' });
  } catch {
    try {
      return color.to('srgb').toGamut();
    } catch {
      return color;
    }
  }
}

/** Compare two color strings. mode: 'same-engine' | 'lowering' (reference gamut-mapped to sRGB). */
export function compareColors(a, b, mode = 'same-engine') {
  if (a === b) return { level: 'equal' };
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return { level: 'different', reason: 'unparseable-color' };
  const noneA = /\bnone\b/.test(a);
  const noneB = /\bnone\b/.test(b);
  if (noneA !== noneB && mode === 'same-engine') return { level: 'different', reason: 'missing-component-changed' };
  const ref = mode === 'lowering' ? toSrgbGamut(ca) : ca;
  const dE = deltaEOK(ref, cb);
  const dA = Math.abs(alphaOf(ca) - alphaOf(cb));
  const fa = legacyFamily(a);
  const fb = legacyFamily(b);
  const spaceChanged = fa !== fb;
  const noise = mode === 'lowering' ? TOLERANCE.deltaEOKNoiseLowering : TOLERANCE.deltaEOKNoise;
  if (dE <= noise && dA <= TOLERANCE.alphaNoise) return { level: spaceChanged && mode === 'same-engine' ? 'space-changed' : 'noise', deltaE: round(dE), alpha: round(dA) };
  if (dE <= TOLERANCE.deltaEOKNear && dA <= 0.02) return { level: 'near', deltaE: round(dE), alpha: round(dA), spaceChanged };
  return { level: 'different', deltaE: round(dE), alpha: round(dA), reason: 'color-distance' };
}

function legacyFamily(s) {
  const fn = /^([a-z-]+)\(/i.exec(s.trim());
  if (!fn) return 'legacy';
  return LEGACY_FUNCS.has(fn[1].toLowerCase()) ? 'legacy' : 'modern';
}

const round = (x) => (Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : x);
const RANK = { equal: 0, noise: 1, 'space-changed': 2, 'custom-changed': 2.5, near: 3, different: 4 };

/** Compare two computed values for one property. Returns {level, detail}. */
export function compareValues(prop, a, b, mode = 'same-engine') {
  if (a === b) return { level: 'equal' };
  if (prop.startsWith('--') && (a === null || b === null || a === undefined || b === undefined)) return { level: 'custom-changed', reason: 'custom-property-added-or-removed' };
  if (a === null || b === null || a === undefined || b === undefined) return { level: 'different', reason: 'missing' };
  if (prop.startsWith('--')) {
    // Unregistered custom properties compute to their token stream. A rewrite there (e.g. a
    // color lowered inside color-mix()) is visible to JS and style() queries but not to
    // rendering, which the consuming properties are compared for separately.
    if (a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()) return { level: 'noise' };
    const r = compareValues('x-custom-inner', a, b, mode);
    return r.level === 'different' ? { level: 'custom-changed', details: r.details || [r] } : r;
  }
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length !== tb.length) {
    // Same color spelled with a different structure (e.g. color(srgb …) vs rgb(…)).
    if (ta.length === 1 && tb.length === 1 && ta[0].t === 'color' && tb[0].t === 'color') return compareColors(a, b, mode);
    return { level: 'different', reason: 'shape' };
  }
  let worst = { level: 'equal' };
  const details = [];
  for (let i = 0; i < ta.length; i++) {
    const x = ta[i];
    const y = tb[i];
    let r;
    if (x.t !== y.t) {
      if (x.t === 'color' || y.t === 'color') {
        r = x.t === 'color' && y.t === 'color' ? compareColors(x.v, y.v, mode) : { level: 'different', reason: 'token-kind' };
      } else r = { level: 'different', reason: 'token-kind' };
    } else if (x.t === 'text') {
      r = x.v.replace(/\s+/g, ' ') === y.v.replace(/\s+/g, ' ') ? { level: 'equal' } : { level: 'different', reason: 'text' };
    } else if (x.t === 'num') {
      if (x.unit !== y.unit) r = { level: 'different', reason: 'unit' };
      else {
        const d = Math.abs(x.v - y.v);
        const tol = Math.max(TOLERANCE.numberAbs, TOLERANCE.numberRel * Math.max(Math.abs(x.v), Math.abs(y.v)));
        r = d === 0 ? { level: 'equal' } : d <= tol ? { level: 'noise', delta: round(d) } : { level: 'different', reason: 'number', delta: round(d) };
      }
    } else {
      r = compareColors(x.v, y.v, mode);
    }
    // Gradients interpolate in sRGB only when every stop is a legacy color, else in OKLab
    // (css-images-4 #color-interpolation): a legacy/modern switch changes the rendering.
    if (mode === 'same-engine' && GRADIENT_PROPS.has(prop) && (r.level === 'space-changed' || r.spaceChanged)) r = { ...r, level: 'different', reason: 'gradient-interpolation-space-changed' };
    if (r.level !== 'equal') details.push(r);
    if (RANK[r.level] > RANK[worst.level]) worst = r;
  }
  return { level: worst.level, details: details.slice(0, 4) };
}

export function worstLevel(levels) {
  let w = 'equal';
  for (const l of levels) if (RANK[l] > RANK[w]) w = l;
  return w;
}
