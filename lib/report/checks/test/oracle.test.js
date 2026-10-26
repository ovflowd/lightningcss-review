/**
 * The oracle checks O1-O10: verdicts by transition, the O6 screenshot note and the O4 legacy
 * profiles.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { probeCase, verdict } from '../../../../test/helpers/synthetic-run.js';
import { openSlots } from '../../evaluate.js';
import { deltaCoverage } from '../../report.js';
import { check, evaluateRun, omitStage, reportRun } from '../../test/support.js';

const ENGINES = ['chromium', 'firefox', 'webkit'];

describe('transitions', () => {
  test('an errored delta is inconclusive, not different', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-color/err'), { delta: true });

    run.oracle.verdicts[id] = verdict(id, { base: 'error', head: 'error', transition: 'errored' });

    const evaluation = evaluateRun(run);

    assert.equal(check(evaluation, 'O1').status, 'PASS');
    assert.equal(check(evaluation, 'O8').status, 'INCONCLUSIVE');
    assert.equal(evaluation.verdict, 'INCONCLUSIVE');
    assert.deepEqual(deltaCoverage(run.corpus ?? {}, run.oracle ?? {}, [id]), [1, 0, 1]);
  });

  test('a rejected input goes to the decision bucket', () => {
    using run = reportRun();
    const id = run.addCase(
      {
        id: 't-1',
        source: 'tuple',
        side: 'head',
        test: 'tests::test_color',
        helper: 'minify_test',
        line: 1,
        request: { kind: 'sheet', css: 'x' },
      },
      { delta: true },
    );

    run.corpus.tuples = {
      modified: [{ id: 't-0', head_id: id, test: 'tests::test_color', line: 1, head_line: 2 }],
    };
    run.oracle.verdicts[id] = verdict(id, {
      base: 'no-coverage',
      head: 'different',
      transition: 'input-rejected',
    });

    const evaluation = evaluateRun(run);

    for (const row of ['O1', 'O2']) {
      assert.equal(check(evaluation, row).status, 'PASS');
    }

    assert.equal(check(evaluation, 'T3').status, 'PASS');
    assert.deepEqual(
      [check(evaluation, 'O10').status, check(evaluation, 'O10').severity],
      ['PARTIAL', 'NOTE'],
    );
    assert.notEqual(evaluation.verdict, 'UNSAFE');
  });

  test('worsened and divergent regressions feed O1', () => {
    using run = reportRun();
    const worsened = run.addCase(probeCase('p-color/w'), { delta: true });
    const divergent = run.addCase(probeCase('p-color/d'), { delta: true });

    run.oracle.verdicts[worsened] = verdict(worsened, {
      base: 'different',
      head: 'different',
      transition: 'worsened',
    });
    run.oracle.verdicts[divergent] = verdict(divergent, {
      head: 'different',
      transition: 'regressed',
      perEngine: { chromium: ['equivalent', 'equivalent'] },
      summary: { divergent: true },
    });

    const evaluation = evaluateRun(run);

    assert.deepEqual(check(evaluation, 'O1').items, [divergent, worsened]);
    assert.equal(check(evaluation, 'O9').status, 'PASS');
  });

  test('an inert input with live output is named in O1', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-color/live'), { delta: true });

    run.oracle.verdicts[id] = verdict(id, {
      head: 'different',
      transition: 'regressed',
      perEngine: { firefox: ['equivalent', 'equivalent'] },
      summary: { inertLive: ['chromium', 'webkit'] },
    });

    const evaluation = evaluateRun(run);

    assert.deepEqual(check(evaluation, 'O1').items, [`${id} [input inert, output live in chromium, webkit]`]);
    assert.deepEqual(evaluation.open.get('O1'), check(evaluation, 'O1').items);
    assert.deepEqual(
      openSlots(evaluation).map((slot) => slot.id),
      [id],
    );
  });

  test('O3 counts only engines in the targets, and not rejections the input carried', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-color/rej', { targets: { chrome: 120 << 16 } }), { delta: true });
    const verdicts = verdict(id);
    const head = (/** @type {string} */ engine) => verdicts[0].latest[engine].variants.head;

    head('firefox').hardRejected = 1;
    run.oracle.verdicts[id] = verdicts;
    assert.equal(check(evaluateRun(run), 'O3').status, 'PASS');

    head('chromium').hardRejected = 1;
    assert.equal(check(evaluateRun(run), 'O3').status, 'FAIL');

    head('chromium').rejected = {
      decls: [
        { prop: 'animation-timeline', value: 'scroll()', fallbackSurvives: false, carrierRejected: true },
      ],
    };
    assert.equal(check(evaluateRun(run), 'O3').status, 'PASS');
  });

  test('differences outside the targets are ignored', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-color/lang', { mode: 'lower', targets: { safari: 12 << 16 } }), {
      delta: true,
    });

    run.oracle.verdicts[id] = verdict(id, {
      head: 'different',
      transition: 'regressed',
      perEngine: { webkit: ['equivalent', 'equivalent'] },
    });

    const o1 = check(evaluateRun(run), 'O1');

    assert.equal(o1.status, 'PASS');
    assert.ok(o1.evidence.includes('1 case(s) differ only in engines outside their targets'));
  });

  test('pre-existing behavior extended to new targets is a decision, not a regression', () => {
    using run = reportRun();
    const css = '.a{animation:x 1s scroll()}';

    run.addCase(
      {
        id: 't-base',
        source: 'tuple',
        side: 'base',
        test: 'tests::test_animation',
        helper: 'prefix_test',
        line: 1,
        request: { kind: 'sheet', css, minify: true, targets: { safari: 16 << 16 } },
      },
      { baseCode: 'split' },
    );

    const id = run.addCase(
      {
        id: 't-head',
        source: 'tuple',
        side: 'head',
        test: 'tests::test_animation',
        helper: 'prefix_test',
        line: 2,
        request: { kind: 'sheet', css, minify: true, targets: null },
      },
      { delta: true, baseCode: 'kept', headCode: 'split' },
    );

    run.oracle.verdicts[id] = verdict(id, { head: 'different', transition: 'regressed' });

    const evaluation = evaluateRun(run);

    assert.equal(check(evaluation, 'O1').status, 'PASS');
    assert.ok(check(evaluation, 'O10').items[0].includes('base test t-base already gives this output'));
    assert.equal(evaluation.extended.get(id), 't-base');
  });

  test('flag-only output that renders differently is O2', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-color/f', { flags: ['custom-functions'] }), { delta: true });

    run.addCase(probeCase('p-color/plain'));
    run.corpus.flag_only = { 'custom-functions': [id] };
    run.oracle.verdicts[id] = verdict(id, { base: 'unknown', head: 'different', transition: 'introduced' });

    assert.deepEqual(check(evaluateRun(run), 'O2').items, [id]);
  });

  test('cases classified REGRESSION keep the row FAIL without a finding of their own', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-color/r'), { delta: true });

    run.oracle.verdicts[id] = verdict(id, { head: 'different', transition: 'regressed' });
    run.analysis.deltas = [{ id, classification: 'REGRESSION', reason: 'drops the fallback' }];

    const o1 = check(evaluateRun(run), 'O1');

    assert.equal(o1.status, 'FAIL');
    assert.equal(o1.evidence, '1 case(s) classified REGRESSION (reported as findings)');
  });

  test('errored engine jobs outside the deltas are counted in O8', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-color/e'));

    run.oracle.verdicts[id] = verdict(id, {
      base: 'error',
      head: 'error',
      transition: 'errored',
      perEngine: Object.fromEntries(ENGINES.map((engine) => [engine, ['error', 'error']])),
    });

    assert.equal(
      check(evaluateRun(run), 'O8').evidence,
      '0 delta(s) verified or cleared; 1 errored engine job(s) outside the deltas',
    );
  });
});

