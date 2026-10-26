/**
 * Spec data from W3C webref (`@webref/css`, installed in the analysis image).
 *
 * Stage: oracle (spec cards) and `lcr spec-coverage`.
 * - `specCards(runDir)` writes spec-cards.json: grammar, initial value, inheritance and computed
 *   value of the properties a PR touches, for the report's appendix. Reads prepare.json,
 *   corpus/cases.jsonl and corpus/deltas.jsonl; works in `<run>/spec/`.
 * - `specCoverage(tree)` writes `<cache>/spec/coverage.{md,json}`: which webref properties,
 *   at-rules, selectors and functions Lightning CSS parses at all (the "detect new CSS features"
 *   work stream). A heuristic inventory over the Rust sources, not proof of support.
 *
 * Both run oracle/spec-cards.mjs in the analysis image, offline, against the image's pinned
 * webref; the output only changes when that pin or the inputs change.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { LcrError } from '../core/errors.js';
import { iterJsonl, readJson, writeJson } from '../core/files.js';
import { log } from '../core/log.js';
import { purePath, walkTree } from '../core/pathlib.js';
import { cacheDir, SKILL_DIR } from '../core/paths.js';
import { PY_WHITESPACE, pySorted, pyTruthy } from '../core/py.js';
import { compareCodePoints, dumps } from '../core/pyjson.js';
import { ensureBrowsers, runBrowsers } from '../setup/images.js';

/** @import { Delta, PropertyEntry, Prepare, SpecCards } from '../types.js' */

/** Where the oracle directory is mounted in the analysis image. */
const MOUNT = '/opt/lcr/oracle';
const SPEC_TIMEOUT_MS = 600_000;
/** The report shows cards for at most this many properties. */
const MAX_CARD_PROPERTIES = 40;
const EM_DASH = String.fromCodePoint(0x2014);

/**
 * Run oracle/spec-cards.mjs in the analysis image with `work` mounted at /work.
 *
 * @param {string[]} args
 * @param {string} work
 * @returns {Promise<void>}
 */
async function specScript(args, work) {
  await ensureBrowsers('latest');
  await runBrowsers('latest', ['node', `${MOUNT}/spec-cards.mjs`, ...args], {
    mounts: [
      { host: join(SKILL_DIR, 'oracle'), container: MOUNT, mode: 'ro' },
      { host: work, container: '/work', mode: 'rw' },
    ],
    timeoutMs: SPEC_TIMEOUT_MS,
  });
}

/**
 * The properties a run touches, most relevant first: properties whose WPT cases changed (the PR
 * demonstrably affects them), then the properties owned by the changed handler files.
 *
 * @param {string} runDir
 * @param {number} [limit]
 * @returns {string[]}
 */
export function touchedProperties(runDir, limit = MAX_CARD_PROPERTIES) {
  const prep = /** @type {Partial<Prepare>} */ (readJson(join(runDir, 'prepare.json')) ?? {});
  const properties = /** @type {PropertyEntry[]} */ (
    readJson(join(SKILL_DIR, 'config', 'properties.json'), []) ?? []
  );
  const changed = new Set(Object.keys(prep.files ?? {}));
  // Only the WPT part of each case is needed; cases.jsonl can hold ~100k rows.
  /** @type {Map<string, { property: string } | null>} */
  const wptOf = new Map();

  for (const row of iterJsonl(join(runDir, 'corpus', 'cases.jsonl'))) {
    const corpusCase = /** @type {{ id: string, wpt?: { property: string } | null }} */ (row);

    wptOf.set(corpusCase.id, corpusCase.wpt ?? null);
  }

  /** @type {string[]} */
  const names = [];

  for (const row of iterJsonl(join(runDir, 'corpus', 'deltas.jsonl'))) {
    const wpt = wptOf.get(/** @type {Delta} */ (row).id);

    // As in Python, an empty `wpt` object names no property.
    if (wpt && pyTruthy(wpt) && !names.includes(wpt.property)) {
      names.push(wpt.property);
    }
  }

  const owned = new Set(
    properties
      .filter((entry) => entry.file !== undefined && changed.has(entry.file))
      .map((entry) => entry.name),
  );

  for (const name of [...owned].sort(compareCodePoints)) {
    if (!names.includes(name)) {
      names.push(name);
    }
  }

  return names.slice(0, limit);
}

/**
 * Write spec-cards.json for the properties a run touches. Resolves to the cards, or `{}` when
 * the run touches no property (spec-cards.json then holds an empty order).
 *
 * @param {string} runDir
 * @returns {Promise<SpecCards | Record<string, never>>}
 */
