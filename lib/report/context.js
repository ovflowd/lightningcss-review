/**
 * The evaluation context: every input of the check catalog, read once from the run directory, and
 * the recorder the checks write their rows into.
 *
 * Stage: report. Reads prepare.json (required), build.json, corpus.json, oracle.json,
 * analysis.json, corpus/cases.jsonl, corpus/deltas.jsonl and (lazily) corpus/outputs-*.jsonl.
 * A stage file that is missing or empty reads as `{}`, exactly as py-final's `read_json(...) or {}`,
 * so a check can tell "stage did not run" from its file's truthiness.
 *
 * Invariant: the context is a pure function of the run directory and the checklist loader; the
 * order every map iterates in is the order py-final's dicts iterated in (file order).
 */
import { join } from 'node:path';

import { LcrError } from '../core/errors.js';
import { readJson, readJsonl } from '../core/files.js';
import { loadConfig } from '../core/paths.js';
import { pyGet } from '../core/py-value.js';
import { pyTruthy } from '../core/py.js';
import { testAreaMap } from '../prepare/areas.js';
import { caseId, caseRefs, classified, propertyAreas, readOutputs } from './cases.js';
import { resolveAnswerMap } from './checklists.js';
import { SEV_RANK } from './constants.js';
import { ELLIPSIS } from './glyphs.js';

/**
 * @import { AdapterResponse, Analysis, Build, CheckConfig, CheckRow, CheckStatus, ChecksConfig,
 *   CorpusSummary, Delta, DeltaClassification, OracleSummary, Prepare, Severity, Side } from '../types.js'
 * @import { CaseRecord, VerdictRecord } from './cases.js'
 * @import { ChecklistItem, ResolvedAnswer } from './checklists.js'
 */

/**
 * @callback ChecklistLoader Reads the checklists of the given areas (`loadChecklists`); tests
 *   inject their own.
 * @param {readonly string[]} areas
 * @returns {ChecklistItem[]}
 */

/** @typedef {CaseRecord | Record<string, never>} CaseView A case, or `{}` for an unknown id. */

/**
 * @typedef {object} EvalContext
 * @property {string} runDir
 * @property {Prepare} prep
 * @property {Partial<Build>} build
 * @property {Partial<CorpusSummary>} corpus
 * @property {Partial<OracleSummary>} oracle
 * @property {Partial<Analysis>} analysis
 * @property {ChecksConfig} config
 * @property {number} cap How many items a check row lists before `… N more`.
 * @property {Map<string, CaseRecord>} cases corpus/cases.jsonl by id.
 * @property {Map<string, Delta>} deltas corpus/deltas.jsonl by id.
 * @property {Map<string, VerdictRecord[]>} verdicts oracle.json verdicts by case id.
 * @property {Set<string>} known Every case id the report can recognize in free text.
 * @property {Map<string, string[]>} testAreas Test function -> areas.
 * @property {Map<string, string | null>} propertyAreas Property -> area.
 * @property {ChecklistItem[]} checklist This run's checklist.
 * @property {Map<unknown, ResolvedAnswer>} answers
 * @property {CheckRecorder} checks
 * @property {(id: string) => CaseView} caseOf
 * @property {(id: string) => string} sourceOf A case's source, `''` when unknown.
 * @property {(tag: string) => DeltaClassification | null} classificationOf The classification
 *   covering the case a check item names (cached per case).
 * @property {(side: Side) => Map<string, Partial<AdapterResponse>>} outputs Read once per side.
 */

/**
 * Read every input of the evaluation.
 *
 * @param {string} runDir
 * @param {ChecklistLoader} loadChecklists
 * @returns {EvalContext}
 */
export function loadContext(runDir, loadChecklists) {
  const prep = /** @type {Prepare | null} */ (readJson(join(runDir, 'prepare.json')));

  if (!prep || !pyTruthy(prep)) {
    throw new LcrError('no prepare.json', { remedy: 'run `lcr prepare`' });
  }

  const config = /** @type {ChecksConfig} */ (loadConfig('checks.json'));
  const cases = byId(/** @type {CaseRecord[]} */ (readJsonl(join(runDir, 'corpus', 'cases.jsonl'))));
  const deltas = byId(/** @type {Delta[]} */ (readJsonl(join(runDir, 'corpus', 'deltas.jsonl'))));
  const oracle = /** @type {Partial<OracleSummary>} */ (stageFile(runDir, 'oracle.json'));
  const verdicts = new Map(Object.entries(pyGet(oracle, 'verdicts', {})));
  const analysis = /** @type {Partial<Analysis>} */ (stageFile(runDir, 'analysis.json'));
  const checklist = loadChecklists(pyGet(prep, 'areas', []));
  const caseOf = (/** @type {string} */ id) => cases.get(id) ?? /** @type {Record<string, never>} */ ({});
  const known = new Set([...cases.keys(), ...deltas.keys(), ...verdicts.keys()]);

  return {
    runDir,
    prep,
    build: /** @type {Partial<Build>} */ (stageFile(runDir, 'build.json')),
    corpus: /** @type {Partial<CorpusSummary>} */ (stageFile(runDir, 'corpus.json')),
    oracle,
    analysis,
    config,
    cap: config.thresholds.max_listed_cases,
    cases,
    deltas,
    verdicts,
    known,
    testAreas: testAreaMap(),
    propertyAreas: propertyAreas(),
    checklist,
    answers: resolveAnswerMap(analysis, checklist),
    checks: new CheckRecorder(config, rankBy(cases, known)),
    caseOf,
    sourceOf: (id) => String(pyGet(caseOf(id), 'source', '')),
    classificationOf: classificationCache(analysis, caseOf),
    outputs: outputsCache(runDir),
  };
}

