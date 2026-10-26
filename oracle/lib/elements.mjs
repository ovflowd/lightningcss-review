/**
 * The element model of DOM synthesis: make one fresh element match one compound selector.
 *
 * Stage: oracle (analysis image, prepare-jobs.mjs). The goal is coverage, not proof: the input and
 * every output are evaluated on the same DOM, so a simple selector we cannot satisfy only lowers
 * coverage (counted in `unsupported`); it can never create a false "different".
 */
import * as csstree from 'css-tree';

import { STATE_ATTRS, firstCompoundOf, pseudoElementName, toSteps } from './selectors.mjs';

/** @import { CssNode } from 'css-tree' */

/**
 * @typedef {object} SynthElement An element to render (dom.mjs).
 * @property {string} tag
 * @property {string | null} id
 * @property {string[]} classes
 * @property {Record<string, string>} attrs
 * @property {SynthElement[]} children
 * @property {string | null} text
 * @property {boolean} empty `:empty`: no children, no text.
 * @property {SynthElement[]} [afterSiblings] Elements reached with `+` or `~`, rendered right after.
 * @property {number} [spacersBefore] Empty siblings before it (`:nth-child`).
 * @property {number} [spacersAfter] Empty siblings after it (`:nth-last-child`).
 * @property {string} [spacerTag]
 */

/**
 * @typedef {object} CompoundContext
 * @property {number} unsupported Simple selectors that could not be satisfied.
 * @property {boolean} [root] The compound contains `:root`.
 */

/** Lightning CSS lowers `:dir(rtl)` to `:lang()` over this list. */
export const RTL_LANGS = new Set(
  'ae ar arc bcc bqi ckb dv fa glk he ku mzn nqo pnb ps sd ug ur yi'.split(' '),
);

/** Attribute matchers whose value the attribute must carry (`[a="b"]`, `[a^="b"]`, …). */
const VALUE_MATCHERS = new Set(['|=', '^=', '~=', '$=', '*=', '=']);

/** How far `An+B` is searched for its smallest positive match. */
const MAX_NTH_INDEX = 20;

/**
 * A fresh element.
 *
 * @param {string} [tag]
 * @returns {SynthElement}
 */
export function newElement(tag = 'div') {
  return { tag, id: null, classes: [], attrs: {}, children: [], text: null, empty: false };
}

/**
 * The smallest positive (1-based) index matching an `:nth-*()` argument.
 *
 * @param {CssNode | null | undefined} nth
 * @returns {number}
 */
export function nthIndex(nth) {
  if (!nth) {
    return 1;
  }

  if (nth.type === 'Identifier') {
    return nth.name === 'even' ? 2 : 1;
  }

  if (nth.type !== 'AnPlusB') {
    return 1;
  }

  const a = Number(nth.a || 0);
  const b = Number(nth.b || 0);

  for (let k = 1; k <= MAX_NTH_INDEX; k++) {
    if (a === 0 ? k === b : (k - b) / a >= 0 && Number.isInteger((k - b) / a)) {
      return k;
    }
  }

  return 1;
}

/**
 * Form-control pseudo-classes turn a plain element into an `<input>`; an explicit type selector wins.
 *
 * @param {SynthElement} element
 */
function makeFormControl(element) {
  element.tag = element.tag === 'div' ? 'input' : element.tag;
}

/**
 * @typedef {(element: SynthElement, argument: CssNode | null, context: CompoundContext, name: string) => void} PseudoClassHandler
 */

/**
 * `:is()`, `:where()` and their old aliases: satisfy the first single-step selector of the list.
 *
 * @type {PseudoClassHandler}
 */
function applyMatchesAny(element, argument, context) {
  const compound = argument && argument.type === 'SelectorList' ? firstCompoundOf(argument) : null;

  if (compound) {
    applyCompound(element, compound, context);
  } else {
    context.unsupported++;
  }
}

/**
 * `:has(> .x)`, `:has(.x)`, `:has(+ .x)`: add a matching child or next sibling. Every selector of
 * the list adds one (css-tree's list `forEach` passes list items, not indexes, so the original
 * "first selector only" guard never fired; kept as is for verdict stability).
 *
 * @type {PseudoClassHandler}
 */
