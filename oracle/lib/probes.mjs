/**
 * Validity probes: the declarations, selectors and conditions each engine is asked to accept.
 *
 * Stage: oracle (analysis image, prepare-jobs.mjs). The engine runner feeds these lists to the
 * CSSOM (`style.setProperty`, `insertRule`); compare.mjs reports what an output makes an engine
 * reject that the input did not. The probe is always the exact source text (from css-tree's
 * offsets), never a re-serialization, so it tests what Lightning CSS printed.
 */
import * as csstree from 'css-tree';

import { isKeyframes, parseSheet } from './css.mjs';

/** @import { CssNode } from 'css-tree' */
/** @import { ValidityProbe, ProbeDecl, ProbePrelude } from './types.mjs' */

/** Entries per list: enough for any realistic case, bounded for huge real-world sheets. */
const PROBE_LIMIT = 400;

/** An at-keyword with CSS escapes, matched at a given offset (`lastIndex`). */
const AT_KEYWORD = /@(?:[-\w]|\\[0-9a-fA-F]{1,6}\s?|\\.)+/y;

/** Conditional at-rules whose prelude is probed. */
const CONDITIONAL_AT_RULES = ['media', 'supports', 'container'];

const CLOSING = /** @type {Record<string, string>} */ ({ ')': '(', ']': '[' });

/**
 * Whether parentheses and brackets balance outside strings and comments.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function balanced(text) {
  /** @type {string[]} */
  const stack = [];

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (char === '\\') {
      i++;
    } else if (char === '"' || char === "'") {
      for (i++; i < text.length && text[i] !== char; i++) {
        if (text[i] === '\\') {
          i++;
        }
      }
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);

      i = end < 0 ? text.length : end + 1;
    } else if (char === '(' || char === '[') {
      stack.push(char);
    } else if (CLOSING[char] && stack.pop() !== CLOSING[char]) {
      return false;
    }
  }

  return stack.length === 0;
}

/**
 * The exact source text of a node (its generated form when it has no offsets).
 *
 * @param {string} css
 * @param {CssNode | null | undefined} node
 * @returns {string}
 */
function sourceOf(css, node) {
  if (node && node.loc) {
    return css.slice(node.loc.start.offset, node.loc.end.offset);
  }

  return node ? csstree.generate(node) : '';
}

/**
 * The prelude of a conditional at-rule: everything between the at-keyword and the block. css-tree's
 * prelude offsets can start after a leading `(` (`@supports ((a:b) or (c:d))`) and end before the
 * last `)`, so the text is sliced from the source instead, when it balances.
 *
 * @param {string} css
 * @param {CssNode} node
 * @returns {string}
 */
function preludeSource(css, node) {
  if (node.loc && node.block && node.block.loc) {
    AT_KEYWORD.lastIndex = node.loc.start.offset;

    if (AT_KEYWORD.exec(css)) {
      const text = css.slice(AT_KEYWORD.lastIndex, node.block.loc.start.offset).trim();

      if (balanced(text)) {
        return text;
      }
    }
  }

  return csstree.generate(/** @type {CssNode} */ (node.prelude));
}

/**
 * The lists for the engine to test in one sheet. Nested rule selectors are only valid relative to
 * their parent, and keyframe selectors are not selectors at all: neither is probed on its own.
 *
 * @param {string} css
 * @param {number} [limit]
 * @returns {ValidityProbe}
 */
export function validityProbe(css, limit = PROBE_LIMIT) {
  const ast = parseSheet(css);
  /** @type {ProbeDecl[]} */
  const decls = [];
  /** @type {string[]} */
  const selectors = [];
  /** @type {ProbePrelude[]} */
  const preludes = [];

  if (!ast) {
    return { decls, selectors, preludes, parsed: false };
  }

  let ruleDepth = 0;
  let keyframesDepth = 0;

  csstree.walk(ast, {
    enter(node) {
      if (node.type === 'Declaration' && decls.length < limit) {
        const value = sourceOf(css, /** @type {CssNode} */ (node.value))
          .trim()
          .replace(/!\s*important\s*$/i, '')
          .trim();

        decls.push([/** @type {string} */ (node.property), value, Boolean(node.important)]);
      } else if (node.type === 'Rule') {
        const topLevel = !ruleDepth && !keyframesDepth;

        if (node.prelude && node.prelude.type === 'SelectorList' && selectors.length < limit && topLevel) {
          const text = sourceOf(css, node.prelude).trim();

          if (!text.includes('&')) {
            selectors.push(text);
          }
        }

        ruleDepth++;
      } else if (node.type === 'Atrule') {
        if (isKeyframes(node)) {
          keyframesDepth++;
        }

        if (
          CONDITIONAL_AT_RULES.includes(node.name.toLowerCase()) &&
          node.prelude &&
          preludes.length < limit
        ) {
          preludes.push([node.name, preludeSource(css, node).trim()]);
        }
      }
    },
    leave(node) {
      if (node.type === 'Rule') {
        ruleDepth--;
      } else if (isKeyframes(node)) {
        keyframesDepth--;
      }
    },
  });

  return { decls, selectors, preludes, parsed: true };
}
