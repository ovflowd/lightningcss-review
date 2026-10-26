/**
 * Selector -> DOM synthesis for the computed-style oracle.
 *
 * Stage: oracle (analysis image, prepare-jobs.mjs). Reads the sheets of a case and builds one
 * HTML fragment in which (ideally) every selector matches an element, so the engines have
 * something to compute each rule on. One `<div class="lcr-case">` per distinct selector, capped;
 * `:root`/`html` steps become attributes on the document element.
 *
 * The goal is coverage, not proof: the input and every output are evaluated on the same DOM, so a
 * selector we cannot match only lowers coverage; it can never create a false "different".
 * Deterministic: the same sheets always produce the same HTML.
 */
import * as csstree from 'css-tree';

import { parseSheet } from './css.mjs';
import { applyCompound, newElement } from './elements.mjs';
import { collectSelectors } from './selectors.mjs';

/** @import { SynthesizedDom } from './types.mjs' */
/** @import { SynthElement } from './elements.mjs' */
/** @import { Steps } from './selectors.mjs' */

/** Distinct selectors that get a DOM fragment; the rest only count. */
const MAX_SELECTORS = 60;

/** The DOM used when no selector could be synthesized: common elements with text. */
const GENERIC_DOM =
  '<div class="lcr-generic"><p>x <span>y</span> <a href="#lcr">z</a></p><ul><li>i</li></ul><input placeholder="x"></div>';

const VOID_TAGS = new Set([
  'input',
  'img',
  'br',
  'hr',
  'meta',
  'link',
  'area',
  'col',
  'embed',
  'source',
  'track',
  'wbr',
]);
const VALID_TAG = /^[a-z][a-z0-9-]*$/;
const VALID_ATTRIBUTE = /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/;

/**
 * @typedef {object} SynthesisContext
 * @property {number} unsupported
 * @property {Record<string, string>} rootAttrs Attributes for `<html>`.
 */

/**
 * `:root` / `html` as the first step: its classes, attributes and id go on the document element,
 * and the path continues under `#lcr-root`.
 *
 * @param {SynthElement} element
 * @param {SynthesisContext} context
 */
function hoistToRoot(element, context) {
  for (const name of element.classes) {
    context.rootAttrs.class = ((context.rootAttrs.class || '') + ' ' + name).trim();
  }

  Object.assign(context.rootAttrs, element.attrs);

  if (element.id) {
    context.rootAttrs.id = element.id;
  }
}

/**
 * Build the DOM fragment for one absolute selector; returns its top element (null when every
 * step was hoisted or skipped).
 *
 * @param {Steps} steps
 * @param {SynthesisContext} context
 * @returns {SynthElement | null}
 */
