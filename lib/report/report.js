/**
 * Stage 6, report: render report.md and report.json from the evaluated check catalog, and the
 * fixed chat summary (`lcr summary`) from report.json.
 *
 * Reads the whole run directory (see evaluate.js and render.js); writes <run>/report.md and
 * <run>/report.json. `lcr summary` reads report.json, prepare.json, corpus.json, oracle.json,
 * analysis.json and corpus/deltas.jsonl, and writes nothing.
 *
 * Invariant: a pure function of the run directory; the same inputs give byte-identical output
 * (report.md, report.json and the summary are a fixed format that reviewers diff between runs).
 */
import { join } from 'node:path';

import { LcrError } from '../core/errors.js';
import { readJson, readJsonl, readText, writeJson, writeText } from '../core/files.js';
import { print } from '../core/log.js';
import { joinPath } from '../core/pathlib.js';
import { SKILL_DIR, skillVersion } from '../core/paths.js';
import { pyGet, pyOr } from '../core/py-value.js';
import { compareCodePoints, formatTemplate, pyStr, pyTruthy } from '../core/py.js';
import { stageFile } from './context.js';
import { NOT_VERIFIED } from './constants.js';
import { EM_DASH } from './glyphs.js';
import { evaluate } from './evaluate.js';
import { engineList, render } from './render.js';
import { snippetWords } from './text.js';
import { verdictLine } from './verdict.js';

/**
 * @import { Analysis, CorpusSummary, Delta, OracleSummary, Prepare, PrMeta, ReportFile } from '../types.js'
 * @import { EvaluateOptions } from './evaluate.js'
 */

/** report.json schema version. */
const REPORT_SCHEMA = 1;

/** Findings in the chat summary: up to this many above NOTE, else the first notes. */
const SUMMARY_FINDINGS = 6;
const SUMMARY_NOTES = 3;

/** Characters of a finding title, its first evidence, a related finding and a decision line. */
const SUMMARY_TITLE_CHARS = 160;
const SUMMARY_EVIDENCE_CHARS = 140;
const SUMMARY_RELATED_CHARS = 100;
const SUMMARY_DECISION_CHARS = 200;

/**
 * Evaluate, render and write report.md / report.json; prints the verdict line and the report path
 * (spelled as pathlib spells it, so the printed line stays the same as in earlier runs' logs).
 *
 * @param {string} runDir
 * @param {{ allowIncomplete?: boolean } & EvaluateOptions} [options] `allowIncomplete` only exists
 *   for the CLI flag and changes nothing: the report always renders, and an incomplete analysis
 *   makes the verdict INCONCLUSIVE.
 * @returns {Promise<ReportFile>}
 */
export async function report(runDir, { checklists } = {}) {
  const evaluation = evaluate(runDir, { checklists });
  const reportPath = joinPath(runDir, 'report.md');
  const { prep, scope } = evaluation;

  writeText(reportPath, render(evaluation, runDir));

  /** @type {ReportFile} */
  const data = {
    schema: REPORT_SCHEMA,
    run_id: prep.run_id,
    pr: (pyGet(prep, 'pr', /** @type {Partial<PrMeta>} */ ({})) ?? {}).number ?? null,
    verdict: evaluation.verdict,
    verdict_scope: scope ? scope.text : null,
    default_requests: scope ? scope.default_requests : null,
    decision_needed: evaluation.decision,
    counts: evaluation.counts,
    checks: evaluation.checks,
    findings: /** @type {ReportFile['findings']} */ (evaluation.findings),
    stages: evaluation.stages,
    base: prep.base,
    head_tree: prep.head_tree,
    engines: pyGet(evaluation.oracle, 'profiles', {}),
    skill_version: skillVersion(),
  };

  writeJson(join(runDir, 'report.json'), data);

  const counts = Object.entries(evaluation.counts).map(
    ([severity, count]) => `${count} ${severity.toLowerCase()}`,
  );

  print(`VERDICT: ${verdictLine(evaluation.verdict, scope)} (${counts.join(', ')})`);
  print(reportPath);

  return data;
}

/**
 * Behavioral deltas, how many a browser verified, and how many errored in an engine.
 *
 * @param {Partial<CorpusSummary>} corpus
 * @param {Partial<OracleSummary>} oracle
 * @param {Iterable<string> | null} deltas The delta ids; null counts every case with a verdict.
 * @returns {[number, number, number]}
 */
export function deltaCoverage(corpus, oracle, deltas) {
  const verdicts = new Map(Object.entries(pyOr(oracle.verdicts, {})));
  const total = Object.values(pyOr(corpus.deltas, {})).reduce((sum, count) => sum + Number(count), 0);
  const ids = [...new Set(deltas ?? verdicts.keys())];
  const transitions = (/** @type {string} */ id) =>
    (verdicts.get(id) ?? []).map((verdict) => verdict.summary.latest.transition);
  const verified = ids.filter((id) =>
    transitions(id).some((transition) => !NOT_VERIFIED.includes(transition)),
  );
  const errored = ids.filter((id) => transitions(id).includes('errored'));

  return [total, verified.length, errored.length];
}

