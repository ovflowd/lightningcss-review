/**
 * Metamorphic variants of the PR's own test inputs, and the small top-level CSS splitter they use.
 *
 * Stage: corpus (mutation cases), oracle driver (`focus_css` splits large sheets into blocks) and
 * status (mutation names group deltas).
 *
 * A mutation does not have to preserve the input's meaning: the oracle compares each mutated input
 * with its own output. The mutations encode the habits of the Lightning CSS test suite: both
 * declaration orders, typed vs `var()` values, `!important`, prefixed siblings (property and value
 * prefixes), nesting, conditional and layer wrapping, non-adjacent duplicates, other targets.
 *
 * Reads: config/modes.json (retarget presets), config/properties.json (vendor prefixes),
 * <cache>/env.json (legacy engine versions for the `engine-<profile>` retargets).
 *
 * Invariant: everything here is deterministic text processing; the same input gives the same
 * variants, in the same order, on every machine with the same engine profiles installed. The
 * splitter only looks at ASCII delimiters, so its UTF-16 indices cut text exactly where code-point
 * indices would, and the variants (and their case ids) match those of earlier runs.
 */
import { join } from 'node:path';

import { readJson } from '../core/files.js';
import { cacheDir, loadConfig, SKILL_DIR } from '../core/paths.js';
import { pyDigitsToInt } from '../core/py-number.js';
import { PY_CI_I, PY_DIGIT, PY_SPACE, PY_WORD_END } from '../core/py-re.js';
import { pyStr, pyStrip, pySorted, pyTruthy } from '../core/py.js';
import { jsonLineText } from '../core/pyjson.js';
import { parseTargets } from '../targets/targets.js';

/**
 * @import { AdapterRequest, CorpusCase, EngineProfileConfig, EnginesConfig, ModesConfig, PropertyEntry,
 *   Targets } from '../types.js'
 */

/** Every text mutation, in the order cases are generated. Retargets to engine profiles come after. */
export const MUTATIONS = Object.freeze([
  'reverse-decls',
  'important',
  'var-before',
  'var-after',
  'prefixed-sibling',
  'value-prefixed-sibling',
  'wrap-media',
  'wrap-layer',
  'wrap-supports',
  'nest',
  'duplicate-nonadjacent',
  'upper-props',
  'retarget-none',
  'retarget-modern',
  'retarget-legacy',
]);

/** Mutation cases are generated for at most this many parents (sorted by id). */
const DEFAULT_PARENT_LIMIT = 60;

/** Wrapping at-rules that always apply, so the wrapped sheet means the same as the original. */
const WRAPPERS = Object.freeze({
  'wrap-media': '@media (min-width: 0px)',
  'wrap-layer': '@layer lcr',
  'wrap-supports': '@supports (display: block)',
});

/** Rules `nest` leaves at the top level: already nested, or matching only the root. */
const NEST_SKIP_PREFIXES = Object.freeze(['&', ':root', 'html', 'body']);

/**
 * A `(property, value)` pair as a Map key (Python used the tuple itself).
 *
 * @param {string} property
 * @param {string} value
 * @returns {string}
 */
function pairKey(property, value) {
  return JSON.stringify([property, value]);
}

/**
 * Legacy prefixed values of an unprefixed property value, in the order autoprefixer emits them.
 *
 * @type {readonly (readonly [property: string, value: string, prefixed: readonly string[]])[]}
 */
const VALUE_PREFIX_TABLE = Object.freeze([
  ['display', 'flex', ['-webkit-box', '-ms-flexbox']],
  ['display', 'inline-flex', ['-webkit-inline-box', '-ms-inline-flexbox']],
  ['position', 'sticky', ['-webkit-sticky']],
]);

/** @type {ReadonlyMap<string, readonly string[]>} `(property, value)` -> its prefixed values. */
const VALUE_PREFIXES = new Map(
  VALUE_PREFIX_TABLE.map(([property, value, prefixed]) => [pairKey(property, value), prefixed]),
);

/** @type {ReadonlyMap<string, string>} `(property, prefixed value)` -> the unprefixed value. */
const UNPREFIXED_VALUE = new Map(
  VALUE_PREFIX_TABLE.flatMap(([property, value, prefixed]) =>
    prefixed.map((variant) => /** @type {const} */ ([pairKey(property, variant), value])),
  ),
);