export async function specCards(runDir) {
  const names = touchedProperties(runDir);

  if (names.length === 0) {
    writeJson(join(runDir, 'spec-cards.json'), { order: [], cards: {} });

    return {};
  }

  const work = join(runDir, 'spec');

  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, 'names.json'), dumps(names));
  await specScript(['cards', '/work/names.json', '/work/cards.json'], work);

  const cards = /** @type {SpecCards['cards']} */ (readJson(join(work, 'cards.json'), {}) ?? {});
  // writeJson sorts keys; `order` keeps the priority order.
  const data = { order: names, cards };

  writeJson(join(runDir, 'spec-cards.json'), data);

  return data;
}

/** One inventory row: the webref name, whether Lightning CSS parses it, the spec link. */
/** @typedef {[name: string, implemented: boolean, href: string | null]} CoverageRow */

/**
 * @typedef {object} WebrefInventory What `spec-cards.mjs inventory` writes.
 * @property {{ name: string, href?: string, legacyAliasOf?: string }[]} properties
 * @property {{ name: string, href?: string }[]} atrules
 * @property {{ name: string, href?: string }[]} selectors
 * @property {string[]} functions
 */

/** Python's `\w` (Unicode letters, digits and `_`), for word boundaries over arbitrary source. */
const WORD = String.raw`[\p{L}\p{N}_]`;
/** `"string-literal"` contents that could be CSS keywords. */
const STRING_LITERAL = /"([a-z0-9-]+)"/g;
/** PascalCase identifiers (enum variants), between Unicode word boundaries as in Python's `\b`. */
const PASCAL_IDENT = new RegExp(String.raw`(?<!${WORD})([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)*)(?!${WORD})`, 'gu');
const SPACE = `[${RegExp.escape(PY_WHITESPACE)}]`;
/**
 * A `define_properties!` entry: `"name": …` at the start of a line. Python's `re.M` starts a line
 * only after `\n`; JS's `m` flag also after `\r`, U+2028 and U+2029, hence the lookbehind.
 */
