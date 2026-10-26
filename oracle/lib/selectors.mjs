/**
 * Selectors of a sheet as absolute step lists, with CSS Nesting resolved.
 *
 * Stage: oracle (analysis image, prepare-jobs.mjs). DOM synthesis (dom.mjs) builds one DOM path
 * per selector; this module finds those selectors. A selector is an array of steps
 * `{combinator, compound}`: the combinator that leads to the step (null for the first) and the
 * simple selectors of its compound.
 *
 * Nested rules are resolved against their parents the way CSS Nesting reads them (`&` is the
 * parent selector; a rule without `&` is a descendant of it), and `@scope (<root>)` treats its
 * first root selector as the parent.
 */
import * as csstree from 'css-tree';

import { isKeyframes } from './css.mjs';

/** @import { CssNode } from 'css-tree' */

/**
 * @typedef {object} Step One compound of a selector and the combinator that leads to it.
 * @property {string | null} combinator `' '`, `>`, `+`, `~`, or null for the first step.
 * @property {CssNode[]} compound
 */

/** @typedef {Step[]} Steps */

/** User-action pseudo-classes, rewritten to these attributes in every sheet (see sheets.mjs). */
export const STATE_ATTRS = /** @type {Record<string, string>} */ ({
  hover: 'data-lcr-hover',
  active: 'data-lcr-active',
  focus: 'data-lcr-focus',
  'focus-visible': 'data-lcr-focus-visible',
  'focus-within': 'data-lcr-focus-within',
  target: 'data-lcr-target',
  visited: 'data-lcr-visited',
});

/** Pseudo-elements getComputedStyle can read. */
const READABLE_PSEUDOS = new Set([
  'before',
  'after',
  'marker',
  'first-line',
  'first-letter',
  'placeholder',
  'selection',
  'backdrop',
  'file-selector-button',
]);

/**
 * Prefixed aliases are read through the standard pseudo-element (getComputedStyle does not accept
 * most prefixed names); an engine that cannot resolve the standard name reads nothing for both.
 */
const PSEUDO_ALIASES = /** @type {Record<string, string>} */ ({
  '-moz-placeholder': 'placeholder',
  '-webkit-input-placeholder': 'placeholder',
  '-ms-input-placeholder': 'placeholder',
  '-moz-selection': 'selection',
  '-webkit-backdrop': 'backdrop',
  '-ms-backdrop': 'backdrop',
  '-webkit-file-upload-button': 'file-selector-button',
  '-ms-browse': 'file-selector-button',
});

/** CSS 2 pseudo-elements that may be written with one colon (Lightning CSS prints them that way). */
const LEGACY_PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter']);

/**
 * The standard pseudo-element name of a selector node, or null when the node is not one.
 *
 * @param {CssNode} node
 * @returns {string | null}
 */
export function pseudoElementName(node) {
  if (node.type !== 'PseudoElementSelector' && node.type !== 'PseudoClassSelector') {
    return null;
  }

  const name = node.name.toLowerCase();

  if (node.type === 'PseudoElementSelector') {
    return PSEUDO_ALIASES[name] || name;
  }

  return LEGACY_PSEUDO_ELEMENTS.has(name) ? name : null;
}

/**
 * Split a Selector node into steps. A leading combinator (a relative selector such as `> .c`)
 * keeps an empty first step, so nesting can tell it from a descendant.
 *
 * @param {CssNode} selector
 * @returns {Steps}
 */
export function toSteps(selector) {
  /** @type {Steps} */
  const steps = [];
  /** @type {Step} */
  let current = { combinator: null, compound: [] };

  selector.children?.forEach((child) => {
    if (child.type === 'Combinator') {
      if (current.compound.length || steps.length === 0) {
        steps.push(current);
      }

      current = { combinator: child.name, compound: [] };
    } else {
      current.compound.push(child);
    }
  });
  steps.push(current);

  return steps.filter((step, index) => step.compound.length || index === 0);
}

/**
 * @param {Steps} steps
 * @returns {boolean}
 */
function hasNesting(steps) {
  return steps.some((step) => step.compound.some((node) => node.type === 'NestingSelector'));
}

/**
 * @param {Steps} steps
 * @returns {Steps}
 */
function copySteps(steps) {
  return steps.map((step) => ({ ...step, compound: [...step.compound] }));
}

/**
 * Replace each `&` of a child selector with the parent's steps.
 *
 * @param {Steps} child
 * @param {Steps} parent
 * @returns {Steps}
 */
function substituteParent(child, parent) {
  /** @type {Steps} */
  const steps = [];

  child.forEach((step, index) => {
    if (!step.compound.some((node) => node.type === 'NestingSelector')) {
      steps.push(step);

      return;
    }

    const rest = step.compound.filter((node) => node.type !== 'NestingSelector');
    const parentSteps = copySteps(parent);

    if (index !== 0) {
      parentSteps[0] = { ...parentSteps[0], combinator: step.combinator };
    }

    parentSteps[parentSteps.length - 1].compound.push(...rest);
    steps.push(...parentSteps);
  });

  return steps;
}