const IMPORTANT = `!${PY_SPACE}*${PY_CI_I}mportant${PY_SPACE}*$`;
const IMPORTANT_RE = new RegExp(IMPORTANT, 'iu');
const IMPORTANT_SUFFIX_RE = new RegExp(`${PY_SPACE}*${IMPORTANT}`, 'iu');
// Statements that must stay at the top of a sheet: wrapping them in a block changes their meaning.
const TOP_ONLY_AT_RULE_RE = new RegExp(`^@(?:${PY_CI_I}mport|charset|namespace|layer)${PY_WORD_END}`, 'iu');
const VERSION_RE = new RegExp(`^(${PY_DIGIT}+)(?:\\.(${PY_DIGIT}+))?(?:\\.(${PY_DIGIT}+))?`, 'u');
/** Version components above this are clamped, as Lightning CSS's 8-bit patch field requires. */
const MAX_PATCH = 255;

const SPACE = ' \t\r\n';

/**
 * @typedef {object} TopItem
 * @property {'rule' | 'at-block' | 'at-stmt'} kind
 * @property {string} prelude Selector or at-rule prelude, stripped.
 * @property {string | null} body Block content without the braces (null for statements).
 */

// ---------------------------------------------------------------------------------------------
// Splitting

/**
 * The index of the closing quote of a string starting at `start` (backslash escapes skip a
 * character), or the end of the text when it never closes.
 *
 * @param {string} css
 * @param {number} start Index of the opening quote.
 * @returns {number}
 */
function skipString(css, start) {
  const quote = css[start];
  let index = start + 1;

  while (index < css.length && css[index] !== quote) {
    index += css[index] === '\\' ? 2 : 1;
  }

  return index;
}

/**
 * The index of the last character of a comment starting at `start` (end of text if unclosed).
 *
 * @param {string} css
 * @param {number} start
 * @returns {number}
 */
function commentEnd(css, start) {
  const close = css.indexOf('*/', start + 2);

  return close < 0 ? css.length : close + 1;
}

/**
 * Index just past the `}` that closes the `{` at `start`, or -1 if the block never closes.
 *
 * @param {string} css
 * @param {number} start
 * @returns {number}
 */
function scanBlock(css, start) {
  let depth = 0;

  for (let index = start; index < css.length; index++) {
    const char = css[index];

    if (char === '"' || char === "'") {
      index = skipString(css, index);
    } else if (css.startsWith('/*', index)) {
      index = commentEnd(css, index);
    } else if (char === '{') {
      depth++;
    } else if (char === '}' && --depth === 0) {
      return index + 1;
    }
  }

  return -1;
}

/**
 * Top-level items of a stylesheet, or null when it cannot be split (unbalanced braces, an
 * unclosed comment, trailing garbage).
 *
 * @param {string} css
 * @returns {TopItem[] | null}
 */
export function splitTop(css) {
  /** @type {TopItem[]} */
  const items = [];
  let index = 0;

  while (index < css.length) {
    while (index < css.length && SPACE.includes(css[index])) {
      index++;
    }

    if (index >= css.length) {
      break;
    }

    if (css.startsWith('/*', index)) {
      const close = css.indexOf('*/', index + 2);

      if (close < 0) {
        return null;
      }

      index = close + 2;
      continue;
    }

    const next = readItem(css, index, items);

    if (next < 0) {
      return null;
    }

    index = next;
  }

  return items;
}

/**
 * Read one item starting at `start` and append it to `items`.
 *
 * @param {string} css
 * @param {number} start
 * @param {TopItem[]} items
 * @returns {number} Where the next item starts, or -1 when the text cannot be split.
 */
function readItem(css, start, items) {
  let depth = 0;

  for (let index = start; index < css.length; index++) {
    const char = css[index];

    if (char === '"' || char === "'") {
      index = skipString(css, index);
    } else if (css.startsWith('/*', index)) {
      index = commentEnd(css, index);
    } else if (char === '(' || char === '[') {
      depth++;
    } else if (char === ')' || char === ']') {
      depth--;
    } else if (depth === 0) {
      const end = itemEnd(css, start, index, items);

      if (end !== null) {
        return end;
      }
    }
  }

  // Ran off the end without a terminator: only whitespace may remain.
  return pyStrip(css.slice(start)) ? -1 : css.length;
}

/**
 * At depth 0: finish the item when `index` holds its terminator.
 *
 * @param {string} css
 * @param {number} start
 * @param {number} index
 * @param {TopItem[]} items
 * @returns {number | null} Next index, -1 for an unsplittable text, null to keep scanning.
 */