describe('profiles and screenshots', () => {
  test('screenshot errors are reported in O6', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-color/x'), { delta: true });

    run.oracle.verdicts[id] = verdict(id, { summary: { visualErrors: ['webkit'] } });

    const o6 = check(evaluateRun(run), 'O6');

    assert.equal(o6.status, 'PASS');
    assert.ok(o6.evidence.includes('screenshot failed in webkit'));
  });

  test('O4 runs only with a legacy profile and lists legacy regressions', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-color/l'), { delta: true });

    run.oracle.verdicts[id] = verdict(id, {
      legacy: { 'legacy-2021': { base: 'equivalent', head: 'different', transition: 'regressed' } },
    });
    assert.equal(check(evaluateRun(run), 'O4').status, 'SKIP');

    run.oracle.profiles = { latest: { chromium: '1' }, 'legacy-2021': { chromium: '97' } };
    assert.deepEqual(check(evaluateRun(run), 'O4').items, [`${id}@legacy-2021`]);
  });

  test('every oracle check skips when the oracle did not run', () => {
    using run = reportRun();

    omitStage(run, 'oracle');

    const evaluation = evaluateRun(run);

    for (const id of ['O1', 'O2', 'O3', 'O4', 'O5', 'O6', 'O7', 'O8', 'O9', 'O10']) {
      assert.deepEqual(
        [check(evaluation, id).status, check(evaluation, id).evidence],
        ['SKIP', 'oracle stage did not run'],
      );
    }

    assert.deepEqual(evaluation.missingStages, ['oracle']);
  });

  test('a base test with the same targets does not make a regression a decision', () => {
    using run = reportRun();
    const targets = { safari: 16 << 16 };
    // The same sheet input as the probe's request, under the same targets.
    const request = { kind: 'sheet', css: '.t{color:red}', minify: true, compact: true, targets };

    run.addCase(
      {
        id: 't-base',
        source: 'tuple',
        side: 'both',
        test: 'tests::test_color',
        helper: 'minify_test',
        line: 1,
        request,
      },
      { baseCode: 'same' },
    );

    const id = run.addCase(probeCase('p-color/r', { targets }), {
      delta: true,
      baseCode: 'old',
      headCode: 'same',
    });

    run.oracle.verdicts[id] = verdict(id, { head: 'different', transition: 'regressed' });

    const evaluation = evaluateRun(run);

    assert.equal(check(evaluation, 'O1').status, 'FAIL');
    assert.equal(evaluation.extended.size, 0);
  });
});
