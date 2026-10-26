/**
 * Source-level rewrites applied identically to every sheet of a job.
 *
 * Stage: oracle (analysis image, prepare-jobs.mjs). Both rewrites edit exact source offsets and
 * leave the rest of the text untouched, so the input and every output receive the same change
 * and any difference the engines then see still comes from Lightning CSS.
 * - rewriteStates: user-action pseudo-classes (`:hover`) become attribute selectors the
 *   synthesized DOM carries, so their rules apply without real user interaction.
 * - undefinedCustomProperties: custom properties the input uses but never defines get a
 *   stand-in definition, so the declarations consuming them compute.
 */
import * as csstree from 'css-tree';

import { parseSheet } from './css.mjs';
import { STATE_ATTRS } from './selectors.mjs';

/**
 * `var(--name` with an optional `,` (a fallback). Names may contain any non-ASCII character
 * (U+0080 and up), as CSS identifiers do.
 */
const CUSTOM_REF = new RegExp(
  `var\\(\\s*(--[A-Za-z0-9_\\-${String.fromCharCode(0x80)}-${String.fromCharCode(0xffff)}]+)\\s*(,)?`,
  'g',
);

/** Properties whose value is a color: a stand-in color keeps such a declaration valid. */
const COLOR_PROP = /(^|-)color$|^(fill|stroke|background|outline|text-decoration|text-emphasis|column-rule)$/;

/** Stand-in values: a color for color properties, a length everywhere else. */
const STAND_IN_COLOR = 'rgb(1, 2, 3)';
const STAND_IN_LENGTH = '5px';

/**
 * Custom properties the sheet references without a fallback but never defines, each with a
 * stand-in value typed after the first property that consumes it (`[name, value]`, sorted).
 * Without a definition the consuming declaration is invalid at computed-value time and the input
 * touches nothing, so the case could never be judged.
 *
 * @param {string} css
 * @returns {[name: string, value: string][]}
 */
export function undefinedCustomProperties(css) {
  const ast = parseSheet(css);

  if (!ast) {
    return [];
  }

  const defined = new Set();
  /** @type {Map<string, string>} */
  const used = new Map();

  csstree.walk(ast, {
    enter(node) {
      if (node.type === 'Atrule' && node.name.toLowerCase() === 'property' && node.prelude) {
        defined.add(csstree.generate(node.prelude).trim());
      }

      if (node.type !== 'Declaration' || !node.loc) {
        return;
      }

      const property = /** @type {string} */ (node.property);

      if (property.startsWith('--')) {
        defined.add(property);
      }

      const value = /** @type {import('css-tree').CssNode} */ (node.value);
      const text = css.slice(value.loc ? value.loc.start.offset : node.loc.start.offset, node.loc.end.offset);

      for (const match of text.matchAll(CUSTOM_REF)) {
        if (match[2] || used.has(match[1])) {
          continue;
        }

        used.set(match[1], COLOR_PROP.test(property.toLowerCase()) ? STAND_IN_COLOR : STAND_IN_LENGTH);
      }
    },
  });

  return [...used].filter(([name]) => !defined.has(name)).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/**
 * Rewrite user-action pseudo-classes in selectors to attribute selectors, by editing exact source
 * offsets. Media features such as `(hover: hover)` are not selectors and stay as they are.
 *
 * @param {string} css
 * @returns {{ css: string, rewrites: number }} `rewrites` counts every occurrence found.
 */
export function rewriteStates(css) {
  const ast = parseSheet(css);

  if (!ast) {
    return { css, rewrites: 0 };
  }

  /** @type {[start: number, end: number, text: string][]} */
  const edits = [];

  csstree.walk(ast, {
    visit: 'PseudoClassSelector',
    enter(node) {
      const attribute = STATE_ATTRS[node.name.toLowerCase()];

      if (!attribute || !node.loc || node.children) {
        return;
      }

      edits.push([node.loc.start.offset, node.loc.end.offset, `[${attribute}]`]);
    },
  });
  edits.sort((a, b) => a[0] - b[0]);

  /** @type {string[]} */
  const parts = [];
  let at = 0;

  for (const [start, end, text] of edits) {
    // Overlapping or misplaced locations (recovered parse errors) are left alone.
    if (start < at || !css.slice(start, end).startsWith(':')) {
      continue;
    }

    parts.push(css.slice(at, start), text);
    at = end;
  }

  parts.push(css.slice(at));

  return { css: parts.join(''), rewrites: edits.length };
}
