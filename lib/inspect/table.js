/**
 * `lcr table <run>`: one line per oracle case (transition, base/head status, bad engines,
 * divergence, rejections, legacy transitions), or before the oracle has run, one line per corpus
 * case with its base/head outputs.
 *
 * Stage: inspect (read-only). Reads oracle.json, report.json (`--check`), and before the oracle
 * corpus/cases.jsonl, deltas.jsonl and outputs-{base,head}.jsonl. Writes nothing.
 *
 * Rows are sorted by case id, then scheme, so the table is the same on every machine; `--json`
 * prints the same rows as JSON (py-final's keys).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { LcrError } from '../core/errors.js';
import { iterJsonl, readJson } from '../core/files.js';
import { print } from '../core/log.js';
import { pyGet, pyOr } from '../core/py-value.js';
import { fnmatchcase, pyFormat, pyLen, pySorted, pySplit, pyStr, pyTruthy } from '../core/py.js';
import { compareCodePoints, dumps } from '../core/pyjson.js';
import { abbreviateEngines } from './rows.js';

/** @import { CaseVerdict, ProfileSummary, ReportFile } from '../types.js' */
/** @import { AnyCase } from './rows.js' */

const NO_ROWS = 'no matching cases';

/**
 * @typedef {object} TableOptions
 * @property {string | null} [transition] Comma/space-separated transitions to keep.
 * @property {string | null} [check] Only the cases a report check lists (needs report.json).
 * @property {string | null} [pattern] Only case ids matching this glob.
 * @property {boolean} [json]
 */

/**
 * One oracle verdict as a table row (`lcr table --json` prints these).
 *
 * @typedef {object} VerdictRow
 * @property {string} id
 * @property {string | null} scheme
 * @property {string | null} transition
 * @property {string | null} base
 * @property {string | null} head
 * @property {string[]} bad_base
 * @property {string[]} bad_head
 * @property {boolean} divergent
 * @property {Record<string, string | null>} legacy Profile -> transition, sorted by profile.
 * @property {[number, number]} rejected Rejected items on base and head.
 */

/**
 * One corpus case as a table row before the oracle ran.
 *
 * @typedef {object} OutputRow
 * @property {string} id
 * @property {string | null} source
 * @property {string | null} area
 * @property {boolean | null} base_ok Null when the side has no output for the case.
 * @property {boolean | null} head_ok
 * @property {boolean} changed Base and head behave differently.
 */

/**
 * Print the table of a run.
 *
 * @param {string} runDir
 * @param {TableOptions} [options]
 * @returns {Promise<void>}
 */
export async function table(runDir, { transition = null, check = null, pattern = null, json = false } = {}) {
  const oracle = /** @type {{ verdicts?: Record<string, CaseVerdict[]> | null } | null} */ (
    readJson(join(runDir, 'oracle.json'))
  );
  const verdicts = pyGet(pyOr(oracle, {}), 'verdicts', null);
  const transitions = new Set(pySplit((transition || '').replaceAll(',', ' ')));
  const ids = check ? checkCaseIds(runDir, check) : null;
  const render = (/** @type {unknown} */ rows) =>
    dumps(rows, { indent: 2, sortKeys: true, ensureAscii: false });

  if (verdicts === null) {
    if (transitions.size > 0) {
      throw new LcrError('--transition needs oracle.json', { remedy: 'run `lcr oracle <run>` first' });
    }

    const rows = outputRows(runDir, { ids, pattern });

    print(json ? render(rows) : formatOutputTable(rows, { deltasOnly: ids === null && !pattern }));

    return;
  }

  const rows = tableRows(verdicts, { transitions: transitions.size > 0 ? transitions : null, ids, pattern });

  print(json ? render(rows) : formatTable(rows));
}

/**
 * @typedef {object} RowFilter
 * @property {ReadonlySet<string> | null} [transitions] Keep only these latest transitions.
 * @property {ReadonlySet<string> | null} [ids] Keep only these case ids.
 * @property {string | null} [pattern] Keep only case ids matching this glob.
 */

/**
 * One row per verdict (case and scheme) that passes the filters.
 *
 * @param {Record<string, CaseVerdict[]>} verdicts Case id -> verdicts (oracle.json `verdicts`).
 * @param {RowFilter} [filter]
 * @returns {VerdictRow[]}
 */
