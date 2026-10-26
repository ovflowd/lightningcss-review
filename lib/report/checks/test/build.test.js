/**
 * B1-B11, build checks: the suite, lanes and CI checks.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { writeFiles } from '../../../../test/helpers/index.js';
import { check, evaluateRun, omitStage, reportRun } from '../../test/support.js';

describe('build checks', () => {
  test('B11 compares drift with base (a diff of diffs)', () => {
    using run = reportRun();

    run.build.js = {
      ran: true,
      regen_ast: true,
      drift: { 'node/ast.d.ts': 'h1' },
      base_drift: { 'node/ast.d.ts': 'h1' },
    };
    assert.equal(check(evaluateRun(run), 'B11').status, 'PARTIAL');

    run.build.js.drift = { 'node/ast.d.ts': 'h2' };
    assert.equal(check(evaluateRun(run), 'B11').status, 'FAIL');
  });

  test('B1 separates tests failing on head only from pre-existing failures', () => {
    using run = reportRun();

    run.write();
    writeFiles(run.dir, {
      'build/head/tests.json': { tests: { 'a::x': 'failed', 'a::y': 'failed', 'a::z': 'ok' } },
      'build/base/tests.json': { tests: { 'a::x': 'failed' } },
    });

    let b1 = check(evaluateRun(run), 'B1');

    assert.deepEqual([b1.status, b1.items], ['FAIL', ['a::y']]);

    writeFiles(run.dir, { 'build/base/tests.json': { tests: { 'a::x': 'failed', 'a::y': 'failed' } } });
    b1 = check(evaluateRun(run), 'B1');
    assert.deepEqual([b1.status, b1.severity], ['PARTIAL', 'NOTE']);
  });

  test('lanes fail on head only; a lane failing on base too is a note', () => {
    using run = reportRun();

    run.build.head.lanes = {
      selectors: { exit: 101, seconds: 2, errors: [], tail: 'x'.repeat(500) },
      'wasm-check': { exit: 0, seconds: 3, errors: [], tail: '' },
      'c-bindings': { exit: 1, seconds: 1, errors: ['error: c'], tail: '' },
    };
    run.build.base.lanes = { selectors: { exit: 101, seconds: 1, errors: [], tail: '' } };

    const evaluation = evaluateRun(run);

    assert.deepEqual(
      [check(evaluation, 'B7').status, check(evaluation, 'B7').items],
      ['PARTIAL', ['x'.repeat(300)]],
    );
    assert.deepEqual(
      [check(evaluation, 'B8').status, check(evaluation, 'B8').evidence],
      ['SKIP', 'lane not run'],
    );
    assert.deepEqual([check(evaluation, 'B9').status, check(evaluation, 'B9').evidence], ['PASS', '3s']);
    assert.deepEqual(
      [check(evaluation, 'B10').status, check(evaluation, 'B10').items],
      ['FAIL', ['error: c']],
    );
  });

  test('B6 reports failing, then pending CI checks', () => {
    using run = reportRun();

    run.prep.ci_checks = [
      { name: 'test', bucket: 'pass' },
      { name: 'lint', bucket: 'pending' },
    ];
    assert.deepEqual(
      [check(evaluateRun(run), 'B6').status, check(evaluateRun(run), 'B6').evidence],
      ['PARTIAL', 'pending: lint'],
    );

    run.prep.ci_checks.push({ name: 'wasm', bucket: 'fail' });
    assert.equal(check(evaluateRun(run), 'B6').evidence, 'failing: wasm');
  });

  test('without build.json the build checks skip', () => {
    using run = reportRun();

    omitStage(run, 'build');

    const evaluation = evaluateRun(run);

    assert.equal(check(evaluation, 'B1').evidence, 'build stage did not run');
    assert.equal(check(evaluation, 'B7').evidence, 'not evaluated (stage missing)');
    assert.equal(check(evaluation, 'B5').evidence, 'bindings not touched');
    assert.ok(evaluation.missingStages.includes('build'));
    assert.ok(join(run.dir, 'build.json'));
  });
});