const TABLE_ENTRY = new RegExp(String.raw`(?<=^|\n)${SPACE}*"([a-z-]+)":`, 'gu');
/** Ids special-cased outside the table, e.g. `"all" => return Ok(PropertyId::All)`. */
const SPECIAL_ID = /"([a-z-]+)" => return Ok\(PropertyId::/g;
/**
 * The colons before a selector name and the `()` after it. `$` in Python's `re.sub` also matches
 * before a final newline.
 */
const SELECTOR_DECORATION = /^:+|\(\)(?=\n?$)/g;
/** Python's universal newlines: `\r\n` and a lone `\r` read as `\n`. */
const NEWLINES = /\r\n?/g;

/**
 * A source file as Python's `read_text()` returns it (universal newlines).
 *
 * @param {string} path
 * @returns {string}
 */
function readPythonText(path) {
  return readFileSync(path, 'utf8').replace(NEWLINES, '\n');
}

/**
 * String literals plus kebab-cased PascalCase identifiers of some Rust files (enum variants such
 * as `TopLeftCorner` -> `top-left-corner`, which the derive macros parse by kebab name).
 *
 * @param {readonly string[]} paths
 * @returns {Set<string>}
 */
function sourceStrings(paths) {
  /** @type {Set<string>} */
  const strings = new Set();

  for (const path of paths) {
    const text = readPythonText(path);

    for (const match of text.matchAll(STRING_LITERAL)) {
      strings.add(match[1]);
    }

    for (const match of text.matchAll(PASCAL_IDENT)) {
      strings.add(match[1].replace(/(?<!^)(?=[A-Z])/g, '-').toLowerCase());
    }
  }

  return strings;
}

/**
 * The `*.rs` entries of `dir` (pathlib's `glob('*.rs')` / `rglob('*.rs')`: dotfiles included,
 * symlinked directories not followed).
 *
 * @param {string} dir
 * @param {{ recursive: boolean }} options
 * @returns {string[]}
 */
function rustFilesIn(dir, { recursive }) {
  const entries = recursive
    ? [...walkTree(dir)]
    : readdirSync(dir, { withFileTypes: true }).map((entry) => ({
        path: join(dir, entry.name),
        name: entry.name,
        isDirectory: entry.isDirectory(),
      }));

  return entries
    .filter((entry) => entry.name.endsWith('.rs') && !entry.isDirectory)
    .map((entry) => entry.path)
    .sort(compareCodePoints);
}

/**
 * Which properties have a typed entry in src/properties/mod.rs.
 *
 * @param {string} tree
 * @returns {Set<string>}
 */
function implementedProperties(tree) {
  const modPath = join(tree, 'src', 'properties', 'mod.rs');

  if (!existsSync(modPath)) {
    throw new LcrError(`not a Lightning CSS source tree: ${tree} (no src/properties/mod.rs)`, {
      remedy: 'pass a checkout with --tree',
    });
  }

  const mod = readPythonText(modPath);
  // Python's `mod[mod.find(…):]`: a missing marker leaves the last character, as slice(-1) does.
  const table = mod.slice(mod.indexOf('define_properties!'));
  const names = new Set([...table.matchAll(TABLE_ENTRY)].map((match) => match[1]));

  for (const match of mod.matchAll(SPECIAL_ID)) {
    names.add(match[1]);
  }

  return names;
}

/**
 * The coverage rows of each kind.
 *
 * @param {WebrefInventory} inventory
 * @param {string} tree
 * @returns {Record<'properties' | 'atrules' | 'selectors' | 'functions', CoverageRow[]>}
 */
export function coverageRows(inventory, tree) {
  const properties = implementedProperties(tree);
  const rulesDir = join(tree, 'src', 'rules');
  const parserFiles = [join(tree, 'src', 'parser.rs'), ...rustFilesIn(rulesDir, { recursive: false })];
  const parserStrings = sourceStrings(parserFiles);
  const selectorStrings = sourceStrings([
    join(tree, 'src', 'selector.rs'),
    join(tree, 'selectors', 'parser.rs'),
  ]);
  const valueStrings = sourceStrings(rustFilesIn(join(tree, 'src'), { recursive: true }));
  const href = (/** @type {{ href?: string }} */ entry) => entry.href ?? null;

  return {
    properties: inventory.properties
      .filter((entry) => !entry.legacyAliasOf)
      .map((entry) => [entry.name, properties.has(entry.name), href(entry)]),
    atrules: inventory.atrules.map((entry) => [
      entry.name,
      parserStrings.has(entry.name.replace(/^@+/, '')),
      href(entry),
    ]),
    selectors: inventory.selectors.flatMap((entry) => {
      const name = entry.name.replace(SELECTOR_DECORATION, '');

      // `$` in Python's re.match also accepts a final newline.
      if (!name || name === '*' || !/^[a-z-]+(?=\n?$)/.test(name)) {
        return [];
      }

      return [/** @type {CoverageRow} */ ([entry.name, selectorStrings.has(name), href(entry)])];
    }),
    functions: inventory.functions.map((entry) => [
      entry,
      valueStrings.has(entry.replace(/^[<>]+|[<>]+$/g, '').replace(/\(\)$/, '')),
      null,
    ]),
  };
}

/**
 * coverage.md: per kind, the counts and the missing names with their spec links.
 *
 * @param {string} tree
 * @param {Record<string, CoverageRow[]>} rows
 * @returns {string}
 */
export function coverageMarkdown(tree, rows) {
  const lines = [
    '# LightningCSS spec coverage (webref vs. parser)',
    '',
    `Tree: \`${tree}\`. A name counts as implemented when LightningCSS has a typed property entry (properties) or the name appears as a string literal or kebab-cased enum variant in the relevant parser files (others). This is a heuristic inventory, not proof of support; unparsed pass-through is not counted.`,
    '',
  ];

  for (const [kind, items] of Object.entries(rows)) {
    const missing = pySorted(
      items.filter(([, implemented]) => !implemented),
      (row) => row,
    );

    lines.push(
      `## ${kind}: ${items.length - missing.length}/${items.length} implemented, ${missing.length} missing`,
      '',
    );

    for (const [name, , link] of missing) {
      lines.push(`- \`${name}\`${link ? ` ${EM_DASH} ${link}` : ''}`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Compare webref's inventory with what a Lightning CSS tree parses; write
 * `<cache>/spec/coverage.{md,json}` and resolve to the coverage.md path.
 *
 * @param {string} tree A Lightning CSS source tree.
 * @returns {Promise<string>}
 */
export async function specCoverage(tree) {
  const work = join(cacheDir(), 'spec');

  mkdirSync(work, { recursive: true });
  await specScript(['inventory', '/work/inventory.json'], work);

  const inventory = /** @type {WebrefInventory} */ (readJson(join(work, 'inventory.json')));
  const rows = coverageRows(inventory, tree);
  const out = join(work, 'coverage.md');

  writeFileSync(out, coverageMarkdown(purePath(tree), rows));
  writeJson(
    join(work, 'coverage.json'),
    Object.fromEntries(
      Object.entries(rows).map(([kind, items]) => [
        kind,
        items.map(([name, implemented, link]) => ({ name, implemented, href: link })),
      ]),
    ),
  );

  const counts = Object.entries(rows).map(
    ([kind, items]) => `${kind} ${items.filter(([, implemented]) => implemented).length}/${items.length}`,
  );

  log(`spec coverage: ${counts.join(', ')}`);

  return out;
}
