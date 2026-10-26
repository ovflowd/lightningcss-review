/**
 * report.md section 4 (render-delta.js): which deltas each group lists and why. Byte layout is
 * covered by the frozen report fixtures in report.test.js.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { probeCase, verdict } from '../../../test/helpers/synthetic-run.js';
import { EM_DASH } from '../glyphs.js';
import { renderDelta } from '../render-delta.js';
import { evaluateRun, reportRun } from './support.js';

const LIMITS = { snippet: 600, cap: 12 };

describe('behavioral delta', () => {
  test('4.5 says why each delta is unverified and shows its classification', () => {
    using run = reportRun();
    const notRun = run.addCase(probeCase('p-color/a'), { delta: true });
    const errored = run.addCase(probeCase('p-color/b'), { delta: true });
    const unverified = run.addCase(probeCase('p-color/c'), { delta: true });

    run.oracle.verdicts[errored] = verdict(errored, { base: 'error', head: 'error', transition: 'errored' });
    run.oracle.verdicts[unverified] = verdict(unverified, { transition: 'unverified' });
    run.analysis.deltas = [{ id: notRun, classification: 'INTENDED', reason: 'new output' }];

    const lines = renderDelta(evaluateRun(run), run.dir, LIMITS);
    const at = lines.indexOf('### 4.5 Deltas the oracle could not verify (3)');

    assert.deepEqual(lines.slice(at + 2, at + 5), [
      `- \`${notRun}\` (not run) probe \`color/a\` (pr): t ${EM_DASH} **INTENDED**: new output`,
      `- \`${errored}\` (errored) probe \`color/b\` (pr): t ${EM_DASH} unclassified`,
      `- \`${unverified}\` (unverified) probe \`color/c\` (pr): t ${EM_DASH} unclassified`,
    ]);
  });

  test('4.6 lists rejected inputs, extended behavior and maintainer decisions; 4.7 pre-existing', () => {
    using run = reportRun();
    const rejected = run.addCase(probeCase('p-color/r'), { delta: true });
    const decided = run.addCase(probeCase('p-color/d'), { delta: true });
    const pre = run.addCase(probeCase('p-color/p'), { delta: true });

    run.oracle.verdicts[rejected] = verdict(rejected, { head: 'different', transition: 'input-rejected' });
    run.analysis.deltas = [
      { id: decided, classification: 'NEEDS_MAINTAINER_DECISION', reason: 'policy' },
      { id: pre, classification: 'PRE_EXISTING', reason: 'base too, open-issue#1' },
    ];

    const lines = renderDelta(evaluateRun(run), run.dir, LIMITS);
    const decision = lines.indexOf('### 4.6 Decision needed (2)');
    const preExisting = lines.indexOf('### 4.7 Pre-existing (base wrong the same way) (1)');

    assert.deepEqual(lines.slice(decision + 4, decision + 6), [
      `- \`${decided}\` (classified) ${EM_DASH} **NEEDS_MAINTAINER_DECISION**: policy`,
      `- \`${rejected}\` (input rejected in every engine) ${EM_DASH} unclassified`,
    ]);
    assert.equal(lines[preExisting + 2], `- \`${pre}\` ${EM_DASH} base too, open-issue#1`);
  });
});