function itemEnd(css, start, index, items) {
  const char = css[index];

  if (char === ';' && css[start] === '@') {
    items.push({ kind: 'at-stmt', prelude: pyStrip(css.slice(start, index)), body: null });

    return index + 1;
  }

  if (char === '{') {
    const end = scanBlock(css, index);

    if (end < 0) {
      return -1;
    }

    const prelude = pyStrip(css.slice(start, index));

    items.push({
      kind: prelude.startsWith('@') ? 'at-block' : 'rule',
      prelude,
      body: css.slice(index + 1, end - 1),
    });

    return end;
  }

  return char === '}' ? -1 : null;
}

/**
 * The declarations of a flat block (comments dropped), or null when the block nests rules or
 * holds something that is not a declaration.
 *
 * @param {string} body
 * @returns {string[] | null}
 */
export function splitDecls(body) {
  /** @type {string[]} */
  const decls = [];
  let current = '';
  let depth = 0;
  let index = 0;

  while (index < body.length) {
    const char = body[index];

    if (char === '"' || char === "'") {
      const close = skipString(body, index);

      current += body.slice(index, close + 1);
      index = close + 1;
      continue;
    }

    if (body.startsWith('/*', index)) {
      index = commentEnd(body, index) + 1;
      continue;
    }

    if (char === '(' || char === '[') {
      depth++;
    } else if (char === ')' || char === ']') {
      depth--;
    } else if ((char === '{' || char === '}') && depth === 0) {
      return null;
    }

    if (char === ';' && depth === 0) {
      pushDecl(decls, current);
      current = '';
    } else {
      current += char;
    }

    index++;
  }

  pushDecl(decls, current);

  return decls.every((decl) => decl.includes(':')) ? decls : null;
}

/**
 * @param {string[]} decls
 * @param {string} text
 * @returns {void}
 */
function pushDecl(decls, text) {
  const decl = pyStrip(text);

  if (decl) {
    decls.push(decl);
  }
}

/**
 * Serialize items back to CSS: one item per line, `prelude { body }`.
 *
 * @param {readonly TopItem[]} items
 * @returns {string}
 */
export function joinItems(items) {
  const parts = items.map((item) =>
    item.kind === 'at-stmt' ? `${item.prelude};` : `${item.prelude} { ${pyStrip(item.body ?? '')} }`,
  );

  return `${parts.join('\n')}\n`;
}

/**
 * A declaration's name, its value without `!important`, and whether it was important.
 *
 * @param {string} decl
 * @returns {[name: string, value: string, important: boolean]}
 */
export function propOf(decl) {
  const colon = decl.indexOf(':');
  let value = pyStrip(decl.slice(colon + 1));
  const important = IMPORTANT_RE.test(value);

  if (important) {
    value = value.replace(IMPORTANT_SUFFIX_RE, '');
  }

  return [pyStrip(decl.slice(0, colon)), value, important];
}

/** @type {Map<string, string[]> | null} */
let prefixedPropsCache = null;

/**
 * Property name -> the vendor prefixes Lightning CSS knows for it (config/properties.json).
 *
 * @returns {Map<string, string[]>}
 */
function prefixedProps() {
  if (!prefixedPropsCache) {
    const entries = /** @type {PropertyEntry[] | null} */ (
      readJson(join(SKILL_DIR, 'config', 'properties.json'), [])
    );

    prefixedPropsCache = new Map(
      (pyTruthy(entries) ? /** @type {PropertyEntry[]} */ (entries) : []).map((entry) => [
        entry.name,
        pyTruthy(entry.prefixes) ? /** @type {string[]} */ (entry.prefixes) : [],
      ]),
    );
  }

  return prefixedPropsCache;
}

// ---------------------------------------------------------------------------------------------
// Text mutations

/**
 * Legacy prefixed values before each unprefixed one (`display: -webkit-box; display: flex`), and
 * the unprefixed value after the last of its prefixed values when the rule lacks it.
 *
 * @param {readonly string[]} decls
 * @returns {string[]}
 */
