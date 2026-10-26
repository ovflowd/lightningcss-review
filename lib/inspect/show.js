/**
 * `lcr show <run> <case>`: everything about one case on one screen: its corpus entry, the request,
 * the input, base and head output, and the per-engine oracle diffs.
 *
 * Stage: inspect (read-only). Reads corpus/cases.jsonl, corpus/outputs-{base,head}.jsonl,
 * oracle/verdicts.jsonl (falling back to oracle.json) and, for large outputs, runs the run's own
 * adapters (bin/{base,head}-adapter) to pretty-print both sides. Writes nothing.
 *
 * The text layout is a fixed format, byte for byte (the reviewing agent and the docs quote it), and
 * the run files are read line by line so the command stays fast on large runs. `--json` prints
 * the raw rows instead, untruncated.
 */
import { join } from 'node:path';

import { unifiedDiff } from '../core/difflib.js';
import { LcrError } from '../core/errors.js';
import { iterJsonl, readJson } from '../core/files.js';
import { print } from '../core/log.js';
import { pyGet, pyOr } from '../core/py-value.js';
import { pyFormat, pyLen, pySlice, pySorted, pySplitlines, pyStr, pyTruthy } from '../core/py.js';
import { compareCodePoints, dumps, jsonLineText } from '../core/pyjson.js';
import { prettyPrint } from '../oracle-driver/focus.js';
import { abbreviateEngines, findRows } from './rows.js';

/** @import { AdapterResponse, CaseVerdict, EngineEntry, EngineVariant, ProfileSummary } from '../types.js' */
/** @import { AnyCase } from './rows.js' */

/** Characters of input or output printed before `lcr show` switches to a summary or a diff. */
const TEXT_LIMIT = 3000;
/** Unified-diff context lines and the diff lines printed for large outputs. */
const DIFF_CONTEXT = 2;
const DIFF_LINES_SHOWN = 220;
/** Engine blocks: rejected items per kind, their length, and the error text length. */
const REJECTED_SHOWN = 6;
const REJECTED_CHARS = 200;
const ERROR_CHARS = 300;
/** Engine blocks: property-diff rows and the width of each column (the last one is wider). */
const DIFF_ROWS_SHOWN = 40;
const CELL_CHARS = 40;
const LAST_CELL_CHARS = 80;
const DIFF_HEADER = /** @type {const} */ (['element', 'property', 'input', 'base', 'head']);
/** Keys of a case worth showing above the request, in the order the fixed layout prints them. */
const CASE_META_KEYS = [
  'source',
  'side',
  'origin',
  'parent',
  'mutation',
  'helper',
  'test',
  'line',
  'in_diff',
  'mode',
  'name',
  'area',
  'expectation',
  'dom',
];
const SIDES = /** @type {const} */ (['base', 'head']);
const ELLIPSIS = String.fromCodePoint(0x2026);

/**
 * (element, property, input, base, head) for every property one side computes differently from
 * the input; `=` means that side matches the input.
 *
 * @typedef {[string, string, string, string, string]} DiffRow
 */

/**
 * Print one case (or, with `json`, every row about it as JSON).
 *
 * @param {string} runDir
 * @param {string} caseId An id or an id prefix (the smallest matching id wins).
 * @param {{ json?: boolean }} [options]
 * @returns {Promise<void>}
 */
export async function show(runDir, caseId, { json = false } = {}) {
  const entry = resolveCase(runDir, caseId);
  const id = entry.id;
  const base = outputRow(runDir, 'base', id);
  const head = outputRow(runDir, 'head', id);
  const verdicts = caseVerdicts(runDir, id);

  if (json) {
    print(
      dumps({ case: entry, base, head, oracle: verdicts }, { indent: 2, sortKeys: true, ensureAscii: false }),
    );

    return;
  }

  print(`== ${id} (${pyStr(entry.source)})`);
  print(jsonLineText(caseMeta(entry)));

  const { css: _css, ...options } = entry.request;

  print(`== request options: ${jsonLineText(options)}`);
  print(`== input:\n${inputText(entry)}`);
  await printOutputs(runDir, base, head);
  printVerdicts(verdicts);
}

/**
 * The case with this exact id, else the smallest id starting with it.
 *
 * @param {string} runDir
 * @param {string} caseId
 * @returns {AnyCase}
 */
