/**
 * Choose the corpus cases worth running in browsers and turn them into oracle cases.
 *
 * Stage: oracle (first step). Reads corpus/cases.jsonl, corpus/deltas.jsonl,
 * corpus/outputs-{base,head}.jsonl, corpus.json, config/areas.json and the test-to-area map; for
 * very large sheets it also runs the run's adapters (see focus.js). Writes nothing; the driver writes
 * the result to oracle/cases.jsonl.
 *
 * Invariants:
 * - Deterministic priority order: PR probes, new or changed test expectations (head-side tuples),
 *   mutations, modified and removed-changed tuples, then the deltas by source (tuple, probe, WPT,
 *   real world), each group in case-id order. `--max-cases` cuts from the end of that order.
 * - Base/head symmetry: an oracle case carries both outputs; a side without output is null, and a
 *   case where neither side has output is not run.
 * - CSS-modules cases are skipped: their identifiers are renamed, so comparing computed styles
 *   against the input would be meaningless.
 */
import { join } from 'node:path';

import { iterJsonl, readJson } from '../core/files.js';
import { log } from '../core/log.js';
import { loadConfig } from '../core/paths.js';
import { pyGet, pyOr } from '../core/py-value.js';
import { pyLen, pySorted, pyStr, pyTruthy } from '../core/py.js';
import { compareCodePoints } from '../core/pyjson.js';
import { testAreaMap } from '../prepare/areas.js';
import { focusCss } from './focus.js';

/** @import { AdapterResponse, AreasConfig, CorpusSummary, OracleCase } from '../types.js' */
/** @import { AnyCase } from '../inspect/rows.js' */

/** Sheets longer than this (characters) without a DOM get a focus sheet for DOM synthesis. */
const FOCUS_MIN_CHARS = 20000;
/** DOM for WPT cases: their selectors are always `.t`. */
const WPT_DOM = '<div class="t">x</div>';
/** Attribute (`style=""`) cases are judged as a rule on one element with this id. */
const ATTR_DOM = '<div id="lcr-attr">x</div>';
/** Delta sources in selection order (after PR probes, head tests, mutations and changed tuples). */
const DELTA_SOURCES = ['tuple', 'probe', 'wpt', 'realworld'];
/** corpus.json tuple buckets that are always run. */
const TUPLE_BUCKETS = /** @type {const} */ (['modified', 'removed_changed']);

/** @typedef {[reason: string, matches: (entry: AnyCase) => boolean]} CasePriority */

// The first three priorities: whole classes of cases, each walked in id order.
/** @type {CasePriority[]} */
const CASE_PRIORITIES = [
  ['pr-probe', (entry) => entry.source === 'probe' && pyGet(entry, 'origin', null) === 'pr'],
  ['new-or-changed-test', (entry) => entry.source === 'tuple' && entry.side === 'head'],
  ['mutation', (entry) => entry.source === 'mutation'],
];

/**
 * @typedef {object} SelectionStats oracle.json `stats`.
 * @property {number} candidates
 * @property {number} selected
 * @property {number} dropped Candidates over `--max-cases`.
 * @property {Record<string, number>} by_reason
 */

/**
 * Everything selection reads, loaded once.
 *
 * @typedef {object} SelectionContext
 * @property {string} runDir
 * @property {Map<string, AnyCase>} cases
 * @property {Set<string>} deltas
 * @property {Partial<CorpusSummary>} summary
 * @property {Set<string>} visualMeta Every area config/areas.json marks visual.
 * @property {Map<string, AdapterResponse>} base
 * @property {Map<string, AdapterResponse>} head
 * @property {Map<string, string>} flagOf Case id -> the parser flag only head accepts.
 * @property {Map<string, string[]>} testAreas Test function -> areas.
 */

/**
 * The oracle cases of a run, in priority order, plus the selection statistics.
 *
 * @param {string} runDir
 * @param {number} maxCases
 * @returns {Promise<{ cases: OracleCase[], stats: SelectionStats }>}
 */
