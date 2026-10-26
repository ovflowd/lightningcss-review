/**
 * A3, the analysis completeness and evidence rules.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { probeCase, SPEC, verdict } from '../../../../test/helpers/synthetic-run.js';
import { ELLIPSIS } from '../../glyphs.js';
import { check, evaluateRun, ITEM, omitStage, reportRun } from '../../test/support.js';

describe('classifications', () => {
  test('a divergent case is cleared by an exact id with a spec citation', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-color/x'), { delta: true });

    run.oracle.verdicts[id] = verdict(id, {
      base: 'different',
      head: 'different',
      transition: 'still-different',
      perEngine: { chromium: ['different', 'equivalent'], webkit: ['different', 'equivalent'] },
      summary: { divergent: true },
    });

    let evaluation = evaluateRun(run);

    assert.equal(check(evaluation, 'O9').status, 'FAIL');
    assert.ok(
      check(evaluation, 'O9').items[0].includes(
        'p-color/x [head equivalent in chromium, webkit; different in firefox; base different in',
      ),
    );

    run.analysis.deltas = [{ id, classification: 'ORACLE_NOISE', reason: `firefox lags the spec ${SPEC}` }];
    evaluation = evaluateRun(run);

    assert.equal(check(evaluation, 'O9').status, 'PASS');
    assert.equal(check(evaluation, 'A3').status, 'PASS');
  });

  test('a glob clearing a regression needs a spec citation and an exact id', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-color/x'), { delta: true });

    run.oracle.verdicts[id] = verdict(id, { head: 'different', transition: 'regressed' });
    run.analysis.deltas = [{ id: 'p-color/*', classification: 'INTENDED', reason: 'on purpose' }];

    const evidence = check(evaluateRun(run), 'A3').evidence;

    assert.ok(evidence.includes('must cite the spec'));
    assert.ok(evidence.includes('a glob may not clear regressed case(s)'));
  });

  test('a catch-all glob must cover cases of one transition', () => {
    using run = reportRun();

    for (const [index, transition] of ['both-equivalent', 'fixed'].entries()) {
      const id = run.addCase(
        {
          id: `w-${index.toString(16).padStart(8, '0')}`,
          source: 'wpt',
          wpt: { property: 'color', file: 'f', value: 'v', kind: 'valid' },
          mode: 'minify',
          request: { kind: 'property' },
        },
        { delta: true },
      );

      run.oracle.verdicts[id] = verdict(id, {
        base: transition === 'fixed' ? 'different' : 'equivalent',
        transition,
      });
    }

    run.analysis.deltas = [{ id: 'w-*', classification: 'INTENDED', reason: 'fine' }];

    assert.ok(check(evaluateRun(run), 'A3').evidence.includes('catch-all'));
  });

  test('REGRESSION is rejected where base is wrong in every engine head is', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-color/s'), { delta: true });

    run.oracle.verdicts[id] = verdict(id, {
      base: 'different',
      head: 'different',
      transition: 'still-different',
      perEngine: {
        chromium: ['equivalent', 'equivalent'],
        firefox: ['different', 'different'],
        webkit: ['equivalent', 'equivalent'],
      },
    });
    run.analysis.deltas = [{ id, classification: 'REGRESSION', reason: 'worse' }];

    assert.ok(
      check(evaluateRun(run), 'A3').evidence.includes(
        'base is wrong in every engine where head is (firefox)',
      ),
    );
  });

  test('REGRESSION needs one engine where only head is wrong', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-color/s'), { delta: true });

    run.oracle.verdicts[id] = verdict(id, {
      base: 'different',
      head: 'different',
      transition: 'still-different',
      perEngine: {
        chromium: ['equivalent', 'different'],
        firefox: ['different', 'different'],
        webkit: ['equivalent', 'equivalent'],
      },
    });
    run.analysis.deltas = [{ id, classification: 'REGRESSION', reason: 'worse' }];

    assert.ok(!check(evaluateRun(run), 'A3').evidence.includes('REGRESSION on'));
  });

  test('REGRESSION on both-equivalent cases is a warning', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-color/e'), { delta: true });

    run.oracle.verdicts[id] = verdict(id);
    run.analysis.deltas = [{ id: 'p-color/*', classification: 'REGRESSION', reason: 'x' }];

    const a3 = check(evaluateRun(run), 'A3');

    assert.equal(a3.status, 'PARTIAL');
    assert.ok(a3.evidence.includes('both-equivalent'));
  });

  test('PRE_EXISTING needs a citation and base wrong, and not on a case base gets right', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-color/p'), { delta: true });
    const curated = run.addCase(probeCase('p-color/curated', { origin: 'curated' }));

    run.oracle.verdicts[id] = verdict(id, { head: 'different', transition: 'regressed' });
    run.analysis.deltas = [{ id, classification: 'PRE_EXISTING', reason: 'same as before' }];

    const evidence = check(evaluateRun(run), 'A3').evidence;

    assert.ok(
      evidence.includes(
        'PRE_EXISTING needs evidence that base is wrong the same way: an issue (`open-issue#N`',
      ),
    );
    assert.ok(
      evidence.includes(
        `a base tuple (\`t-${ELLIPSIS}\`) whose base output matches its recorded expectation`,
      ),
    );
    assert.ok(evidence.includes('base renders equivalent in every engine'));

    run.oracle.verdicts[id] = verdict(id, {
      base: 'different',
      head: 'different',
      transition: 'still-different',
    });
    run.corpus.probes = [
      {
        id: curated,
        probe: curated.slice(2),
        origin: 'curated',
        known: 'open-bug',
        changed: false,
        assert: { base: { 'output-contains:"a"': false }, head: { 'output-contains:"a"': false } },
      },
    ];
    run.analysis.deltas = [{ id, classification: 'PRE_EXISTING', reason: `base fails too, see ${curated}` }];

    const evaluation = evaluateRun(run);

    assert.equal(check(evaluation, 'A3').status, 'PASS');
    assert.deepEqual(
      evaluation.findings.filter((finding) => finding.evidence.includes(id)),
      [],
    );
  });

  test('PRE_EXISTING accepts a base tuple whose base output matches its expectation', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-color/p'), { delta: true });

    run.oracle.verdicts[id] = verdict(id);

    const withTuple = (
      /** @type {string} */ tupleId,
      /** @type {string} */ side,
      /** @type {string} */ baseCode,
    ) => {
      run.addCase(
        {
          id: tupleId,
          source: 'tuple',
          side,
          test: 'tests::test_color',
          helper: 'minify_test',
          line: 1,
          expectation: { type: 'code', code: '.a{color:red}' },
          request: { kind: 'sheet', css: '.a{color:red}', minify: true },
        },
        { baseCode },
      );
      run.analysis.deltas = [
        { id, classification: 'PRE_EXISTING', reason: `base already prints this, see ${tupleId}` },
      ];

      return check(evaluateRun(run), 'A3');
    };

    assert.equal(withTuple('t-0000000000000001', 'both', '.a{color:red}').status, 'PASS');
    assert.equal(withTuple('t-0000000000000002', 'base', '.a{color:red}').status, 'PASS');
    assert.ok(
      withTuple('t-0000000000000003', 'both', '.a{color:blue}').evidence.includes(
        'PRE_EXISTING needs evidence',
      ),
    );
    assert.ok(
      withTuple('t-0000000000000004', 'head', '.a{color:red}').evidence.includes(
        'PRE_EXISTING needs evidence',
      ),
    );
  });

  test('an empty slot that matches no open case is stale and ignored', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-color/reg'), { delta: true });

    run.oracle.verdicts[id] = verdict(id, { head: 'different', transition: 'regressed' });
    run.analysis.deltas = [
      { id: 'p-color/gone', classification: '', reason: '' },
      { id, classification: '', reason: '' },
    ];

    const evidence = check(evaluateRun(run), 'A3').evidence;

    assert.ok(evidence.includes('1 open delta slot(s) not classified: p-color/reg'));
    assert.ok(!evidence.includes('p-color/gone'));
  });

  test('an invalid classification and unknown finding links are reported', () => {
    using run = reportRun();

    run.analysis.deltas = [{ id: 'p-x', classification: 'BOGUS', reason: 'r', finding: 'F9' }];
    run.analysis.checklist = [{ item: 'COLOR-01', answer: 'PASS', evidence: 'x', finding: 'F2' }];
    run.analysis.findings = [
      { id: 'F1', severity: 'NOTE', title: 'a', evidence: ['x'] },
      { id: 'F1', severity: 'MAJOR', title: 'b', evidence: [] },
    ];

    const items = check(evaluateRun(run, [ITEM]), 'A3').items;

    assert.ok(items.includes('delta classification invalid: p-x'));
    assert.ok(items.includes('analysis finding ids are not unique'));
    assert.ok(items.includes('finding without severity/title/evidence: b'));
    assert.ok(items.includes('COLOR-01: links unknown finding F2'));
    assert.ok(items.includes('p-x: links unknown finding F9'));
  });
});