export function valuePrefixedSiblings(decls) {
  const pairs = decls.map((decl) => {
    const [name, value] = propOf(decl);

    return [name.toLowerCase(), value.toLowerCase()];
  });
  const present = new Set(pairs.map(([property, value]) => pairKey(property, value)));
  // Missing unprefixed values -> where their last prefixed value is; the first insertion fixes
  // the order, as in a Python dict.
  /** @type {Map<string, { value: string, index: number }>} */
  const lastPrefixed = new Map();

  pairs.forEach(([property, value], index) => {
    const unprefixed = UNPREFIXED_VALUE.get(pairKey(property, value));

    if (unprefixed !== undefined && !present.has(pairKey(property, unprefixed))) {
      lastPrefixed.set(pairKey(property, unprefixed), { value: unprefixed, index });
    }
  });

  return decls.flatMap((decl, index) => {
    const [name, , important] = propOf(decl);
    const suffix = important ? ' !important' : '';
    const [property, value] = pairs[index];
    const before = (VALUE_PREFIXES.get(pairKey(property, value)) ?? []).filter(
      (prefixed) => !present.has(pairKey(property, prefixed)),
    );
    const after = [...lastPrefixed.values()]
      .filter((entry) => entry.index === index)
      .map((entry) => entry.value);

    return [
      ...before.map((value) => `${name}: ${value}${suffix}`),
      decl,
      ...after.map((value) => `${name}: ${value}${suffix}`),
    ];
  });
}

/**
 * `var-before` / `var-after`: the same declaration through an unset custom property, before or
 * after the typed one.
 *
 * @param {readonly string[]} decls
 * @param {boolean} before
 * @returns {string[]}
 */
function varSiblings(decls, before) {
  return decls.flatMap((decl) => {
    const [name, value, important] = propOf(decl);

    if (name.startsWith('--') || !value) {
      return [decl];
    }

    const extra = `${name}: var(--lcr-unset, ${value})${important ? ' !important' : ''}`;

    return before ? [extra, decl] : [decl, extra];
  });
}

/**
 * `prefixed-sibling`: a `-webkit-` copy before every declaration of a property Lightning CSS
 * prefixes for WebKit.
 *
 * @param {readonly string[]} decls
 * @returns {string[]}
 */
function prefixedSiblings(decls) {
  const prefixes = prefixedProps();

  return decls.flatMap((decl) => {
    const [name, value, important] = propOf(decl);
    const webkit = (prefixes.get(name) ?? []).some((prefix) =>
      ['webkit', '-webkit-'].includes(prefix.toLowerCase()),
    );

    return webkit ? [`-webkit-${name}: ${value}${important ? ' !important' : ''}`, decl] : [decl];
  });
}

/**
 * The declarations of one rule after a declaration-level mutation, or null when the mutation does
 * not apply to declarations.
 *
 * @param {readonly string[]} decls
 * @param {string} mutation
 * @returns {string[] | null}
 */
function mutateDecls(decls, mutation) {
  switch (mutation) {
    case 'reverse-decls':
      return decls.length > 1 ? decls.toReversed() : null;
    case 'important':
      return decls.map((decl) => (IMPORTANT_RE.test(decl) ? decl : `${decl} !important`));
    case 'var-before':
    case 'var-after':
      return varSiblings(decls, mutation === 'var-before');
    case 'prefixed-sibling':
      return prefixedSiblings(decls);
    case 'value-prefixed-sibling':
      return valuePrefixedSiblings(decls);
    case 'upper-props':
      return decls.map((decl) => {
        const colon = decl.indexOf(':');
        const name = decl.slice(0, colon);
        const upper = pyStrip(name).startsWith('--') ? name : name.toUpperCase();

        return upper + decl.slice(colon);
      });
    default:
      return null;
  }
}

/**
 * @param {readonly string[]} left
 * @param {readonly string[]} right
 * @returns {boolean}
 */
