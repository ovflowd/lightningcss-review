/**
 * The evaluation as a whole: catalog order, stage tracking and the open slots `lcr worklist` uses
 * (lib/inspect/test/worklist.test.js covers the command that prints them).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { mutationCase, probeCase, verdict } from '../../../test/helpers/synthetic-run.js';
import { loadConfig } from '../../core/paths.js';
import { evaluate, openSlots } from '../evaluate.js';
import { evaluateRun, omitStage, reportRun } from './support.js';

/** @import { ChecksConfig } from '../../types.js' */

describe('evaluation', () => {
  test('every catalog check appears once, in catalog order', () => {
    using run = reportRun();

    omitStage(run, 'build');
    omitStage(run, 'oracle');

    const evaluation = evaluateRun(run);
    const catalog = /** @type {ChecksConfig} */ (loadConfig('checks.json')).checks.map((check) => check.id);

    assert.deepEqual(
      evaluation.checks.map((check) => check.id),
      catalog,
    );
    assert.deepEqual(evaluation.stages, {
      prepare: true,
      build: false,
      corpus: true,
      oracle: false,
      analysis: true,
    });
    assert.deepEqual(evaluation.missingStages, ['build', 'oracle']);
  });

  test('open slots are uncapped, grouped by case and list their checks', () => {
    using run = reportRun();
    const parent = run.addCase(probeCase('p-color/x'));
    const mutations = Array.from({ length: 14 }, (_, index) =>
      run.addCase(mutationCase(parent, `wrap-${index}`), { delta: true }),
    );

    for (const id of mutations) {
      run.oracle.verdicts[id] = verdict(id, {
        base: 'no-coverage',
        head: 'no-coverage',
        transition: 'unverified',
      });
    }

    const regressed = run.addCase(probeCase('p-color/reg'), { delta: true });

    run.addCase(mutationCase(regressed, 'nest'), { delta: true });
    run.oracle.verdicts[regressed] = verdict(regressed, { head: 'different', transition: 'regressed' });
    run.analysis.deltas = [{ id: `m-${parent}-*`, classification: 'ORACLE_NOISE', reason: 'L1 no coverage' }];

    const evaluation = evaluateRun(run);
    const slots = openSlots(evaluation);

    assert.deepEqual(
      slots.map((slot) => slot.id),
      [`m-${regressed}-nest`, regressed],
    );
    assert.deepEqual(slots.find((slot) => slot.id === regressed)?.checks, ['O1']);
    assert.deepEqual(evaluation.oracleBad, [regressed]);
  });

  test('openSlots merges the checks a case is open in, sorted by check id', () => {
    const open = new Map([
      ['S1', ['p-a [color]']],
      ['O1', ['p-a~dark', 'p-b']],
      ['O10', ['p-a [input inert]']],
    ]);

    assert.deepEqual(openSlots({ open }), [
      { id: 'p-a', checks: ['O1', 'O10', 'S1'] },
      { id: 'p-b', checks: ['O1'] },
    ]);
  });

  test('the default checklist loader reads references/checklists', () => {
    using run = reportRun();

    run.write();

    const evaluation = evaluate(run.dir);

    assert.ok(evaluation.checklist.some((item) => item.list === 'general'));
    assert.ok(evaluation.checklist.some((item) => item.list === 'color'));
  });
});