describe('incomplete analysis', () => {
  test('an empty analysis is inconclusive', () => {
    using run = reportRun();

    run.analysis = { intent: { kind: '', summary: '' }, checklist: [], deltas: [], findings: [] };

    const evaluation = evaluateRun(run);

    assert.equal(check(evaluation, 'A3').status, 'FAIL');
    assert.equal(evaluation.verdict, 'INCONCLUSIVE');
  });

  test('a proven blocker survives an incomplete analysis', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-color/reg'), { delta: true });

    run.oracle.verdicts[id] = verdict(id, { head: 'different', transition: 'regressed' });
    run.analysis = { intent: { kind: '', summary: '' }, checklist: [], deltas: [], findings: [] };

    assert.equal(evaluateRun(run).verdict, 'UNSAFE');
  });

  test('a missing analysis.json skips A3 and leaves the verdict inconclusive', () => {
    using run = reportRun();

    omitStage(run, 'analysis');

    const evaluation = evaluateRun(run);

    assert.equal(check(evaluation, 'A3').status, 'SKIP');
    assert.deepEqual(evaluation.incomplete, ['analysis.json missing']);
    assert.equal(evaluation.verdict, 'INCONCLUSIVE');
  });

  test('PRE_EXISTING accepts a case that crashes on base as evidence', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-color/p'), { delta: true });
    const crash = run.addCase(probeCase('p-color/crash'));

    run.oracle.verdicts[id] = verdict(id);
    run.analysis.deltas = [{ id, classification: 'PRE_EXISTING', reason: `base crashes too: ${crash}` }];

    assert.equal(check(evaluateRun(run), 'A3').status, 'FAIL');

    run.corpus.robustness = {
      head: [],
      base: [{ id: crash, source: 'probe', stage: 'panic', error: 'boom' }],
    };

    assert.equal(check(evaluateRun(run), 'A3').status, 'PASS');
  });

  test('a clearing classification without a citation is reported once per entry', () => {
    using run = reportRun();
    const ids = [0, 1].map((index) => run.addCase(probeCase(`p-color/r${index}`), { delta: true }));

    for (const id of ids) {
      run.oracle.verdicts[id] = verdict(id, { head: 'different', transition: 'regressed' });
    }

    run.analysis.deltas = [{ id: ids[0], classification: 'INTENDED', reason: 'on purpose' }];
    run.analysis.deltas.push({ ...run.analysis.deltas[0], id: ids[1] });

    const cites = (/** @type {string[]} */ items) =>
      items.filter((item) => item.includes('classification must cite the spec')).length;

    assert.equal(cites(check(evaluateRun(run), 'A3').items), 2);

    run.analysis.deltas = [{ id: 'p-color/r*', classification: 'INTENDED', reason: 'on purpose' }];

    assert.equal(cites(check(evaluateRun(run), 'A3').items), 1);
  });
});
