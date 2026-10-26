/**
 * R1 and R2, robustness.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { mutationCase, probeCase } from '../../../../test/helpers/synthetic-run.js';
import { check, evaluateRun, omitStage, reportRun } from '../../test/support.js';

describe('robustness', () => {
  test('R2 charges only new instability', () => {
    using run = reportRun();
    const a = run.addCase(probeCase('p-color/a'), { delta: true });
    const b = run.addCase(probeCase('p-color/b'), { delta: true });

    Object.assign(run.corpus, { idempotency_failures: [a], idempotency_preexisting: [b] });
    assert.deepEqual(check(evaluateRun(run), 'R2').items, [a]);

    run.corpus.idempotency_failures = [];

    const r2 = check(evaluateRun(run), 'R2');

    assert.deepEqual([r2.status, r2.severity], ['PARTIAL', 'NOTE']);
  });

  test('R1 fails new crashes and notes the ones base shares', () => {
    using run = reportRun();
    const a = run.addCase(probeCase('p-color/a'), { delta: true });

    run.corpus.robustness = { head: [{ id: a, source: 'probe', stage: 'panic', error: 'boom' }], base: [] };

    let r1 = check(evaluateRun(run), 'R1');

    assert.deepEqual([r1.status, r1.severity, r1.items], ['FAIL', 'BLOCKER', [`${a} panic: boom`]]);

    run.corpus.robustness.base = [{ id: a, source: 'probe', stage: 'panic', error: 'boom' }];
    r1 = check(evaluateRun(run), 'R1');

    assert.deepEqual(
      [r1.status, r1.severity, r1.evidence],
      ['PARTIAL', 'NOTE', '1 pre-existing (also on base)'],
    );
  });

  test('without a corpus both checks skip', () => {
    using run = reportRun();

    omitStage(run, 'corpus');

    const evaluation = evaluateRun(run);

    assert.equal(check(evaluation, 'R1').evidence, 'corpus stage did not run');
    assert.equal(check(evaluation, 'R2').evidence, 'corpus stage did not run');
  });

  test('R2 charges a mutation of a probe, not one of an unchanged test case', () => {
    using run = reportRun();
    const probe = run.addCase(probeCase('p-color/c', { origin: 'curated' }));
    const tuple = run.addCase({
      id: 't-0000000000000001',
      source: 'tuple',
      side: 'both',
      test: 'tests::test_color',
      helper: 'minify_test',
      line: 1,
      request: { kind: 'sheet', css: 'a{}', minify: true },
    });
    const ofProbe = run.addCase(mutationCase(probe, 'nest'));
    const ofTuple = run.addCase(mutationCase(tuple, 'nest'));

    run.corpus.idempotency_failures = [ofProbe, ofTuple];

    assert.deepEqual(check(evaluateRun(run), 'R2').items, [ofProbe]);
  });
});
