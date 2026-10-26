/**
 * Blast radius: which files (and so which areas) reference the items a change touches.
 *
 * Stage: prepare (prepare.json `blast_radius`, `radius_areas`). A changed `fn`, `struct` or
 * `impl` is looked up with `git grep -w` in the head tree; the areas of the referencing files are
 * areas the change can reach without touching them.
 *
 * Invariants: names that every module uses (`parse`, `to_css`, …) are skipped, so the radius
 * stays meaningful; the generated src/compat.rs is scoped to the users of its changed `Feature`
 * variants instead of every `is_compatible` caller. Output is sorted throughout.
 */
import { universalNewlines } from '../core/files.js';
import { git } from '../core/git.js';
import { compareCodePoints, pyLen, pySplit, pySplitlines } from '../core/py.js';
import { classifyFiles } from './areas.js';

/** @import { ChangedItem } from '../types.js' */

/** Item names too common to say anything about who depends on a change. */
export const GENERIC_NAMES = new Set([
  'parse',
  'to_css',
  'new',
  'default',
  'from',
  'into',
  'minify',
  'clone',
  'eq',
  'fmt',
  'visit',
  'is_compatible',
  'get_fallbacks',
  'handle_property',
  'finalize',
  'parse_string',
  'to_css_string',
  'into_owned',
  'hash',
  'len',
  'is_empty',
  'iter',
  'next',
  'write',
  'flush',
  'deref',
  'as_ref',
  'parse_with_options',
  'add_prefix',
  'set_prefixes_for_targets',
  'get_necessary_prefixes',
  'test',
  'main',
  'run',
  'value',
  'name',
  'inner',
  'Self',
  'T',
]);

/** Where library code lives (tests and generated bindings are not users). */
const GREP_PATHS = ['src', 'selectors', 'node/src', 'napi/src', 'c/src'];
/** Names this short match too much to be useful. */
const MIN_NAME_LENGTH = 3;

/**
 * Files of the head tree that mention `needle` as a whole word, minus `exclude`.
 *
 * @param {string} headTree
 * @param {string} needle
 * @param {{ exclude?: readonly string[] }} [options]
 * @returns {Promise<string[]>} Sorted, unique.
 */
export async function grepUsers(headTree, needle, { exclude = [] } = {}) {
  const output = await git(['grep', '-n', '-w', '--fixed-strings', needle, headTree, '--', ...GREP_PATHS], {
    check: false,
  });
  /** @type {Set<string>} */
  const hits = new Set();

  // Each hit is `<tree>:<path>:<line>:<text>`.
  for (const line of pySplitlines(universalNewlines(output))) {
    const parts = pySplit(line, ':', 3);

    if (parts.length >= 3 && !exclude.includes(parts[1])) {
      hits.add(parts[1]);
    }
  }

  return [...hits].sort(compareCodePoints);
}

/**
 * @typedef {object} RadiusEntry prepare.json `blast_radius[]`.
 * @property {string} name The item name or `Feature::<variant>`.
 * @property {string[]} files
 * @property {string[]} areas
 */

/**
 * @typedef {(headTree: string, needle: string, options?: { exclude?: readonly string[] }) => Promise<string[]>} GrepUsers
 */

/**
 * @typedef {object} RadiusOptions
 * @property {readonly string[]} [variants] Sorted `Feature` variants of src/compat.rs that changed.
 * @property {GrepUsers} [grep] Replaces `git grep` (tests).
 */

/**
 * Files and areas that reference the changed items and the changed `Feature` variants.
 *
 * @param {string} headTree
 * @param {Pick<ChangedItem, 'file' | 'item' | 'impl'>[]} items
 * @param {RadiusOptions} [options]
 * @returns {Promise<RadiusEntry[]>}
 */
export async function blastRadius(headTree, items, { variants = [], grep = grepUsers } = {}) {
  /** @type {[string, string[]][]} */
  const needles = [
    ...[...radiusNames(items)]
      .sort(compareCodePoints)
      .map((name) => /** @type {[string, string[]]} */ ([name, []])),
    ...variants.map(
      (variant) => /** @type {[string, string[]]} */ ([`Feature::${variant}`, ['src/compat.rs']]),
    ),
  ];
  /** @type {RadiusEntry[]} */
  const radius = [];

  for (const [name, exclude] of needles) {
    const files = await grep(headTree, name, { exclude });
    const areas = new Set(files.flatMap((file) => classifyFiles([file]).get(file) ?? []));

    radius.push({ name, files, areas: [...areas].sort(compareCodePoints) });
  }

  return radius;
}

/**
 * The distinctive names of the changed items (the item's name, else its impl's type).
 *
 * @param {Pick<ChangedItem, 'file' | 'item' | 'impl'>[]} items
 * @returns {Set<string>}
 */
function radiusNames(items) {
  /** @type {Set<string>} */
  const names = new Set();

  for (const entry of items) {
    if (entry.file === 'src/compat.rs') {
      continue;
    }

    for (const found of [entry.item, entry.impl]) {
      const name = found ? nameOf(found) : null;

      if (name && !GENERIC_NAMES.has(name) && pyLen(name) >= MIN_NAME_LENGTH) {
        names.add(name);
      }
    }
  }

  return names;
}

/**
 * An item's name, or an impl's type.
 *
 * @param {object} found
 * @returns {string | null}
 */
function nameOf(found) {
  const record = /** @type {{ name?: string | null, type?: string | null }} */ (found);

  return record.name || record.type || null;
}
