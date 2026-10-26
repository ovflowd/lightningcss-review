/**
 * T1-T5, the PR's tests.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { probeCase, verdict } from '../../../../test/helpers/synthetic-run.js';
import { check, evaluateRun, reportRun } from '../../test/support.js';

describe('test checks', () => {
  test('T2 splits new cases from changed expectations; unmappable in-diff cases make T5 MAJOR', () => {
    using run = reportRun();

    run.corpus.tuples = {
      new_failing_on_base: [{ id: 't-mod', test: 'tests::test_color', line: 3 }],
      new_passing_on_base: [{ id: 't-new', test: 'tests::test_color', line: 4 }],
      modified: [{ id: 't-old', head_id: 't-mod', test: 'tests::test_color', line: 2, head_line: 3 }],
    };

    let evaluation = evaluateRun(run);

    assert.equal(check(evaluation, 'T2').status, 'FAIL');
    assert.ok(check(evaluation, 'T2').evidence.includes('1 changed expectation(s) (T3)'));

    run.corpus.tuple_stats = {
      unmappable_cases: [
        {
          test: 'tests::test_color',
          line: 5,
          helper: 'minify_test',
          side: 'head',
          in_diff: true,
          reason: 'unknown flag',
        },
      ],
    };
    evaluation = evaluateRun(run);

    assert.equal(check(evaluation, 'T2').status, 'PARTIAL');
    assert.deepEqual(
      [check(evaluation, 'T5').status, check(evaluation, 'T5').severity],
      ['PARTIAL', 'MAJOR'],
    );
  });

  test('T1 fails on the no-tests risk flag', () => {
    using run = reportRun();

    run.prep.risk_flags = [{ id: 'no-tests', detail: 'src/ changed without tests', paths: [] }];

    assert.deepEqual(
      [check(evaluateRun(run), 'T1').status, check(evaluateRun(run), 'T1').evidence],
      ['FAIL', 'src/ changed without tests'],
    );
  });

  test('T3 fails a changed expectation the browsers find different, T4 a removed one', () => {
    using run = reportRun();

    run.corpus.tuples = {
      modified: [{ id: 't-old', head_id: 't-mod', test: 'tests::test_color', line: 2, head_line: 3 }],
      removed_changed: [{ id: 't-gone', test: 'tests::test_x', line: 9 }],
    };
    run.oracle.verdicts['t-mod'] = verdict('t-mod', { head: 'different', transition: 'introduced' });

    const evaluation = evaluateRun(run);

    assert.deepEqual(check(evaluation, 'T3').items, ['tests::test_color lib.rs:3 (t-mod)']);
    assert.deepEqual(
      [check(evaluation, 'T4').status, check(evaluation, 'T4').items],
      ['FAIL', ['tests::test_x lib.rs:9']],
    );
  });

  test('T5 notes expectations the adapter does not reproduce', () => {
    using run = reportRun();

    run.corpus.tuples = { head_mismatch: [{ id: 't-h', test: 'tests::test_y', line: 10 }] };
    run.corpus.tuple_stats = { head_tuples: 3, unmappable_helpers: ['foo_test'] };

    const t5 = check(evaluateRun(run), 'T5');

    assert.deepEqual(
      [t5.status, t5.severity, t5.evidence],
      [
        'PARTIAL',
        'NOTE',
        '1 recorded expectation(s) not reproduced by the adapter; excluded from conclusions; unmappable helpers: foo_test',
      ],
    );
  });

  test('T3 cannot verify a changed expectation no engine covers', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-color/t'), { delta: true });

    run.corpus.tuples = {
      modified: [{ id: 't-old', head_id: id, test: 'tests::test_color', line: 2, head_line: 3 }],
    };
    run.oracle.verdicts[id] = verdict(id, {
      base: 'different',
      head: 'no-coverage',
      transition: 'still-different',
    });

    const t3 = check(evaluateRun(run), 'T3');

    assert.deepEqual(
      [t3.status, t3.evidence, t3.items],
      [
        'PARTIAL',
        '1 changed expectation(s) could not be verified in browsers',
        [`tests::test_color lib.rs:3 (${id})`],
      ],
    );
  });
});
