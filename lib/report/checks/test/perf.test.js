/**
 * P1 and P2, performance, including stale perf data.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { writeFiles } from '../../../../test/helpers/index.js';
import { pyFloat } from '../../../core/pyjson.js';
import { check, evaluateRun, reportRun } from '../../test/support.js';

describe('perf checks', () => {
  test('stale release binaries skip P1 and P2', () => {
    using run = reportRun();

    run.write();
    writeFiles(run.dir, {
      'perf.json': {
        skip_reason: 'head release binary behaves like base',
        total_ratio: null,
        slower_share: 0,
        binary_ratio: pyFloat(1),
      },
    });

    const evaluation = evaluateRun(run);

    for (const id of ['P1', 'P2']) {
      assert.deepEqual(
        [check(evaluation, id).status, check(evaluation, id).evidence],
        ['SKIP', 'head release binary behaves like base'],
      );
    }
  });

  test('a slower real-world total fails P1 and lists the slowest files', () => {
    using run = reportRun();

    run.write();
    writeFiles(run.dir, {
      'perf.json': {
        repeats: 5,
        binary_bytes: { base: 100, head: 120 },
        binary_ratio: 1.2,
        total_ms: { base: 12.5, head: pyFloat(15) },
        total_ratio: 1.2,
        slower_share: 0.75,
        failed_files: [],
        files: [
          { name: 'a', base_ms: 1, head_ms: 1.2, ratio: 1.2 },
          { name: 'b', base_ms: 1, head_ms: 1, ratio: null },
          { name: 'c', base_ms: 1, head_ms: 1.3, ratio: 1.3 },
        ],
      },
    });

    const evaluation = evaluateRun(run);
    const p1 = check(evaluation, 'P1');

    assert.equal(p1.status, 'FAIL');
    assert.equal(
      p1.evidence,
      'real-world total 12.5ms -> 15.0ms (x1.2); 75% of files >5% slower; median of 5',
    );
    assert.deepEqual(p1.items, ['c: x1.3', 'a: x1.2', 'b: xNone']);
    assert.deepEqual(
      [check(evaluation, 'P2').status, check(evaluation, 'P2').evidence],
      ['FAIL', 'release CLI 100 -> 120 bytes (x1.2)'],
    );
  });

  test('without perf.json both checks skip as optional', () => {
    using run = reportRun();

    assert.equal(
      check(evaluateRun(run), 'P1').evidence,
      'optional: run `lcr perf` for core/hot-path changes',
    );
  });
});
