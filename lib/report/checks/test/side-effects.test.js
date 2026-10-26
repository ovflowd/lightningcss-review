/**
 * S1-S3, side effects (py-final tests/test_report.py SideEffectTest).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { probeCase, verdict } from '../../../../test/helpers/synthetic-run.js';
import { check, evaluateRun, reportRun } from '../../test/support.js';

describe('side effects', () => {
  test('S1 accepts the areas the tests touch', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-selectors/x', { area: 'selectors' }), { delta: true });

    run.oracle.verdicts[id] = verdict(id, {
      base: 'different',
      head: 'different',
      transition: 'still-different',
    });
    assert.equal(check(evaluateRun(run), 'S1').status, 'FAIL');

    run.prep.test_areas = ['selectors'];
    assert.equal(check(evaluateRun(run), 'S1').status, 'PASS');
  });

  test('S1 accepts an outside delta the browsers verify equivalent everywhere', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-selectors/x', { area: 'selectors' }), { delta: true });

    run.oracle.verdicts[id] = verdict(id);

    const s1 = check(evaluateRun(run), 'S1');

    assert.equal(s1.status, 'PASS');
    assert.equal(
      s1.evidence,
      'touched areas: color; 1 outside delta(s) verified equivalent in every engine (accepted)',
    );
  });

  test('S2 sums lower-minify output too', () => {
    using run = reportRun();

    run.corpus.size = [
      { name: 'a', mode: 'minify', base: 1000, head: 1000 },
      { name: 'a', mode: 'lower-minify', base: 1000, head: 1100 },
    ];

    const s2 = check(evaluateRun(run), 'S2');

    assert.equal(s2.status, 'FAIL');
    assert.ok(s2.evidence.includes('lower-minify total 1000 -> 1100'));
    assert.equal(
      s2.evidence,
      'minified total 1000 -> 1000 bytes (+0.000%); lower-minify total 1000 -> 1100 bytes (+10.000%)',
    );
  });

  test('S3 flags possible duplicates', () => {
    using run = reportRun();

    run.prep.pr = { author: 'me', number: 2 };
    run.prep.overlapping_prs = [
      { number: 1, title: 'same fix', author: 'me', shared_files: ['src/x.rs'] },
      { number: 3, title: 'other', author: 'you', shared_files: ['src/x.rs'] },
    ];

    const s3 = check(evaluateRun(run), 'S3');

    assert.ok(s3.evidence.includes('possible duplicate of #1'));
    assert.ok(s3.items[0].startsWith('#1 same fix: possible duplicate (same author'));
  });

  test('S1 does not accept an outside delta a legacy engine still renders differently', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-nesting/x', { area: 'nesting' }), { delta: true });
    const legacy = (/** @type {boolean} */ neutral) => ({
      'legacy-2021': { base: 'different', head: 'different', transition: 'still-different', neutral },
    });

    run.oracle.verdicts[id] = verdict(id, { legacy: legacy(true) });
    assert.equal(check(evaluateRun(run), 'S1').status, 'PASS');

    run.oracle.verdicts[id] = verdict(id, { legacy: legacy(false) });

    const s1 = check(evaluateRun(run), 'S1');

    assert.deepEqual([s1.status, s1.items], ['FAIL', [`${id} [nesting]`]]);
  });
});