export async function selectCases(runDir, maxCases) {
  const context = loadContext(runDir);
  const { chosen, reasons } = chooseCandidates(context);
  const candidates = [...chosen.values()];
  const dropped = Math.max(0, candidates.length - maxCases);

  if (dropped) {
    log(
      `oracle: ${candidates.length} candidate cases, keeping the first ${maxCases} by priority; ` +
        `${dropped} not run (raise --max-cases to include them)`,
    );
  }

  const selected = dropped ? candidates.slice(0, maxCases) : candidates;
  /** @type {Record<string, number>} */
  const byReason = {};

  for (const entry of selected) {
    const reason = /** @type {string} */ (reasons.get(entry.id));

    byReason[reason] = (byReason[reason] ?? 0) + 1;
  }

  return {
    cases: await buildOracleCases(context, selected),
    stats: { candidates: chosen.size, selected: selected.length, dropped, by_reason: byReason },
  };
}

/**
 * @param {string} runDir
 * @returns {SelectionContext}
 */
function loadContext(runDir) {
  const corpusDir = join(runDir, 'corpus');
  const areasMeta = /** @type {AreasConfig} */ (loadConfig('areas.json')).areas;
  const summary = /** @type {Partial<CorpusSummary>} */ (pyOr(readJson(join(runDir, 'corpus.json')), {}));
  const isVisual = (/** @type {string} */ area) =>
    pyTruthy(pyGet(pyGet(areasMeta, area, {}), 'visual', null));
  /** @type {Map<string, string>} */
  const flagOf = new Map();

  for (const [flag, ids] of Object.entries(pyOr(pyGet(summary, 'flag_only', null), {}))) {
    for (const id of ids) {
      flagOf.set(id, flag);
    }
  }

  return {
    runDir,
    cases: new Map(
      iterJsonl(join(corpusDir, 'cases.jsonl')).map((row) => [
        /** @type {AnyCase} */ (row).id,
        /** @type {AnyCase} */ (row),
      ]),
    ),
    deltas: new Set(
      iterJsonl(join(corpusDir, 'deltas.jsonl')).map((row) => /** @type {{ id: string }} */ (row).id),
    ),
    summary,
    visualMeta: new Set(Object.keys(areasMeta).filter(isVisual)),
    base: outputsById(join(corpusDir, 'outputs-base.jsonl')),
    head: outputsById(join(corpusDir, 'outputs-head.jsonl')),
    flagOf,
    testAreas: testAreaMap(),
  };
}

/**
 * One side's adapter outputs by case id.
 *
 * @param {string} path
 * @returns {Map<string, AdapterResponse>}
 */
export function outputsById(path) {
  return new Map(
    iterJsonl(path).map((row) => [
      /** @type {AdapterResponse} */ (row).id,
      /** @type {AdapterResponse} */ (row),
    ]),
  );
}

/**
 * The candidate cases in priority order, each with the reason it was chosen.
 *
 * @param {SelectionContext} context
 * @returns {{ chosen: Map<string, AnyCase>, reasons: Map<string, string> }}
 */
function chooseCandidates({ cases, deltas, summary }) {
  /** @type {Map<string, AnyCase>} */
  const chosen = new Map();
  /** @type {Map<string, string>} */
  const reasons = new Map();
  const want = (/** @type {string} */ id, /** @type {string} */ reason) => {
    const entry = cases.get(id);

    if (entry && !chosen.has(id)) {
      chosen.set(id, entry);
      reasons.set(id, reason);
    }
  };
  const byId = pySorted(cases.values(), (entry) => entry.id);
  const sortedDeltas = [...deltas].sort(compareCodePoints);

  for (const [reason, matches] of CASE_PRIORITIES) {
    for (const entry of byId.filter(matches)) {
      want(entry.id, reason);
    }
  }

  const tuples = /** @type {Partial<CorpusSummary['tuples']>} */ (pyGet(summary, 'tuples', {}));

  for (const bucket of TUPLE_BUCKETS) {
    for (const entry of pyGet(tuples, bucket, [])) {
      want(entry.id, `tuple-${bucket}`);
    }
  }

  for (const source of DELTA_SOURCES) {
    for (const id of sortedDeltas) {
      if (pyGet(cases.get(id) ?? {}, 'source', null) === source) {
        want(id, `${source}-delta`);
      }
    }
  }

  return { chosen, reasons };
}