export function resolveCase(runDir, caseId) {
  const path = join(runDir, 'corpus', 'cases.jsonl');
  const [exact] = /** @type {AnyCase[]} */ (findRows(path, 'id', caseId));

  if (exact) {
    return exact;
  }

  /** @type {AnyCase | null} */
  let first = null;

  for (const row of iterJsonl(path)) {
    const entry = /** @type {AnyCase} */ (row);

    if (entry.id.startsWith(caseId) && (first === null || compareCodePoints(entry.id, first.id) < 0)) {
      first = entry;
    }
  }

  if (first === null) {
    throw new LcrError(`no case ${caseId}`, { remedy: 'list the case ids with `lcr table <run>`' });
  }

  return first;
}

/**
 * One side's adapter output for a case, `{}` when it has none.
 *
 * @param {string} runDir
 * @param {'base' | 'head'} side
 * @param {string} caseId
 * @returns {Partial<AdapterResponse>}
 */
function outputRow(runDir, side, caseId) {
  const [row] = findRows(join(runDir, 'corpus', `outputs-${side}.jsonl`), 'id', caseId);

  return /** @type {Partial<AdapterResponse>} */ (row ?? {});
}

/**
 * A case's oracle verdicts (light first, then dark), from verdicts.jsonl or else oracle.json.
 *
 * @param {string} runDir
 * @param {string} caseId
 * @returns {CaseVerdict[]}
 */
export function caseVerdicts(runDir, caseId) {
  const rows = /** @type {CaseVerdict[]} */ (
    findRows(join(runDir, 'oracle', 'verdicts.jsonl'), 'case', caseId)
  );

  if (rows.length > 0) {
    return pySorted(rows, (verdict) => pyOr(pyGet(verdict, 'scheme', null), ''));
  }

  const oracle = /** @type {{ verdicts?: Record<string, CaseVerdict[]> } | null} */ (
    readJson(join(runDir, 'oracle.json'))
  );

  return pyGet(pyGet(pyOr(oracle, {}), 'verdicts', {}), caseId, []);
}

/**
 * The corpus fields shown above the request; empty probe fields are left out.
 *
 * @param {AnyCase} entry
 * @returns {Record<string, unknown>}
 */
export function caseMeta(entry) {
  /** @type {Record<string, unknown>} */
  const meta = {};
  const fields = /** @type {Record<string, unknown>} */ (entry);

  for (const key of CASE_META_KEYS) {
    if (Object.hasOwn(fields, key)) {
      meta[key] = fields[key];
    }
  }

  if (entry.probe && pyTruthy(entry.probe)) {
    meta.probe = Object.fromEntries(Object.entries(entry.probe).filter(([, value]) => !isEmptyField(value)));
  }

  if (pyTruthy(entry.wpt)) {
    meta.wpt = entry.wpt;
  }

  return meta;
}

/**
 * Probe fields equal to `None`, `[]` or `""` say nothing, so the header leaves them out.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isEmptyField(value) {
  return value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

/**
 * The case's input (CSS, or `property: value`), cut at TEXT_LIMIT characters.
 *
 * @param {AnyCase} entry
 * @returns {string}
 */
function inputText(entry) {
  const request = entry.request;
  const source = pyOr(
    pyGet(request, 'css', null),
    `${pyStr(pyGet(request, 'property', null))}: ${pyStr(pyGet(request, 'value', null))}`,
  );
  const length = pyLen(source);

  if (length <= TEXT_LIMIT) {
    return source;
  }

  return `${pySlice(source, 0, TEXT_LIMIT)}\n${ELLIPSIS} (${length} bytes total; \`lcr show --json\` prints everything)`;
}

/**
 * Base and head output: both in full, or for large outputs a bounded diff of the two.
 *
 * @param {string} runDir
 * @param {Partial<AdapterResponse>} base
 * @param {Partial<AdapterResponse>} head
 * @returns {Promise<void>}
 */
async function printOutputs(runDir, base, head) {
  const large = (/** @type {Partial<AdapterResponse>} */ row) =>
    pyLen(pyOr(pyGet(row, 'code', null), '')) > TEXT_LIMIT;

  if ((large(base) || large(head)) && pyTruthy(base.ok) && pyTruthy(head.ok)) {
    await printOutputDiff(runDir, /** @type {string} */ (base.code), /** @type {string} */ (head.code));

    return;
  }

  for (const [name, row] of /** @type {const} */ ([
    ['base', base],
    ['head', head],
  ])) {
    const ok = pyTruthy(row.ok);

    print(`== ${name}: ${ok ? 'ok' : `${pyStr(pyGet(row, 'stage', null))} error`}`);
    print(pyStr(ok ? pyGet(row, 'code', null) : pyGet(row, 'error', null)));
  }
}