export function tableRows(verdicts, { transitions = null, ids = null, pattern = null } = {}) {
  const wanted = (/** @type {string} */ id) =>
    (ids === null || ids.has(id)) && (!pattern || fnmatchcase(id, pattern));
  /** @type {VerdictRow[]} */
  const rows = [];

  for (const id of Object.keys(verdicts).sort(compareCodePoints).filter(wanted)) {
    for (const verdict of pySorted(verdicts[id], (entry) => pyOr(pyGet(entry, 'scheme', null), ''))) {
      const latest = /** @type {Partial<ProfileSummary>} */ ((verdict.summary ?? {}).latest ?? {});

      if (transitions && !transitions.has(/** @type {string} */ (pyGet(latest, 'transition', null)))) {
        continue;
      }

      rows.push(verdictRow(id, verdict, latest));
    }
  }

  return rows;
}

/**
 * @param {string} id
 * @param {CaseVerdict} verdict
 * @param {Partial<ProfileSummary>} latest
 * @returns {VerdictRow}
 */
function verdictRow(id, verdict, latest) {
  const legacy = /** @type {Record<string, Partial<ProfileSummary>>} */ (
    (verdict.summary ?? {}).legacy ?? {}
  );
  const profiles = Object.keys(legacy).sort(compareCodePoints);

  return {
    id,
    scheme: pyGet(verdict, 'scheme', null),
    transition: pyGet(latest, 'transition', null),
    base: pyGet(latest, 'base', null),
    head: pyGet(latest, 'head', null),
    bad_base: pySorted(pyGet(latest.enginesBase ?? {}, 'bad', [])),
    bad_head: pySorted(pyGet(latest.enginesHead ?? {}, 'bad', [])),
    divergent: pyTruthy(latest.divergent),
    legacy: Object.fromEntries(
      profiles.map((profile) => [profile, pyGet(legacy[profile], 'transition', null)]),
    ),
    rejected: [pyGet(latest, 'rejectedBase', 0), pyGet(latest, 'rejectedHead', 0)],
  };
}

/**
 * The verdict rows as an aligned table plus a count per transition.
 *
 * @param {readonly VerdictRow[]} rows
 * @returns {string}
 */
export function formatTable(rows) {
  if (rows.length === 0) {
    return NO_ROWS;
  }

  /** @type {string[][]} */
  const cells = [['id', 'scheme', 'transition', 'base', 'head', 'bad b/h', 'div', 'rej b/h', 'legacy']];

  for (const row of rows) {
    const legacy = Object.entries(row.legacy)
      .map(([profile, transition]) => `${profile.replaceAll('legacy-', '')}:${pyStr(transition)}`)
      .join(' ');

    cells.push([
      row.id,
      pyStr(pyOr(row.scheme, '-')),
      pyStr(pyOr(row.transition, '-')),
      pyStr(pyOr(row.base, '-')),
      pyStr(pyOr(row.head, '-')),
      `${abbreviateEngines(row.bad_base)}/${abbreviateEngines(row.bad_head)}`,
      row.divergent ? 'yes' : '-',
      `${pyStr(row.rejected[0])}/${pyStr(row.rejected[1])}`,
      legacy || '-',
    ]);
  }

  /** @type {Map<string | null, number>} */
  const counts = new Map();

  for (const row of rows) {
    counts.set(row.transition, (counts.get(row.transition) ?? 0) + 1);
  }

  const summary = pySorted(counts, ([transition]) => pyStr(transition))
    .map(([transition, count]) => `${pyStr(transition)}=${count}`)
    .join(', ');

  return [...alignColumns(cells), `${rows.length} row(s): ${summary}`].join('\n');
}

/**
 * Left-align every column but the last to its widest cell, two spaces apart.
 *
 * @param {readonly string[][]} cells
 * @returns {string[]}
 */
function alignColumns(cells) {
  const widths = cells[0]
    .slice(0, -1)
    .map((_, column) => cells.reduce((widest, row) => Math.max(widest, pyLen(row[column])), 0));

  return cells.map(
    (row) => `${widths.map((width, column) => pyFormat(row[column], `<${width}`)).join('  ')}  ${row.at(-1)}`,
  );
}