function sameList(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/**
 * Apply a declaration-level mutation to every flat rule; null when no rule changed.
 *
 * @param {readonly TopItem[]} items
 * @param {string} mutation
 * @returns {string | null}
 */
function mutateRules(items, mutation) {
  let changed = false;
  const out = items.map((item) => {
    const decls = item.kind === 'rule' ? splitDecls(item.body ?? '') : null;
    const mutated = decls?.length ? mutateDecls(decls, mutation) : null;

    if (!decls || !mutated || sameList(mutated, decls)) {
      return item;
    }

    changed = true;

    return { ...item, body: mutated.join('; ') };
  });

  return changed ? joinItems(out) : null;
}

/**
 * `nest`: every top-level rule moves under `.lcr-n { … }`, except rules that are already nested
 * or that only match the root (nesting them would match nothing).
 *
 * @param {readonly TopItem[]} items
 * @returns {string}
 */
function nest(items) {
  return joinItems(
    items.map((item) => {
      const prelude = item.prelude;

      if (item.kind !== 'rule' || NEST_SKIP_PREFIXES.some((prefix) => prelude.startsWith(prefix))) {
        return item;
      }

      return { kind: 'rule', prelude: '.lcr-n', body: `${prelude} { ${pyStrip(item.body ?? '')} }` };
    }),
  );
}

/**
 * The mutated stylesheet, or null when the mutation does not apply (the sheet cannot be split,
 * has no rule to work on, or would not change).
 *
 * @param {string} css
 * @param {string} mutation One of `MUTATIONS` (the retargets never change the text).
 * @returns {string | null}
 */
export function mutate(css, mutation) {
  const items = splitTop(css);

  if (!items?.length) {
    return null;
  }

  const rules = items.filter((item) => item.kind === 'rule');

  if (Object.hasOwn(WRAPPERS, mutation)) {
    const blocked = items.some((item) => item.kind === 'at-stmt' && TOP_ONLY_AT_RULE_RE.test(item.prelude));

    if (blocked) {
      return null;
    }

    return `${WRAPPERS[/** @type {keyof typeof WRAPPERS} */ (mutation)]} {\n${joinItems(items)}}\n`;
  }

  if (mutation === 'nest') {
    return rules.length ? nest(items) : null;
  }

  if (mutation === 'duplicate-nonadjacent') {
    if (!rules.length) {
      return null;
    }

    /** @type {TopItem} */
    const separator = { kind: 'rule', prelude: '.lcr-sep', body: 'color: inherit' };

    return joinItems([...items, separator, { ...rules[0] }]);
  }

  return mutateRules(items, mutation);
}

// ---------------------------------------------------------------------------------------------
// Mutation cases

/**
 * `engine-<profile>` retargets: exactly the versions of each installed legacy engine set, so the
 * lowering for that engine is exercised and then rendered by that engine (wpt-engines §3.3).
 *
 * @returns {Map<string, Targets>} Sorted by profile name.
 */
export function engineTargets() {
  const env =
    /** @type {{ profiles?: Record<string, EngineProfileConfig & { versions?: Record<string, unknown> }> } | null} */ (
      readJson(join(cacheDir(), 'env.json'), {})
    );
  /** @type {Map<string, Targets>} */
  const out = new Map();
  const profiles = Object.entries(pyTruthy(env?.profiles) ? (env?.profiles ?? {}) : {});

  for (const [name, profile] of pySorted(profiles, ([profileName]) => profileName)) {
    if (profile.role !== 'legacy') {
      continue;
    }

    const targets = versionTargets(pyTruthy(profile.versions) ? (profile.versions ?? {}) : {});

    if (Object.keys(targets).length) {
      out.set(`engine-${name}`, targets);
    }
  }

  return out;
}

/**
 * Engine versions (`97.0.4692.20`) as Lightning CSS targets (`major << 16 | minor << 8 | patch`).
 *
 * @param {Record<string, unknown>} versions
 * @returns {Targets}
 */
function versionTargets(versions) {
  /** @type {Targets} */
  const targets = {};

  // Engine -> Lightning CSS browser target key, in the order the targets are written.
  const engineToTarget = /** @type {EnginesConfig} */ (loadConfig('engines.json')).engine_to_target;

  for (const [engine, key] of Object.entries(engineToTarget)) {
    const raw = Object.hasOwn(versions, engine) ? versions[engine] : '';
    const match = VERSION_RE.exec(pyStr(raw));

    if (match) {
      targets[key] = encodeEngineVersion(match);
    }
  }

  return targets;
}

/**
 * Python's `(major << 16) | (minor << 8) | min(patch, 255)` with unbounded integers: BigInt keeps
 * the bit operations exact for any number of digits (the result stays a BigInt beyond 2^53, which
 * the JSON layer writes as an int).
 *
 * @param {RegExpExecArray} match
 * @returns {number}
 */
function encodeEngineVersion(match) {
  const part = (/** @type {string | undefined} */ digits) => BigInt(pyDigitsToInt(digits ?? '0'));
  const patch = part(match[3]) < BigInt(MAX_PATCH) ? part(match[3]) : BigInt(MAX_PATCH);
  const value = (part(match[1]) << 16n) | (part(match[2]) << 8n) | patch;

  return value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : /** @type {number} */ (/** @type {unknown} */ (value));
}

/**
 * A probe's `dom:` override adapted to the mutation: `nest` puts every rule under `.lcr-n`, so the
 * fragment needs that ancestor; other mutations keep the selectors and reuse the parent's DOM.
 *
 * @param {string | null | undefined} dom
 * @param {string} mutation
 * @returns {string | null}
 */
export function mutationDom(dom, mutation) {
  if (dom && mutation === 'nest') {
    return `<div class="lcr-n">${dom}</div>`;
  }

  return null;
}

/**
 * Python's `==` between two target sets (or None).
 *
 * @param {Targets | null | undefined} left
 * @param {Targets | null | undefined} right
 * @returns {boolean}
 */
function sameTargets(left, right) {
  return jsonLineText(left ?? null) === jsonLineText(right ?? null);
}

/**
 * The retarget table: the three fixed presets, then one entry per installed legacy engine set.
 *
 * @returns {Map<string, Targets | null>}
 */
function retargets() {
  const modes = /** @type {ModesConfig} */ (loadConfig('modes.json'));

  return new Map([
    ['retarget-none', null],
    ['retarget-modern', parseTargets(modes.targets.modern)],
    ['retarget-legacy', parseTargets(modes.targets['legacy-2020'])],
    ...engineTargets(),
  ]);
}

/**
 * The request of one mutation of `request`, or null when that mutation does not apply.
 *
 * @param {AdapterRequest} request The parent's request (a `sheet` with CSS).
 * @param {string} mutation
 * @param {Map<string, Targets | null>} targetTable
 * @returns {AdapterRequest | null}
 */
function mutatedRequest(request, mutation, targetTable) {
  if (mutation.startsWith('retarget-') || mutation.startsWith('engine-')) {
    const targets = targetTable.get(mutation) ?? null;

    if (!request.minify || sameTargets(targets, request.targets)) {
      return null;
    }

    const { printer_targets: _printer, include: _include, exclude: _exclude, ...rest } = request;

    return { ...rest, targets };
  }

  const css = mutate(/** @type {string} */ (request.css), mutation);

  return css && css !== request.css ? { ...request, css } : null;
}

/**
 * Mutation cases for the PR's own test inputs and probes (sheet requests only; CSS modules are
 * left alone because their output depends on the file name and class hashing).
 *
 * @param {readonly CorpusCase[]} parents Head-side tuple cases and PR probe cases.
 * @param {number} [limit] At most this many parents, by id.
 * @returns {CorpusCase[]}
 */
export function mutationCases(parents, limit = DEFAULT_PARENT_LIMIT) {
  const targetTable = retargets();
  const names = [...MUTATIONS, ...[...targetTable.keys()].filter((name) => name.startsWith('engine-'))];
  /** @type {CorpusCase[]} */
  const out = [];

  for (const parent of pySorted(parents, (parentCase) => parentCase.id).slice(0, limit)) {
    const request = parent.request;

    // Python's `css_modules is not None`: a recorded `null` means CSS modules are off.
    if (request.kind !== 'sheet' || (request.css_modules ?? null) !== null || !request.css) {
      continue;
    }

    for (const mutation of names) {
      const mutated = mutatedRequest(request, mutation, targetTable);

      if (mutated) {
        out.push(mutationCase(parent, mutation, mutated));
      }
    }
  }

  return out;
}

/**
 * @param {CorpusCase} parent
 * @param {string} mutation
 * @param {AdapterRequest} request
 * @returns {CorpusCase}
 */
function mutationCase(parent, mutation, request) {
  const probe = 'probe' in parent ? parent.probe : null;
  const parentArea = 'area' in parent ? parent.area : null;
  /** @type {import('../types.js').CaseBase & import('../types.js').MutationCaseFields} */
  const mutationCase = {
    id: `m-${parent.id}-${mutation}`,
    source: 'mutation',
    mutation,
    parent: parent.id,
    area: parentArea || (probe?.area ?? null),
    request,
  };
  const dom = mutationDom(probe?.dom, mutation);

  if (dom) {
    mutationCase.dom = dom;
  }

  if (pyTruthy(parent.timeout)) {
    mutationCase.timeout = parent.timeout;
  }

  return mutationCase;
}
