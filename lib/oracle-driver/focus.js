/**
 * Focus the oracle on what a change touches in a large stylesheet.
 *
 * Stage: oracle (case selection) and inspect (`lcr show` diffs of large outputs). The oracle
 * synthesizes a DOM from the selectors of a sheet; for a large real-world sheet that would be the
 * first few hundred selectors of the file, which usually have nothing to do with the change. So
 * for such cases the driver hands prepare-jobs.mjs a `domFrom` sheet: only the top-level blocks
 * whose output differs between base and head, with their grouping at-rules around them.
 *
 * Reads bin/{base,head}-adapter of the run (one request each, in their sandbox containers).
 * Writes nothing.
 *
 * Invariants:
 * - Each side is pretty-printed by its own build. Re-printing base output with head's build would
 *   apply head's serialization and hide exactly the difference the oracle looks for.
 * - Deterministic: blocks come out in head order, then base order, capped at FOCUS_BLOCKS.
 */

import { runRequests } from '../adapter/client.js';
import { sideAdapter } from '../adapter/sandbox.js';
import { pySplit } from '../core/py.js';
import { joinItems, splitTop } from '../corpus/mutations.js';

/** @import { AdapterRequest, AdapterResponse } from '../types.js' */
/** @import { Adapter } from '../adapter/sandbox.js' */
/** @import { TopItem } from '../corpus/mutations.js' */

/** How many changed blocks a focus sheet keeps. */
const FOCUS_BLOCKS = 40;

/** At-rules that only group rules: the leaves inside them are compared, not the whole block. */
const GROUPING_AT_RULES = [
  '@layer',
  '@media',
  '@supports',
  '@container',
  '@scope',
  '@starting-style',
  '@document',
  '@-moz-document',
];

/** A pretty-printing request: no minification, no targets, error recovery on. */
const PRETTY_REQUEST = /** @type {const} */ ({
  kind: 'sheet',
  minify: false,
  compact: false,
  targets: null,
  error_recovery: true,
});

/**
 * A leaf rule of a sheet and the preludes of the grouping at-rules around it (outermost first).
 *
 * @typedef {{ context: string[], item: TopItem }} Leaf
 */

/**
 * Pretty-print base output with the base adapter and head output with the head adapter.
 *
 * @param {string} runDir
 * @param {string} baseCode
 * @param {string} headCode
 * @returns {Promise<{ base: AdapterResponse, head: AdapterResponse }>}
 */
export async function prettyPrint(runDir, baseCode, headCode) {
  const base = await prettyPrintWith(await sideAdapter(runDir, 'base'), 'base', baseCode);
  const head = await prettyPrintWith(await sideAdapter(runDir, 'head'), 'head', headCode);

  return { base, head };
}

/**
 * @param {Adapter} adapter
 * @param {string} id
 * @param {string} css
 * @returns {Promise<AdapterResponse>}
 */
async function prettyPrintWith(adapter, id, css) {
  /** @type {AdapterRequest & { id: string }} */
  const request = { id, css, ...PRETTY_REQUEST };
  const responses = await runRequests(adapter, [request], { workers: 1 });

  return responses[id];
}

/**
 * CSS made of the top-level blocks that differ between base and head output (both sides), or
 * null when the pretty-printed outputs have the same blocks.
 *
 * @param {string} runDir
 * @param {string} baseCode
 * @param {string} headCode
 * @returns {Promise<string | null>}
 */
export async function focusCss(runDir, baseCode, headCode) {
  const pretty = await prettyPrint(runDir, baseCode, headCode);
  const baseLeaves = leaves(pretty.base.code || '');
  const headLeaves = leaves(pretty.head.code || '');
  const baseKeys = new Set(baseLeaves.map(leafKey));
  const headKeys = new Set(headLeaves.map(leafKey));
  const changed = [
    ...headLeaves.filter((leaf) => !baseKeys.has(leafKey(leaf))),
    ...baseLeaves.filter((leaf) => !headKeys.has(leafKey(leaf))),
  ];

  if (changed.length === 0) {
    return null;
  }

  return changed.slice(0, FOCUS_BLOCKS).map(wrapLeaf).join('');
}

/**
 * Every leaf rule of a sheet, descending into grouping at-rules. A grouping block without leaves
 * (or one that cannot be split) counts as a leaf itself.
 *
 * @param {string} css
 * @param {string[]} [context]
 * @returns {Leaf[]}
 */
function leaves(css, context = []) {
  /** @type {Leaf[]} */
  const found = [];

  for (const item of splitTop(css) ?? []) {
    const prelude = item.prelude.toLowerCase();

    if (item.kind === 'at-block' && GROUPING_AT_RULES.some((name) => prelude.startsWith(name))) {
      const inner = leaves(item.body ?? '', [...context, item.prelude]);

      found.push(...(inner.length > 0 ? inner : [{ context, item }]));
    } else {
      found.push({ context, item });
    }
  }

  return found;
}

/**
 * Identity of a leaf: its context, kind, prelude and whitespace-normalized body.
 *
 * @param {Leaf} leaf
 * @returns {string}
 */
function leafKey({ context, item }) {
  return JSON.stringify([context, item.kind, item.prelude, pySplit(item.body ?? '').join(' ')]);
}

/**
 * The leaf as CSS, wrapped in its grouping at-rules again.
 *
 * @param {Leaf} leaf
 * @returns {string}
 */
function wrapLeaf({ context, item }) {
  let text = joinItems([item]);

  for (const prelude of context.toReversed()) {
    text = `${prelude} {\n${text}}\n`;
  }

  return text;
}