/**
 * A child selector without `&` under a parent: a descendant, or, for a relative selector
 * (`> .c`), the given combinator.
 *
 * @param {Steps} child
 * @param {Steps} parent
 * @returns {Steps}
 */
function appendToParent(child, parent) {
  // A relative selector's first step is empty and its second carries the combinator.
  const relative = child[0].compound.length === 0 && child.length > 1;
  const tail = relative
    ? child.slice(1)
    : child.map((step, index) => (index === 0 ? { ...step, combinator: ' ' } : step));

  return [...parent, ...tail];
}

/**
 * Resolve a nested selector against its parent selectors (CSS Nesting: `&` means `:is(parent)`).
 *
 * @param {Steps} child
 * @param {Steps[] | null} parents
 * @returns {Steps[]}
 */
export function resolveNested(child, parents) {
  if (!parents || !parents.length) {
    // At the top level `&` refers to the scoping root (`:root`): drop it.
    return [
      child.map((step) => ({
        ...step,
        compound: step.compound.filter((node) => node.type !== 'NestingSelector'),
      })),
    ];
  }

  const nested = hasNesting(child);

  return parents.map((parent) => (nested ? substituteParent(child, parent) : appendToParent(child, parent)));
}

/**
 * The root selectors of `@scope (<root>) [to (<limit>)]`: the first selector list in the prelude.
 *
 * @param {CssNode} prelude
 * @returns {Steps[] | null}
 */
function scopeRoots(prelude) {
  /** @type {Steps[] | null} */
  let roots = null;

  csstree.walk(prelude, {
    visit: 'SelectorList',
    enter(list) {
      if (roots) {
        return;
      }

      /** @type {Steps[]} */
      const found = [];

      roots = found;
      list.children?.forEach((selector) => {
        if (selector.type === 'Selector') {
          found.push(toSteps(selector));
        }
      });
    },
  });

  return roots;
}

/**
 * @typedef {object} CollectedSelectors
 * @property {Steps[]} selectors Absolute selectors in source order.
 * @property {string[]} pseudos Readable pseudo-elements used (`::before`), sorted.
 * @property {number} unsupported Pseudo-elements used that cannot be read.
 */

/**
 * Collect absolute selectors and the pseudo-elements they use, walking nested rules and
 * conditional at-rules (never keyframes).
 *
 * @param {CssNode} ast
 * @returns {CollectedSelectors}
 */
export function collectSelectors(ast) {
  /** @type {Steps[]} */
  const selectors = [];

  /**
   * @param {CssNode | null | undefined} block
   * @param {Steps[] | null} parents
   */
  const visitBlock = (block, parents) => {
    block?.children?.forEach((node) => visitNode(node, parents));
  };
  /**
   * @param {CssNode} node
   * @param {Steps[] | null} parents
   */
  const visitNode = (node, parents) => {
    if (node.type === 'Rule' && node.prelude && node.prelude.type === 'SelectorList') {
      /** @type {Steps[]} */
      const resolved = [];

      node.prelude.children?.forEach((selector) => {
        if (selector.type === 'Selector') {
          resolved.push(...resolveNested(toSteps(selector), parents));
        }
      });
      selectors.push(...resolved);
      visitBlock(node.block, resolved);
    } else if (node.type === 'Atrule' && !isKeyframes(node)) {
      if (node.name === 'scope' && node.prelude) {
        visitBlock(node.block, scopeRoots(node.prelude) || parents);
      } else if (node.block) {
        visitBlock(node.block, parents);
      }
    }
  };

  visitBlock(ast, null);

  return { selectors, ...usedPseudoElements(selectors) };
}

/**
 * @param {Steps[]} selectors
 * @returns {{ pseudos: string[], unsupported: number }}
 */
function usedPseudoElements(selectors) {
  const pseudos = new Set();
  let unsupported = 0;

  for (const node of selectors.flat().flatMap((step) => step.compound)) {
    const name = pseudoElementName(node);

    if (name === null) {
      continue;
    }

    if (READABLE_PSEUDOS.has(name)) {
      pseudos.add('::' + name);
    } else {
      unsupported++;
    }
  }

  return { pseudos: [...pseudos].sort(), unsupported };
}

/**
 * The compound of the first single-step selector of a list (`:is(.a, .b > .c)` -> `.a`).
 *
 * @param {CssNode | null} selectorList
 * @returns {CssNode[] | null}
 */
export function firstCompoundOf(selectorList) {
  /** @type {CssNode[] | null} */
  let first = null;

  if (!selectorList) {
    return null;
  }

  selectorList.children?.forEach((selector) => {
    if (first || selector.type !== 'Selector') {
      return;
    }

    const steps = toSteps(selector);

    if (steps.length === 1) {
      first = steps[0].compound;
    }
  });

  return first;
}