function buildPath(steps, context) {
  /** @type {SynthElement | null} */
  let top = null;
  /** @type {SynthElement | null} */
  let previous = null;
  /** @type {SynthElement | null} */
  let parentOfPrevious = null;

  for (const [index, step] of steps.entries()) {
    const element = newElement();
    const local = { unsupported: 0, root: false };

    applyCompound(element, step.compound, local);
    context.unsupported += local.unsupported;

    if (index === 0 && (local.root || element.tag === 'html')) {
      hoistToRoot(element, context);
      continue;
    }

    if (index <= 1 && element.tag === 'body') {
      // <body> is shared by every case; setting its attributes would leak into other cases.
      context.unsupported++;
      continue;
    }

    if (!previous) {
      top = element;
      parentOfPrevious = null;
    } else if (step.combinator === '+' || step.combinator === '~') {
      (previous.afterSiblings = previous.afterSiblings || []).push(element);

      if (!parentOfPrevious) {
        // Siblings of the top element: wrap both in a container.
        const wrapper = newElement('div');

        wrapper.children.push(/** @type {SynthElement} */ (top));
        top = wrapper;
        parentOfPrevious = wrapper;
      }
    } else {
      previous.children.push(element);
      parentOfPrevious = previous;
    }

    previous = element;
  }

  if (previous && !previous.empty) {
    previous.text = 'x';
  }

  return top;
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeAttribute(text) {
  return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * @param {SynthElement} element
 * @returns {string}
 */
function renderAttributes(element) {
  let attrs = '';

  if (element.id) {
    attrs += ` id="${escapeAttribute(element.id)}"`;
  }

  if (element.classes.length) {
    attrs += ` class="${escapeAttribute(element.classes.join(' '))}"`;
  }

  for (const [name, value] of Object.entries(element.attrs)) {
    if (VALID_ATTRIBUTE.test(name)) {
      attrs += ` ${name}="${escapeAttribute(value)}"`;
    }
  }

  return attrs;
}

/**
 * Empty siblings for `:nth-*()`.
 *
 * @param {number | undefined} count
 * @param {string | undefined} tag
 * @returns {string}
 */
function spacers(count, tag) {
  return Array.from({ length: count || 0 }, () => `<${tag || 'span'}></${tag || 'span'}>`).join('');
}

/**
 * Elements the HTML parser only keeps inside a particular parent get that parent.
 *
 * @param {string} tag
 * @param {string} parentTag
 * @param {string} html
 * @returns {string}
 */
function wrapForParser(tag, parentTag, html) {
  if (tag === 'li' && !['ul', 'ol', 'menu'].includes(parentTag)) {
    return `<ul>${html}</ul>`;
  }

  if (['td', 'th'].includes(tag) && parentTag !== 'tr') {
    return `<table><tbody><tr>${html}</tr></tbody></table>`;
  }

  if (tag === 'tr' && !['tbody', 'thead', 'tfoot', 'table'].includes(parentTag)) {
    return `<table><tbody>${html}</tbody></table>`;
  }

  if (tag === 'option' && !['select', 'datalist', 'optgroup'].includes(parentTag)) {
    return `<select>${html}</select>`;
  }

  return html;
}

/**
 * Serialize an element, its children and their sibling chains.
 *
 * @param {SynthElement} element
 * @param {string} [parentTag]
 * @returns {string}
 */
function render(element, parentTag = 'div') {
  const tag = VALID_TAG.test(element.tag) ? element.tag : 'div';
  /** @type {(child: SynthElement) => string} */
  const withSiblings = (child) => render(child, tag) + (child.afterSiblings || []).map(withSiblings).join('');
  const inner = element.empty ? '' : element.children.map(withSiblings).join('') + (element.text || '');
  const attrs = renderAttributes(element);
  const html = VOID_TAGS.has(tag) ? `<${tag}${attrs}>` : `<${tag}${attrs}>${inner}</${tag}>`;

  return (
    spacers(element.spacersBefore, element.spacerTag) +
    wrapForParser(tag, parentTag, html) +
    spacers(element.spacersAfter, element.spacerTag)
  );
}

/**
 * The identity of a selector for de-duplication: combinators and serialized compounds.
 *
 * @param {Steps} steps
 * @returns {string}
 */
function selectorKey(steps) {
  return JSON.stringify(
    steps.map((step) => [step.combinator, step.compound.map((node) => csstree.generate(node))]),
  );
}

/**
 * Synthesize one DOM for all sheets of a case.
 *
 * @param {string[]} sheets
 * @param {{ maxSelectors?: number }} [options]
 * @returns {SynthesizedDom}
 */
export function synthesize(sheets, { maxSelectors = MAX_SELECTORS } = {}) {
  /** @type {SynthesisContext} */
  const context = { unsupported: 0, rootAttrs: {} };
  const seen = new Set();
  /** @type {string[]} */
  const parts = [];
  const pseudos = new Set();
  let total = 0;

  for (const css of sheets) {
    const ast = parseSheet(css);

    if (!ast) {
      continue;
    }

    const found = collectSelectors(ast);

    found.pseudos.forEach((pseudo) => pseudos.add(pseudo));
    context.unsupported += found.unsupported;

    for (const steps of found.selectors) {
      total++;

      const key = selectorKey(steps);

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);

      if (parts.length >= maxSelectors) {
        continue;
      }

      const top = buildPath(steps, context);

      // :has(+ .x) on the top element adds siblings the container must hold too.
      if (top) {
        parts.push(
          `<div class="lcr-case">${render(top)}${(top.afterSiblings || []).map((x) => render(x)).join('')}</div>`,
        );
      }
    }
  }

  return {
    html: parts.length ? parts.join('') : GENERIC_DOM,
    pseudos: [...pseudos].sort(),
    rootAttrs: context.rootAttrs,
    selectors: total,
    synthesized: parts.length,
    unsupported: context.unsupported,
    generic: !parts.length,
  };
}

/**
 * Readable pseudo-elements any of the sheets use (for a DOM the case supplies, not synthesized).
 *
 * @param {string[]} sheets
 * @returns {string[]}
 */
export function collectPseudos(sheets) {
  const pseudos = new Set();

  for (const css of sheets) {
    const ast = parseSheet(css);

    if (ast) {
      collectSelectors(ast).pseudos.forEach((pseudo) => pseudos.add(pseudo));
    }
  }

  return [...pseudos].sort();
}