/**
 * The oracle cases for the selected corpus cases (some are skipped, see the module header).
 *
 * @param {SelectionContext} context
 * @param {readonly AnyCase[]} selected
 * @returns {Promise<OracleCase[]>}
 */
async function buildOracleCases(context, selected) {
  /** @type {OracleCase[]} */
  const oracleCases = [];
  // py-final quirk, kept for identical oracle/cases.jsonl: `domFrom` is only computed for plain
  // sheet cases, and an attribute case reuses the value of the sheet case before it (null when
  // none came first; py-final crashed with an UnboundLocalError there). Attribute cases carry their
  // own DOM, so the carried value only sets the job's `dom.focused` flag in prepare-jobs.mjs.
  /** @type {string | null} */
  let domFrom = null;

  for (const entry of selected) {
    const outputs = { base: context.base.get(entry.id) ?? null, head: context.head.get(entry.id) ?? null };
    const kind = pyGet(entry.request, 'kind', null);

    if (kind === 'value' || kind === 'property') {
      oracleCases.push(kind === 'value' ? valueCase(entry, outputs) : propertyCase(entry, outputs));
      continue;
    }

    if (kind !== 'attr' && pyGet(entry.request, 'css_modules', null) !== null) {
      continue;
    }

    const input = kind === 'attr' ? attrInput(entry, outputs) : sheetInput(context, entry, outputs);

    if (kind !== 'attr') {
      domFrom = await focusSheet(context.runDir, entry, input);
    }

    if (input.sheets.base !== null || input.sheets.head !== null) {
      oracleCases.push(sheetCase(context, entry, { ...input, domFrom }));
    }
  }

  return oracleCases;
}

/**
 * Both sides' adapter output for one case (null when a side has none).
 *
 * @typedef {{ base: AdapterResponse | null, head: AdapterResponse | null }} SideOutputs
 */

/**
 * A side's output code, or null when that side failed (or has no output).
 *
 * @param {AdapterResponse | null} output
 * @returns {string | null}
 */
function okCode(output) {
  return output && pyTruthy(output.ok) ? pyGet(output, 'code', null) : null;
}

/**
 * `property_range_test` cases: judged as a declaration with the CSSOM property check. A typed
 * value is shown as the adapter printed it, any other accepted value as written.
 *
 * @param {AnyCase} entry
 * @param {SideOutputs} outputs
 * @returns {OracleCase}
 */
function valueCase(entry, { base, head }) {
  const request = entry.request;
  const expectation = /** @type {{ type?: string }} */ (pyOr(pyGet(entry, 'expectation', null), {}));
  const declaration = (/** @type {AdapterResponse | null} */ output) => {
    if (!output || !pyTruthy(output.ok)) {
      return null;
    }

    const value = pyGet(output, 'recognition', null) === 'typed' ? output.code : request.value;

    return `${pyStr(request.property)}: ${pyStr(value)}`;
  };

  return {
    id: entry.id,
    kind: 'property',
    property: /** @type {string} */ (request.property),
    value: /** @type {string} */ (request.value),
    wptKind: pyGet(expectation, 'type', null) === 'value-unparsed' ? 'invalid' : 'valid',
    expected: null,
    outputs: { base: declaration(base), head: declaration(head) },
    targets: null,
  };
}

/**
 * WPT property cases: the property value each side printed, checked against WPT's expectation.
 *
 * @param {AnyCase} entry
 * @param {SideOutputs} outputs
 * @returns {OracleCase}
 */
function propertyCase(entry, { base, head }) {
  const request = entry.request;
  const wpt = /** @type {{ kind?: string, expected?: unknown }} */ (pyGet(entry, 'wpt', {}));

  return {
    id: entry.id,
    kind: 'property',
    property: /** @type {string} */ (request.property),
    value: /** @type {string} */ (request.value),
    wptKind: pyGet(wpt, 'kind', 'valid'),
    expected: pyGet(wpt, 'expected', null),
    outputs: { base: okCode(base), head: okCode(head) },
    targets: pyGet(request, 'targets', null),
  };
}

/**
 * @typedef {object} SheetInput
 * @property {{ input: string | null, base: string | null, head: string | null }} sheets
 * @property {string | null} dom DOM override; null lets prepare-jobs synthesize one.
 */

