/**
 * `lcr worklist`: ported from py-final tests/test_report.py `WorklistTest`, plus the stale mark
 * being cleared again and the family glob.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { driverGolden, printed, writeScenario } from '../../../test/fixtures/driver/golden.js';
import { captureOutput, tempDir } from '../../../test/helpers/index.js';
import { mutationCase, probeCase, SyntheticRun, verdict } from '../../../test/helpers/synthetic-run.js';
import { evaluate, openSlots } from '../../report/evaluate.js';
import { familyGlob, worklist } from '../worklist.js';

/** @import { ChecklistItem } from '../../report/checklists.js' */

/** py-final's ITEM. */
const ITEM = /** @type {ChecklistItem} */ ({
  item: 'COLOR-01',
  severity: 'MAJOR',
  text: 'Colors stay equivalent',
  list: 'color',
  verify: 'a `lower-minify` probe or a minify test',
  covers: [],
});

/**
 * Run the worklist with a fixed checklist; return what it printed (parsed) and analysis.json.
 *
 * @param {SyntheticRun} run
 * @param {ChecklistItem[]} [items]
 * @returns {Promise<{ out: any, analysis: any, stdout: string }>}
 */
async function runWorklist(run, items = []) {
  const dir = run.write();
  const checklists = () => items.map((item) => ({ ...item }));
  const { result, stdout } = await captureOutput(() => worklist(dir, { checklists }));

  return { out: result, analysis: JSON.parse(readFileSync(join(dir, 'analysis.json'), 'utf8')), stdout };
}

describe('worklist', () => {
  test('slots are uncapped, grouped by family and stale-marked', async () => {
    using run = new SyntheticRun();
    const oracle = /** @type {any} */ (run.oracle);
    const parent = run.addCase(probeCase('p-color/x'));
    const mutations = Array.from({ length: 14 }, (_, index) =>
      run.addCase(mutationCase(parent, `wrap-${index}`), { delta: true }),
    );

    for (const id of mutations) {
      oracle.verdicts[id] = verdict(id, {
        base: 'no-coverage',
        head: 'no-coverage',
        transition: 'unverified',
      });
    }

    const regressed = run.addCase(probeCase('p-color/reg'), { delta: true });

    run.addCase(mutationCase(regressed, 'nest'), { delta: true });
    oracle.verdicts[regressed] = verdict(regressed, {
      base: 'equivalent',
      head: 'different',
      transition: 'regressed',
    });
    /** @type {any} */ (run.analysis).deltas = [{ id: 'p-color/gone', classification: '', reason: '' }];

    const { out, analysis, stdout } = await runWorklist(run);
    const slots = new Map(out.deltas.map((/** @type {{ id: string }} */ slot) => [slot.id, slot]));

    assert.equal(slots.get('m-p-color/x-*').count, 14);
    assert.deepEqual(slots.get(regressed).checks, ['O1']);
    assert.deepEqual(out.stale_slots, ['p-color/gone']);
    assert.equal(
      analysis.deltas.find((/** @type {{ id: string }} */ d) => d.id === 'p-color/gone')._stale,
      true,
    );
    assert.deepEqual(JSON.parse(stdout), out);

    for (const delta of analysis.deltas) {
      if (delta.id === 'm-p-color/x-*') {
        Object.assign(delta, { classification: 'ORACLE_NOISE', reason: 'L1 no coverage' });
      }
    }

    run.analysis = analysis;

    const evaluation = evaluate(run.write(), { checklists: () => [] });
    const check = (/** @type {string} */ id) => evaluation.checks.find((row) => row.id === id);

    assert.equal(check('O8')?.status, 'FAIL');
    assert.ok(!check('A3')?.evidence.includes('p-color/gone'));
    assert.deepEqual(
      new Set(openSlots(evaluation).map((slot) => slot.id)),
      new Set([regressed, `m-${regressed}-nest`]),
    );
  });

  test('items for untouched files are prefilled', async () => {
    using run = new SyntheticRun();
    const { out, analysis } = await runWorklist(run, [{ ...ITEM, covers: ['src/rules/*.rs'] }]);

    assert.deepEqual(out.prefilled_na, ['COLOR-01']);
    assert.deepEqual(out.checklist, []);
    assert.equal(analysis.checklist[0].evidence, 'Covers src/rules/*.rs; diff touches none');
  });

  test('a new run gets the skeleton; existing answers are kept', async () => {
    using run = new SyntheticRun();

    run.analysis = null;

    const first = await runWorklist(run, [ITEM]);

    assert.deepEqual(first.out, {
      checklist: ['COLOR-01'],
      prefilled_na: [],
      deltas: [],
      stale_slots: [],
      linked_issues: [],
      intent: true,
    });
    assert.equal(first.analysis.run_id, 'run');

    first.analysis.checklist[0].answer = 'PASS';
    run.analysis = first.analysis;

    const second = await runWorklist(run, [ITEM]);

    assert.deepEqual(second.out.checklist, []);
    assert.equal(second.analysis.checklist.length, 1);
    assert.equal(second.analysis.checklist[0]._text, 'Colors stay equivalent');
  });

  test('family glob of a mutation case', () => {
    assert.equal(familyGlob({ id: 'm-p-a/x-nest', source: 'mutation', parent: 'p-a/x' }), 'm-p-a/x-*');
    assert.equal(familyGlob({ id: 'p-a/x', source: 'probe' }), null);
    assert.equal(familyGlob(undefined), null);
  });
});

describe('py-final golden', () => {
  test('family slots, exact ids for bad members, stale marks, N/A prefill and ASCII output', async () => {
    const scenario = driverGolden().worklist;

    using dir = tempDir();
    const run = writeScenario(join(dir.path, 'run'), scenario);
    const checklists = () => scenario.checklists.map((/** @type {ChecklistItem} */ item) => ({ ...item }));
    const analysisText = () => readFileSync(join(run, 'analysis.json'), 'utf8');

    assert.deepEqual(await printed(run, () => worklist(run, { checklists })), {
      stdout: scenario.stdout,
      error: null,
    });
    assert.equal(analysisText(), scenario.analysis);

    // A second pass over its own output changes nothing.
    assert.deepEqual(await printed(run, () => worklist(run, { checklists })), {
      stdout: scenario.stdout2,
      error: null,
    });
    assert.equal(analysisText(), scenario.analysis2);
  });
});