/**
 * Large outputs (real-world sheets): a unified diff of both outputs, each side pretty-printed by
 * its own build, because re-printing base output with head's build would apply head's
 * serialization and hide exactly the difference under review.
 *
 * @param {string} runDir
 * @param {string} baseCode
 * @param {string} headCode
 * @returns {Promise<void>}
 */
async function printOutputDiff(runDir, baseCode, headCode) {
  const pretty = await prettyPrint(runDir, baseCode, headCode);
  const before = pySplitlines(pyOr(pyGet(pretty.base, 'code', null), baseCode));
  const after = pySplitlines(pyOr(pyGet(pretty.head, 'code', null), headCode));
  const diff = unifiedDiff(before, after, {
    fromfile: 'base',
    tofile: 'head',
    context: DIFF_CONTEXT,
    lineterm: '',
  });

  print(
    `== base ${pyLen(baseCode)} bytes, head ${pyLen(headCode)} bytes; diff of pretty-printed outputs, ` +
      `each side printed by its own build (${diff.length} lines, first ${DIFF_LINES_SHOWN}):`,
  );
  print(diff.slice(0, DIFF_LINES_SHOWN).join('\n'));
}

/**
 * Every verdict: the latest-profile summary and engine blocks, then each legacy profile's.
 *
 * @param {readonly CaseVerdict[]} verdicts
 * @returns {void}
 */
function printVerdicts(verdicts) {
  for (const verdict of verdicts) {
    const summary = verdict.summary ?? {};

    print(
      `== oracle (${pyStr(pyGet(verdict, 'scheme', null))}) latest: ${summaryLine(summary.latest ?? {})}`,
    );

    for (const [engine, entry] of sortedEntries(verdict.latest ?? {})) {
      print(engineBlock(engine, entry).join('\n'));
    }

    for (const [profile, engines] of sortedEntries(verdict.legacy ?? {})) {
      const legacy = /** @type {Record<string, ProfileSummary>} */ (summary.legacy ?? {});

      print(`-- ${profile}: ${summaryLine(pyOr(pyGet(legacy, profile, null), {}))}`);

      for (const [engine, entry] of sortedEntries(engines)) {
        print(engineBlock(engine, entry).join('\n'));
      }
    }
  }
}

/**
 * @template T
 * @param {Partial<Record<string, T>>} mapping
 * @returns {[string, T][]}
 */
function sortedEntries(mapping) {
  return /** @type {[string, T][]} */ (Object.entries(mapping)).sort(([a], [b]) => compareCodePoints(a, b));
}

/**
 * One profile's summary of a case in one line: transition, statuses, bad engines, rejections.
 *
 * @param {Partial<ProfileSummary>} summary
 * @returns {string}
 */
export function summaryLine(summary) {
  const bad = (/** @type {'enginesBase' | 'enginesHead'} */ side) =>
    abbreviateEngines(pySorted(pyGet(summary[side] ?? {}, 'bad', [])));
  const divergent = pyTruthy(summary.divergent) ? '; divergent' : '';

  return (
    `${pyStr(pyGet(summary, 'transition', null))} (base ${pyStr(pyGet(summary, 'base', null))}, ` +
    `head ${pyStr(pyGet(summary, 'head', null))}; bad engines base ${bad('enginesBase')} head ${bad('enginesHead')}` +
    `${divergent}; rejected base ${pyStr(pyGet(summary, 'rejectedBase', 0))} head ${pyStr(pyGet(summary, 'rejectedHead', 0))})`
  );
}

/**
 * One engine's lines: status per side, rejected items, then the property diffs as a table.
 *
 * @param {string} name
 * @param {EngineEntry} entry
 * @returns {string[]}
 */
export function engineBlock(name, entry) {
  const label = `  ${name} ${pyStr(pyGet(entry, 'version', ''))}`;

  if (pyTruthy(entry.skipped)) {
    return [`${label}: skipped (${pyStr(entry.skipped)})`];
  }

  if (pyTruthy(entry.error)) {
    return [`${label}: error ${pySlice(pyStr(entry.error), 0, ERROR_CHARS)}`];
  }

  const variants = pyOr(pyGet(entry, 'variants', null), {});
  const base = /** @type {Partial<EngineVariant>} */ (pyOr(pyGet(variants, 'base', null), {}));
  const head = /** @type {Partial<EngineVariant>} */ (pyOr(pyGet(variants, 'head', null), {}));
  const lines = [
    `${label}: base ${pyStr(pyGet(base, 'status', '-'))}, head ${pyStr(pyGet(head, 'status', '-'))}; ` +
      `touched ${pyStr(pyGet(entry, 'touched', '-'))}; rejected base ${rejectedCount(base)} head ${rejectedCount(head)}`,
  ];

  for (const [side, variant] of /** @type {const} */ ([
    ['base', base],
    ['head', head],
  ])) {
    lines.push(...rejectedLines(side, variant));
  }

  lines.push(...diffTable(diffRows(variants)));

  return lines;
}

