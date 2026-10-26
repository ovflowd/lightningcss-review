/**
 * Shared helpers of the report tests: evaluate a synthetic run with an injected checklist, find a
 * check row, and the checklist item the report tests answer.
 */
import { SyntheticRun } from '../../../test/helpers/synthetic-run.js';
import { evaluate } from '../evaluate.js';

/**
 * @import { Json } from '../../../test/helpers/synthetic-run.js'
 * @import { ChecklistItem } from '../checklists.js'
 * @import { Evaluation } from '../evaluate.js'
 * @import { CheckRow } from '../../types.js'
 */

/** The checklist item the report tests answer. */
export const ITEM = Object.freeze({
  item: 'COLOR-01',
  severity: /** @type {const} */ ('MAJOR'),
  text: 'Colors stay equivalent',
  list: 'color',
  verify: 'a `lower-minify` probe or a minify test',
  covers: /** @type {string[]} */ ([]),
});

/**
 * A synthetic run whose stage objects are present (the report tests fill them in place).
 *
 * @typedef {SyntheticRun & { prep: Json, build: Json, corpus: Json, oracle: Json, analysis: Json }} ReportRun
 */

/**
 * A new synthetic run with every stage file present.
 *
 * @returns {ReportRun}
 */
export function reportRun() {
  return /** @type {ReportRun} */ (new SyntheticRun());
}

/**
 * Leave a stage file out of the run (as if the stage did not run).
 *
 * @param {ReportRun} run
 * @param {'prep' | 'build' | 'corpus' | 'oracle' | 'analysis'} stage
 * @returns {void}
 */
export function omitStage(run, stage) {
  /** @type {SyntheticRun} */ (run)[stage] = null;
}

/**
 * Write the run and evaluate it with `checklist` as the run's checklist, so a test does not depend
 * on the real checklist files.
 *
 * @param {SyntheticRun} run
 * @param {readonly Partial<ChecklistItem>[]} [checklist]
 * @returns {Evaluation}
 */
export function evaluateRun(run, checklist = []) {
  run.write();

  return evaluate(run.dir, {
    checklists: () =>
      checklist.map((item) => /** @type {ChecklistItem} */ ({ ...item, covers: [...(item.covers ?? [])] })),
  });
}

/**
 * The row of one check.
 *
 * @param {Evaluation} evaluation
 * @param {string} id
 * @returns {CheckRow}
 */
export function check(evaluation, id) {
  const row = evaluation.checks.find((candidate) => candidate.id === id);

  if (!row) {
    throw new Error(`no check ${id}`);
  }

  return row;
}