function applyHas(element, argument, context) {
  if (!argument || argument.type !== 'SelectorList') {
    return;
  }

  argument.children?.forEach((selector) => {
    if (selector.type !== 'Selector') {
      return;
    }

    const steps = toSteps(selector);
    const child = newElement();

    applyCompound(child, steps[steps.length - 1].compound, context);

    const combinator = steps.length > 1 ? steps[1].combinator : steps[0].combinator || ' ';

    if (combinator === '+' || combinator === '~') {
      (element.afterSiblings = element.afterSiblings || []).push(child);
    } else {
      element.children.push(child);
    }
  });
}

/**
 * `:dir()`: an RTL element normally carries an RTL language, which is what lowered `:dir(rtl)` matches.
 *
 * @type {PseudoClassHandler}
 */
function applyDir(element, argument) {
  if (argument) {
    element.attrs.dir = argument.name || 'ltr';
  }

  if (element.attrs.dir === 'rtl' && !element.attrs.lang) {
    element.attrs.lang = 'ar';
  }
}

/**
 * `:lang()`: an RTL language makes the element RTL too, so `:dir(rtl)` matches it as well.
 *
 * @type {PseudoClassHandler}
 */
function applyLang(element, argument) {
  if (argument) {
    element.attrs.lang =
      argument.name ||
      (argument.value ? csstree.string.decode(/** @type {string} */ (argument.value)) : 'en');
  }

  if (RTL_LANGS.has(String(element.attrs.lang).toLowerCase().split('-')[0]) && !element.attrs.dir) {
    element.attrs.dir = 'rtl';
  }
}

/**
 * `:nth-child()`, `:nth-of-type()`: empty siblings before the element.
 *
 * @type {PseudoClassHandler}
 */
function applyNth(element, argument, _context, name) {
  const index = argument && argument.nth ? nthIndex(argument.nth) : 1;

  element.spacersBefore = Math.max(element.spacersBefore || 0, index - 1);
  element.spacerTag = name === 'nth-of-type' ? element.tag : 'span';
}

/**
 * `:nth-last-child()`, `:nth-last-of-type()`: empty siblings after the element.
 *
 * @type {PseudoClassHandler}
 */
function applyNthLast(element, argument) {
  const index = argument && argument.nth ? nthIndex(argument.nth) : 1;

  element.spacersAfter = Math.max(element.spacersAfter || 0, index - 1);
}

/**
 * A Map entry (keeps the table below typed).
 *
 * @param {string} name
 * @param {PseudoClassHandler} handler
 * @returns {[string, PseudoClassHandler]}
 */
function entry(name, handler) {
  return [name, handler];
}

/** @type {PseudoClassHandler} */
const satisfiedByConstruction = () => {};

/**
 * What each supported pseudo-class does to the element. Absent names count as unsupported.
 *
 * @type {Map<string, PseudoClassHandler>}
 */
const PSEUDO_CLASSES = new Map([
  ['is', applyMatchesAny],
  ['where', applyMatchesAny],
  ['matches', applyMatchesAny],
  ['-webkit-any', applyMatchesAny],
  ['-moz-any', applyMatchesAny],
  ['has', applyHas],
  // A fresh element rarely matches the argument of :not().
  ['not', satisfiedByConstruction],
  [
    'root',
    (_element, _argument, context) => {
      context.root = true;
    },
  ],
  [
    'empty',
    (element) => {
      element.empty = true;
    },
  ],
  ['dir', applyDir],
  ['lang', applyLang],
  ...['link', 'any-link', '-webkit-any-link'].map((name) =>
    entry(name, (element) => {
      element.tag = 'a';
      element.attrs.href = '#lcr';
    }),
  ),
  ...['checked', 'default'].map((name) =>
    entry(name, (element) => {
      element.tag = 'input';
      element.attrs.type = 'checkbox';
      element.attrs.checked = '';
    }),
  ),
  [
    'disabled',
    (element) => {
      makeFormControl(element);
      element.attrs.disabled = '';
    },
  ],
  ...['enabled', 'optional', 'read-write'].map((name) => entry(name, makeFormControl)),
  ...['required', 'invalid', 'user-invalid'].map((name) =>
    entry(name, (element) => {
      makeFormControl(element);
      element.attrs.required = '';
    }),
  ),
  [
    'read-only',
    (element) => {
      makeFormControl(element);
      element.attrs.readonly = '';
    },
  ],
  ...['placeholder-shown', '-moz-placeholder-shown'].map((name) =>
    entry(name, (element) => {
      element.tag = 'input';
      element.attrs.placeholder = 'x';
    }),
  ),
  // Each step is a fresh, single child, so these hold by construction.
  ...['first-child', 'last-child', 'only-child', 'first-of-type', 'last-of-type', 'only-of-type'].map(
    (name) => entry(name, satisfiedByConstruction),
  ),
  ['nth-child', applyNth],
  ['nth-of-type', applyNth],
  ['nth-last-child', applyNthLast],
  ['nth-last-of-type', applyNthLast],
]);