/**
 * How many declarations, selectors and preludes an engine dropped from one side's sheet.
 *
 * @param {Partial<EngineVariant>} variant
 * @returns {number}
 */
function rejectedCount(variant) {
  const rejected = /** @type {Record<string, unknown>} */ (pyOr(pyGet(variant, 'rejected', null), {}));

  return Object.values(rejected).reduce((/** @type {number} */ total, items) => total + pyLength(items), 0);
}

/**
 * Python's `len()` of a JSON value (list, string or object).
 *
 * @param {unknown} value
 * @returns {number}
 */
function pyLength(value) {
  if (typeof value === 'string') {
    return pyLen(value);
  }

  return Array.isArray(value) ? value.length : Object.keys(/** @type {object} */ (value)).length;
}

/**
 * @param {'base' | 'head'} side
 * @param {Partial<EngineVariant>} variant
 * @returns {string[]}
 */
function rejectedLines(side, variant) {
  const lines = [];
  const rejected = /** @type {Record<string, unknown[]>} */ (pyOr(pyGet(variant, 'rejected', null), {}));

  for (const [kind, items] of sortedEntries(rejected)) {
    for (const item of items.slice(0, REJECTED_SHOWN)) {
      lines.push(`    rejected on ${side} (${kind}): ${pySlice(pyStr(item), 0, REJECTED_CHARS)}`);
    }
  }

  return lines;
}

/**
 * The property diffs of both variants, merged by (element, property) and sorted.
 *
 * @param {Partial<Record<'base' | 'head', Partial<EngineVariant> | null>>} variants
 * @returns {DiffRow[]}
 */
export function diffRows(variants) {
  /** @type {Map<string, { key: string, prop: string, ref: unknown, sides: Map<string, unknown> }>} */
  const merged = new Map();

  for (const side of SIDES) {
    const variant = /** @type {Partial<EngineVariant>} */ (pyOr(pyGet(variants, side, null), {}));

    for (const diff of pyGet(variant, 'diffs', [])) {
      const key = pyGet(diff, 'key', '');
      const prop = pyGet(diff, 'prop', '');
      const mapKey = JSON.stringify([key, prop]);
      const row = merged.get(mapKey) ?? { key, prop, ref: pyGet(diff, 'ref', null), sides: new Map() };

      merged.set(mapKey, row);
      row.sides.set(side, pyGet(diff, 'val', null));
    }
  }

  const sorted = pySorted(merged.values(), (row) => [row.key, row.prop]);

  return sorted.map(({ key, prop, ref, sides }) => [
    key,
    prop,
    pyStr(ref),
    sides.has('base') ? pyStr(sides.get('base')) : '=',
    sides.has('head') ? pyStr(sides.get('head')) : '=',
  ]);
}

/**
 * The diff rows as an aligned table (columns capped at CELL_CHARS), at most DIFF_ROWS_SHOWN rows.
 *
 * @param {readonly DiffRow[]} rows
 * @returns {string[]}
 */
function diffTable(rows) {
  if (rows.length === 0) {
    return [];
  }

  const all = [DIFF_HEADER, ...rows];
  const widths = [0, 1, 2, 3].map((column) =>
    Math.min(
      CELL_CHARS,
      all.reduce((widest, row) => Math.max(widest, pyLen(row[column])), 0),
    ),
  );
  const lines = [DIFF_HEADER, ...rows.slice(0, DIFF_ROWS_SHOWN)].map((row) => {
    const cells = row
      .slice(0, 4)
      .map((cell, column) => pyFormat(pySlice(cell, 0, CELL_CHARS), `<${widths[column]}`));

    return `    ${cells.join('  ')}  ${pySlice(row[4], 0, LAST_CELL_CHARS)}`;
  });

  if (rows.length > DIFF_ROWS_SHOWN) {
    lines.push(`    ${ELLIPSIS} ${rows.length - DIFF_ROWS_SHOWN} more`);
  }

  return lines;
}