/**
 * Case ids a report check lists (report.json; run `lcr report` first). Items look like
 * `<case id>[~dark][@profile] <note>`; only the id is kept.
 *
 * @param {string} runDir
 * @param {string} check
 * @returns {Set<string>}
 */
export function checkCaseIds(runDir, check) {
  const report = /** @type {Partial<ReportFile> | null} */ (readJson(join(runDir, 'report.json')));

  if (!pyTruthy(report)) {
    throw new LcrError('--check needs report.json', {
      remedy: 'run `lcr report <run> --allow-incomplete` first',
    });
  }

  for (const row of report?.checks ?? []) {
    if (row.id === check) {
      return new Set((row.items ?? []).map((item) => pyStr(item).split(' ')[0].split('~')[0].split('@')[0]));
    }
  }

  throw new LcrError(`no check ${check} in report.json`);
}

/**
 * Before the oracle: one row per corpus case from the outputs. Without `ids` or `pattern`, only
 * the deltas (base and head outputs differ).
 *
 * @param {string} runDir
 * @param {{ ids?: ReadonlySet<string> | null, pattern?: string | null }} [filter]
 * @returns {OutputRow[]}
 */
export function outputRows(runDir, { ids = null, pattern = null } = {}) {
  const corpusDir = join(runDir, 'corpus');
  const casesPath = join(corpusDir, 'cases.jsonl');

  if (!existsSync(casesPath)) {
    throw new LcrError('no corpus yet', { remedy: 'run `lcr corpus <run>` first' });
  }

  const changed = new Set(iterJsonl(join(corpusDir, 'deltas.jsonl')).map((row) => idOf(row)));
  const keep = (/** @type {string} */ id) =>
    (ids === null || ids.has(id)) && (pattern ? fnmatchcase(id, pattern) : ids !== null || changed.has(id));
  const cases = /** @type {AnyCase[]} */ (
    iterJsonl(casesPath)
      .filter((row) => keep(idOf(row)))
      .toArray()
  );
  const base = outputStatus(join(corpusDir, 'outputs-base.jsonl'));
  const head = outputStatus(join(corpusDir, 'outputs-head.jsonl'));

  return pySorted(cases, (entry) => entry.id).map((entry) => ({
    id: entry.id,
    source: pyGet(entry, 'source', null),
    area: pyOr(pyGet(entry, 'area', null), pyGet(entry.probe ?? {}, 'area', null)),
    base_ok: base.get(entry.id) ?? null,
    head_ok: head.get(entry.id) ?? null,
    changed: changed.has(entry.id),
  }));
}

/**
 * @param {unknown} row
 * @returns {string}
 */
function idOf(row) {
  return /** @type {{ id: string }} */ (row).id;
}

/**
 * Case id -> whether that side produced output.
 *
 * @param {string} path
 * @returns {Map<string, boolean>}
 */
function outputStatus(path) {
  return new Map(
    iterJsonl(path).map((row) => [idOf(row), pyTruthy(/** @type {{ ok?: boolean }} */ (row).ok)]),
  );
}

/**
 * The pre-oracle rows as an aligned table plus a summary line.
 *
 * @param {readonly OutputRow[]} rows
 * @param {{ deltasOnly?: boolean }} [options] Say that only deltas are listed by default.
 * @returns {string}
 */
export function formatOutputTable(rows, { deltasOnly = false } = {}) {
  if (rows.length === 0) {
    return NO_ROWS;
  }

  /** @type {string[][]} */
  const cells = [['id', 'source', 'area', 'base', 'head', 'changed']];

  for (const row of rows) {
    cells.push([
      row.id,
      pyStr(pyOr(row.source, '-')),
      pyStr(pyOr(row.area, '-')),
      outputFlag(row.base_ok),
      outputFlag(row.head_ok),
      row.changed ? 'yes' : '-',
    ]);
  }

  const changed = rows.filter((row) => row.changed).length;
  const hint = deltasOnly ? "; deltas only (`--case '*'` lists every case)" : '';

  return [
    ...alignColumns(cells),
    `${rows.length} row(s), ${changed} changed; no oracle yet, outputs only${hint}`,
  ].join('\n');
}

/**
 * @param {boolean | null} ok
 * @returns {string}
 */
function outputFlag(ok) {
  if (ok === null) {
    return '-';
  }

  return ok ? 'ok' : 'error';
}