/**
 * Apply a pseudo-class to the element.
 *
 * @param {SynthElement} element
 * @param {CssNode} node
 * @param {CompoundContext} context
 */
function applyPseudoClass(element, node, context) {
  const name = node.name.toLowerCase();
  const argument = node.children && node.children.first ? node.children.first : null;

  if (STATE_ATTRS[name]) {
    // Rewritten to an attribute selector in every sheet (sheets.mjs rewriteStates).
    element.attrs[STATE_ATTRS[name]] = '';

    return;
  }

  const handler = PSEUDO_CLASSES.get(name);

  if (handler) {
    handler(element, argument, context, name);
  } else {
    context.unsupported++;
  }
}

/**
 * Attribute selectors: set the attribute, with the value the matcher needs.
 *
 * @param {SynthElement} element
 * @param {CssNode} node
 */
function applyAttribute(element, node) {
  const name = csstree.ident.decode(nodeName(node).name);
  const valueNode = /** @type {CssNode | null | undefined} */ (node.value);
  let value = '';

  if (valueNode) {
    value =
      valueNode.type === 'String'
        ? csstree.string.decode(/** @type {string} */ (valueNode.value))
        : valueNode.name || '';
  }

  if (VALUE_MATCHERS.has(/** @type {string} */ (node.matcher))) {
    element.attrs[name] = value;
  } else {
    element.attrs[name] = element.attrs[name] || '';
  }
}

/**
 * The Identifier node of an AttributeSelector's name.
 *
 * @param {CssNode} node
 * @returns {CssNode}
 */
function nodeName(node) {
  return /** @type {CssNode} */ (/** @type {unknown} */ (node.name));
}

/**
 * Pseudo-elements that need a particular host element to exist at all.
 *
 * @param {SynthElement} element
 * @param {CssNode} node
 */
function applyPseudoElement(element, node) {
  const name = pseudoElementName(node);

  if (name === 'marker' && element.tag === 'div') {
    element.tag = 'li';
  }

  if (name === 'placeholder') {
    element.tag = 'input';
    element.attrs.placeholder = 'x';
  }

  if (name === 'file-selector-button') {
    element.tag = 'input';
    element.attrs.type = 'file';
  }
}

/**
 * Make the element match every simple selector of a compound.
 *
 * @param {SynthElement} element
 * @param {CssNode[]} compound
 * @param {CompoundContext} context
 */
export function applyCompound(element, compound, context) {
  for (const node of compound) {
    switch (node.type) {
      case 'TypeSelector': {
        // `ns|tag`: namespaces do not exist in an HTML fragment; `*` keeps the default tag.
        const name = node.name.includes('|') ? /** @type {string} */ (node.name.split('|').pop()) : node.name;

        if (name !== '*') {
          element.tag = name.toLowerCase();
        }

        break;
      }

      case 'ClassSelector':
        element.classes.push(csstree.ident.decode(node.name));
        break;
      case 'IdSelector':
        element.id = csstree.ident.decode(node.name);
        break;
      case 'AttributeSelector':
        applyAttribute(element, node);
        break;
      case 'PseudoClassSelector':
        // One-colon CSS 2 pseudo-elements parse as pseudo-classes.
        if (pseudoElementName(node) === null) {
          applyPseudoClass(element, node, context);
        }

        break;
      case 'PseudoElementSelector':
        applyPseudoElement(element, node);
        break;
      case 'NestingSelector':
        break;
      default:
        context.unsupported++;
    }
  }
}