/**
 * Print the fixed chat summary (templates/summary.md.tmpl, filled from report.json) and return it.
 *
 * @param {string} runDir
 * @returns {Promise<string>}
 */
export async function summary(runDir) {
  const rep = /** @type {ReportFile | null} */ (readJson(join(runDir, 'report.json')));

  if (!rep || !pyTruthy(rep)) {
    throw new LcrError('run `lcr report` first');
  }

  const template = readText(join(SKILL_DIR, 'templates', 'summary.md.tmpl'));
  const text = formatTemplate(template, summaryFields(runDir, rep));

  print(text);

  return text;
}

/**
 * The template fields of the chat summary.
 *
 * @param {string} runDir
 * @param {ReportFile} rep
 * @returns {Record<string, unknown>}
 */
function summaryFields(runDir, rep) {
  const prep = /** @type {Partial<Prepare>} */ (stageFile(runDir, 'prepare.json'));
  const corpus = /** @type {Partial<CorpusSummary>} */ (stageFile(runDir, 'corpus.json'));
  const oracle = /** @type {Partial<OracleSummary>} */ (stageFile(runDir, 'oracle.json'));
  const analysis = /** @type {Partial<Analysis>} */ (stageFile(runDir, 'analysis.json'));
  const deltaIds = /** @type {Delta[]} */ (readJsonl(join(runDir, 'corpus', 'deltas.jsonl'))).map(
    (row) => row.id,
  );
  const [deltasTotal, verified, errored] = deltaCoverage(corpus, oracle, deltaIds);
  const scoped = pyTruthy(rep.verdict_scope);
  const cases = pyOr(corpus.cases, {});

  return {
    pr: pyTruthy(rep.pr) ? rep.pr : pyGet(prep, 'range', ''),
    verdict: rep.verdict,
    scope: scoped ? ` (${pyStr(rep.verdict_scope)})` : '',
    blocker: rep.counts.BLOCKER,
    major: rep.counts.MAJOR,
    minor: rep.counts.MINOR,
    note: rep.counts.NOTE,
    intent_summary: intentSummary(analysis, pyGet(prep, 'pr', /** @type {Partial<PrMeta>} */ ({})) ?? {}),
    findings_list: findingLines(rep).join('\n') || 'None.',
    decision_block: decisionBlock(pyOr(rep.decision_needed, [])),
    engines: engineList(pyOr(oracle.profiles, {}), '; ') || 'no browser run',
    deltas_total: deltasTotal,
    deltas_verified: verified,
    deltas_errored: errored ? `, ${errored} errored` : '',
    default_path: scoped ? `; default path byte-identical (${pyStr(rep.default_requests)} requests)` : '',
    probes_pr: pyGet(corpus, 'probes', []).filter((probe) => probe.origin === 'pr').length,
    mutations: pyGet(cases, 'mutation', 0),
    wpt_cases: pyGet(cases, 'wpt', 0),
    realworld_files: new Set(pyGet(corpus, 'size', []).map((row) => row.name)).size,
    report_path: joinPath(runDir, 'report.md'),
  };
}

/**
 * The reviewer's intent summary, or the PR title.
 *
 * @param {Partial<Analysis>} analysis
 * @param {Partial<PrMeta>} pr
 * @returns {unknown}
 */
function intentSummary(analysis, pr) {
  const intent = pyTruthy(analysis.intent) ? analysis.intent : null;

  return pyTruthy(intent?.summary) ? intent?.summary : pyGet(pr, 'title', '');
}

/**
 * One numbered line per headline finding: severity, checklist item, title, first evidence, what
 * folded into it and related findings.
 *
 * @param {ReportFile} rep
 * @returns {string[]}
 */
function findingLines(rep) {
  const serious = rep.findings.filter((finding) => finding.severity !== 'NOTE').slice(0, SUMMARY_FINDINGS);
  const findings = serious.length > 0 ? serious : rep.findings.slice(0, SUMMARY_NOTES);

  return findings.map((finding, index) => {
    const evidence = (pyTruthy(finding.evidence) ? finding.evidence : [''])[0];
    const tag = pyTruthy(finding.check) && finding.source === 'checklist' ? `[${finding.check}] ` : '';
    let line = `${index + 1}. [${finding.severity}] ${tag}${snippetWords(finding.title, SUMMARY_TITLE_CHARS)}`;

    if (pyTruthy(evidence)) {
      line += ` ${EM_DASH} ${snippetWords(evidence, SUMMARY_EVIDENCE_CHARS)}`;
    }

    if (pyTruthy(finding.folded)) {
      const also = new Set((finding.folded ?? []).map((entry) => entry.check || entry.source));

      line += ` (also: ${[...also].sort(compareCodePoints).join(', ')})`;
    }

    if (pyTruthy(finding.related)) {
      line += ` (see ${(finding.related ?? []).map((related) => snippetWords(related, SUMMARY_RELATED_CHARS)).join('; ')})`;
    }

    return line;
  });
}

/**
 * @param {string[]} decision
 * @returns {string}
 */
function decisionBlock(decision) {
  if (decision.length === 0) {
    return '';
  }

  return `\nDecision needed:\n${decision.map((line) => `- ${snippetWords(line, SUMMARY_DECISION_CHARS)}`).join('\n')}\n`;
}
