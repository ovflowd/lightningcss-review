/**
 * Evaluate the check catalog (config/checks.json) over a run's stage files and analysis.json:
 * check rows, findings, verdict, decision lines and the open analysis slots.
 *
 * Stage: report; `lcr worklist` uses the same evaluation to know which slots exist.
 *
 * Reads prepare.json (required), build.json, build/<side>/tests.json, corpus.json,
 * corpus/{cases,deltas,outputs-*}.jsonl, oracle.json, perf.json, analysis.json and the spec
 * checklists. Writes nothing.
 *
 * Invariants:
 * - A pure function of the run directory: the same inputs give the same evaluation, and therefore
 *   byte-identical report.md / report.json.
 * - Every catalog check appears exactly once, in catalog order (a stable report shape); a check
 *   whose stage did not run is a SKIP.
 * - The reviewer's judgment enters only through analysis.json, whose slots are validated (A3);
 *   missing slots make the verdict INCONCLUSIVE.
 */
import { compareCodePoints, pyTruthy } from '../core/py.js';
import { caseId } from './cases.js';
import { loadChecklists } from './checklists.js';
import { baseWrongTest, checklistCheck, linkedIssueCheck } from './checks/analysis.js';
import { buildChecks } from './checks/build.js';
import { classificationCoverage, completenessCheck } from './checks/completeness.js';
import { oracleBad, oracleBuckets, oracleChecks } from './checks/oracle.js';
import { perfChecks } from './checks/perf.js';
import { probeAssertions, probeCheck } from './checks/probes.js';
import { robustnessChecks } from './checks/robustness.js';
import { sideEffectChecks } from './checks/side-effects.js';
import { testChecks } from './checks/tests.js';
import { loadContext } from './context.js';
import { buildFindings, countFindings } from './findings.js';
import { decideVerdict, verdictScope } from './verdict.js';

/**
 * @import { Analysis, Build, CheckRow, CorpusSummary, Delta, OracleSummary, Prepare, Severity,
 *   Verdict } from '../types.js'
 * @import { CaseRecord } from './cases.js'
 * @import { ChecklistItem, ResolvedAnswer } from './checklists.js'
 * @import { ChecklistLoader } from './context.js'
 * @import { FindingEntry } from './findings.js'
 * @import { ProbeAsserts } from './checks/probes.js'
 * @import { VerdictScope } from './verdict.js'
 */

/** @typedef {typeof STAGES[number]} StageName */

/**
 * The full evaluation of a run.
 *
 * @typedef {object} Evaluation
 * @property {Prepare} prep
 * @property {Partial<Build>} build `{}` when the stage did not run.
 * @property {Partial<CorpusSummary>} corpus
 * @property {Partial<OracleSummary>} oracle
 * @property {Partial<Analysis>} analysis
 * @property {Map<string, CaseRecord>} cases corpus/cases.jsonl by id.
 * @property {Map<string, Delta>} deltas corpus/deltas.jsonl by id.
 * @property {CheckRow[]} checks In catalog order.
 * @property {FindingEntry[]} findings Sorted and numbered.
 * @property {Record<Severity, number>} counts
 * @property {Verdict} verdict
 * @property {Record<StageName, boolean>} stages
 * @property {StageName[]} missingStages
 * @property {ChecklistItem[]} checklist
 * @property {Map<unknown, ResolvedAnswer>} answers
 * @property {Map<string, string[]>} open Check id -> items still needing a classification.
 * @property {string[]} oracleBad Case ids the browsers show head worse than base for (sorted).
 * @property {string[]} decision The "decision needed" lines.
 * @property {VerdictScope | null} scope
 * @property {string[]} probeFixed `<probe case>: <assertion>` fixed by this PR.
 * @property {Map<string, ProbeAsserts>} probeAsserts
 * @property {Map<string, string>} extended Case id -> the base test that already gives its output.
 * @property {string[]} incomplete What A3 found missing in the analysis.
 */

/**
 * @typedef {object} EvaluateOptions
 * @property {ChecklistLoader} [checklists] Reads the run's checklists (default `loadChecklists`;
 *   tests inject their own items).
 */

/**
 * Evaluate the check catalog over a run directory.
 *
 * @param {string} runDir
 * @param {EvaluateOptions} [options]
 * @returns {Evaluation}
 */