/**
 * Attribute cases (`style=""` content): each sheet becomes a rule on one element.
 *
 * @param {AnyCase} entry
 * @param {SideOutputs} outputs
 * @returns {SheetInput}
 */
function attrInput(entry, { base, head }) {
  const wrap = (/** @type {string | null} */ css) => (css === null ? null : `#lcr-attr{${css}}`);

  return {
    sheets: {
      input: wrap(pyGet(entry.request, 'css', null)),
      base: wrap(okCode(base)),
      head: wrap(okCode(head)),
    },
    dom: ATTR_DOM,
  };
}

/**
 * Sheet cases: the input and both outputs; the DOM from the case, its probe or its parent probe.
 *
 * @param {SelectionContext} context
 * @param {AnyCase} entry
 * @param {SideOutputs} outputs
 * @returns {SheetInput}
 */
function sheetInput(context, entry, { base, head }) {
  const sheets = { input: /** @type {string} */ (entry.request.css), base: okCode(base), head: okCode(head) };

  if (entry.source === 'wpt') {
    return { sheets, dom: WPT_DOM };
  }

  const parent = context.cases.get(/** @type {string} */ (entry.parent));
  const parentProbe = pyOr(pyGet(parent ?? {}, 'probe', null), {});
  const dom = pyOr(
    pyGet(entry, 'dom', null),
    pyOr(pyGet(pyOr(pyGet(entry, 'probe', null), {}), 'dom', null), pyGet(parentProbe, 'dom', null)),
  );

  return { sheets, dom };
}

/**
 * A focus sheet (focus.js) for a large sheet case without a DOM whose sides both have output.
 *
 * @param {string} runDir
 * @param {AnyCase} entry
 * @param {SheetInput} input
 * @returns {Promise<string | null>}
 */
async function focusSheet(runDir, entry, { sheets, dom }) {
  if (
    pyTruthy(dom) ||
    !sheets.base ||
    !sheets.head ||
    pyLen(/** @type {string} */ (entry.request.css)) <= FOCUS_MIN_CHARS
  ) {
    return null;
  }

  return focusCss(runDir, sheets.base, sheets.head);
}

/**
 * The oracle case of a sheet or attribute case.
 *
 * @param {SelectionContext} context
 * @param {AnyCase} entry
 * @param {SheetInput & { domFrom: string | null }} input The sheets, the DOM and the focus sheet.
 * @returns {OracleCase}
 */
function sheetCase(context, entry, { sheets, dom, domFrom }) {
  const { area, visualTest } = caseArea(context, entry);
  // Real-world sheets are never compared visually: their screenshots differ for reasons unrelated
  // to the change (fonts, images, page size). py-final also tested the PR's own visual areas,
  // which are a subset of the visual areas tested here.
  const visual =
    (visualTest || (area !== null && context.visualMeta.has(area))) && entry.source !== 'realworld';
  const flag = context.flagOf.get(entry.id);

  return {
    id: entry.id,
    kind: 'sheet',
    sheets,
    targets: pyGet(entry.request, 'targets', null),
    dom,
    domFrom,
    visual,
    ...(flag === undefined ? {} : { introduced: true, flagOnly: flag }),
  };
}

/**
 * The case's area, and whether the test that recorded it (or its parent's test) belongs to a
 * visual area; such a test makes the case visual even when the case names no area.
 *
 * @param {SelectionContext} context
 * @param {AnyCase} entry
 * @returns {{ area: string | null, visualTest: boolean }}
 */
function caseArea(context, entry) {
  const area = pyOr(pyGet(entry, 'area', null), pyGet(pyOr(pyGet(entry, 'probe', null), {}), 'area', null));
  const parent = /** @type {Partial<AnyCase>} */ (
    pyOr(context.cases.get(/** @type {string} */ (entry.parent)) ?? {}, {})
  );
  const testName = pyOr(pyGet(entry, 'test', null), pyGet(parent, 'test', null));
  const testAreas = new Set(
    testName ? (context.testAreas.get(/** @type {string} */ (testName.split('::').at(-1))) ?? []) : [],
  );

  if (testAreas.intersection(context.visualMeta).size === 0) {
    return { area, visualTest: false };
  }

  return { area: pyOr(area, [...testAreas].sort(compareCodePoints)[0]), visualTest: true };
}