/**
 * A stage file, `{}` when it is missing or empty (py-final: `read_json(path) or {}`).
 *
 * @param {string} runDir
 * @param {string} name
 * @returns {object}
 */
export function stageFile(runDir, name) {
  const value = readJson(join(runDir, name));

  return pyTruthy(value) ? /** @type {object} */ (value) : {};
}

/**
 * Rows by their `id` (a later duplicate replaces the value but keeps the first position, as a
 * Python dict comprehension does).
 *
 * @template {{ id: string }} T
 * @param {T[]} rows
 * @returns {Map<string, T>}
 */
function byId(rows) {
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * @param {Partial<Analysis>} analysis
 * @param {(id: string) => CaseView} caseOf
 * @returns {(tag: string) => DeltaClassification | null}
 */
function classificationCache(analysis, caseOf) {
  /** @type {Map<string, DeltaClassification | null>} */
  const cache = new Map();

  return (tag) => {
    const id = caseId(tag);

    if (!cache.has(id)) {
      cache.set(id, classified(analysis, id, String(pyGet(caseOf(id), 'source', ''))));
    }

    return cache.get(id) ?? null;
  };
}

/**
 * @param {string} runDir
 * @returns {(side: Side) => Map<string, Partial<AdapterResponse>>}
 */
function outputsCache(runDir) {
  /** @type {Partial<Record<Side, Map<string, Partial<AdapterResponse>>>>} */
  const cache = {};

  return (side) => (cache[side] ??= readOutputs(runDir, side));
}

/** Evidence rank by the source of the first case an item names (unknown cases last). */
const SOURCE_EVIDENCE_RANK = new Map([
  ['mutation', 3],
  ['wpt', 4],
  ['realworld', 5],
]);
const UNRANKED = 6;

/**
 * Headline order for evidence: PR tests and PR probes before curated probes, mutations, WPT and
 * real-world cases.
 *
 * @param {Map<string, CaseRecord>} cases
 * @param {ReadonlySet<string>} known
 * @returns {(item: string) => number}
 */
function rankBy(cases, known) {
  return (item) => {
    const refs = caseRefs(item, known);
    const entry = refs.length > 0 ? cases.get(refs[0]) : undefined;

    if (!entry) {
      return UNRANKED;
    }

    if (entry.source === 'tuple') {
      return 0;
    }

    if (entry.source === 'probe') {
      return entry.origin === 'pr' ? 1 : 2;
    }

    return SOURCE_EVIDENCE_RANK.get(String(entry.source)) ?? UNRANKED;
  };
}

/**
 * @typedef {object} AddOptions
 * @property {Severity | null} [severity] Overrides the catalog severity of a FAIL or PARTIAL.
 * @property {boolean} [finding] False: the row never becomes a finding of its own (A1, and checks
 *   whose cases are all classified REGRESSION and reported by that finding).
 */

/**
 * Collects the check rows. Every row lists its items in evidence-rank order, capped at
 * `max_listed_cases` with a `… N more` line; the uncapped list is kept for finding folding.
 */
export class CheckRecorder {
  /**
   * @param {ChecksConfig} config
   * @param {(item: string) => number} rank
   */
  constructor(config, rank) {
    this.config = config;
    this.rank = rank;
    this.cap = config.thresholds.max_listed_cases;
    /** @type {CheckRow[]} */
    this.rows = [];
    /** @type {Map<string, string[]>} Check id -> every item, ranked. */
    this.fullItems = new Map();
    /** @type {Set<string>} Checks that never become a finding of their own. */
    this.noFinding = new Set();
    /** @type {Map<string, string[]>} Check id -> the items still needing a classification. */
    this.open = new Map();
  }

  /**
   * Record one check row.
   *
   * @param {string} id
   * @param {CheckStatus} status
   * @param {string} [evidence]
   * @param {readonly string[]} [items]
   * @param {AddOptions} [options]
   * @returns {void}
   */
  add(id, status, evidence = '', items = [], { severity = null, finding = true } = {}) {
    const meta = this.meta(id);
    const ordered = [...items]
      .map((item, index) => ({ item, index, rank: this.rank(item) }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map(({ item }) => item);
    const shown = ordered.slice(0, this.cap);

    if (ordered.length > this.cap) {
      shown.push(`${ELLIPSIS} ${ordered.length - this.cap} more`);
    }

    this.fullItems.set(id, ordered);

    if (!finding) {
      this.noFinding.add(id);
    }

    this.rows.push({
      id,
      group: meta.group,
      title: meta.title,
      status,
      severity: rowSeverity(meta, status, severity),
      evidence,
      items: shown,
    });
  }

  /**
   * @param {string} id
   * @returns {CheckConfig}
   */
  meta(id) {
    const meta = this.config.checks.find((check) => check.id === id);

    if (!meta) {
      throw new Error(`check ${id} is not in config/checks.json`);
    }

    return meta;
  }
}

/**
 * A FAIL takes the catalog's `fail` severity (MAJOR when that is not a severity), a PARTIAL its
 * `partial` severity (NOTE by default); an explicit severity overrides both. Other statuses carry
 * none.
 *
 * @param {CheckConfig} meta
 * @param {CheckStatus} status
 * @param {Severity | null} severity
 * @returns {Severity | null}
 */
function rowSeverity(meta, status, severity) {
  if (status === 'FAIL') {
    return severity || (Object.hasOwn(SEV_RANK, meta.fail) ? /** @type {Severity} */ (meta.fail) : 'MAJOR');
  }

  if (status === 'PARTIAL') {
    return severity || pyGet(meta, 'partial', 'NOTE');
  }

  return null;
}