export function evaluate(runDir, { checklists = loadChecklists } = {}) {
  const ctx = loadContext(runDir, checklists);

  // The order is a data dependency: T6 skips what R2 charges, the evidence rules need the probe
  // assertions and base crashes, and A3 reads every slot the earlier checks left open.
  buildChecks(ctx);
  testChecks(ctx);

  const probeAsserts = probeAssertions(ctx);
  const buckets = oracleBuckets(ctx);

  oracleChecks(ctx, buckets);

  const { unstable, baseCrashes } = robustnessChecks(ctx);

  sideEffectChecks(ctx);
  perfChecks(ctx);

  const { fixed: probeFixed } = probeCheck(ctx, probeAsserts, unstable);
  const baseWrong = baseWrongTest(ctx, probeAsserts, baseCrashes);
  const review = checklistCheck(ctx, baseWrong);

  linkedIssueCheck(ctx, probeAsserts, probeFixed);

  const coverage = classificationCoverage(ctx);
  const incomplete = completenessCheck(ctx, { buckets, review, baseWrong, coverage });
  const checks = catalogOrder(ctx.checks);
  const bad = oracleBad(buckets);
  const { findings, decision } = buildFindings(ctx, { review, coverage, oracleBad: bad });
  const stages = stagesRan(ctx);
  const missingStages = STAGES.filter((name) => !stages[name]);
  const counts = countFindings(findings);

  return {
    prep: ctx.prep,
    build: ctx.build,
    corpus: ctx.corpus,
    oracle: ctx.oracle,
    analysis: ctx.analysis,
    cases: ctx.cases,
    deltas: ctx.deltas,
    checks,
    findings,
    counts,
    verdict: decideVerdict(counts, { missingStages, checks, incomplete }),
    stages,
    missingStages,
    checklist: ctx.checklist,
    answers: ctx.answers,
    open: ctx.checks.open,
    oracleBad: [...bad].sort(compareCodePoints),
    decision,
    scope: verdictScope(ctx),
    probeFixed,
    probeAsserts,
    extended: buckets.extendedBy,
    incomplete,
  };
}

/** The stages the report reads, in report order. */
const STAGES = /** @type {const} */ (['prepare', 'build', 'corpus', 'oracle', 'analysis']);

/**
 * Which stages ran: a stage whose file is missing or empty did not (prepare.json is required).
 *
 * @param {import('./context.js').EvalContext} ctx
 * @returns {Record<StageName, boolean>}
 */
function stagesRan(ctx) {
  return {
    prepare: true,
    build: pyTruthy(ctx.build),
    corpus: pyTruthy(ctx.corpus),
    oracle: pyTruthy(ctx.oracle),
    analysis: pyTruthy(ctx.analysis),
  };
}

/**
 * Add a SKIP row for every catalog check no evaluator reached, and put the rows in catalog order.
 *
 * @param {import('./context.js').CheckRecorder} recorder
 * @returns {CheckRow[]}
 */
function catalogOrder(recorder) {
  const present = new Set(recorder.rows.map((row) => row.id));

  for (const meta of recorder.config.checks) {
    if (!present.has(meta.id)) {
      recorder.add(meta.id, 'SKIP', 'not evaluated (stage missing)');
    }
  }

  const order = new Map(recorder.config.checks.map((meta, index) => [meta.id, index]));

  recorder.rows.sort(
    (a, b) => /** @type {number} */ (order.get(a.id)) - /** @type {number} */ (order.get(b.id)),
  );

  return recorder.rows;
}

/**
 * Cases the report still needs a classification for, uncapped, with the checks that list them
 * (sorted by case id; checks in check-id order).
 *
 * @param {Pick<Evaluation, 'open'>} evaluation
 * @returns {{ id: string, checks: string[] }[]}
 */
export function openSlots(evaluation) {
  /** @type {Map<string, { id: string, checks: string[] }>} */
  const slots = new Map();
  const checks = [...evaluation.open].sort(([a], [b]) => compareCodePoints(a, b));

  for (const [check, tags] of checks) {
    for (const tag of tags) {
      const id = caseId(tag);
      const slot = slots.get(id) ?? { id, checks: [] };

      slots.set(id, slot);

      if (!slot.checks.includes(check)) {
        slot.checks.push(check);
      }
    }
  }

  return [...slots.keys()]
    .sort(compareCodePoints)
    .map((id) => /** @type {{ id: string, checks: string[] }} */ (slots.get(id)));
}
