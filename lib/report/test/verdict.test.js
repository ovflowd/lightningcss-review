/**
 * The verdict rules and the opt-in scope (py-final tests/test_report.py
 * TransitionTest.test_flag_only_pr_introduced_cases_and_scope, plus the count rules).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { mutationCase, probeCase, verdict } from '../../../test/helpers/synthetic-run.js';
import { decideVerdict, verdictLine } from '../verdict.js';
import { evaluateRun, reportRun } from './support.js';

/** @import { CheckRow } from '../../types.js' */

const NONE = { BLOCKER: 0, MAJOR: 0, MINOR: 0, NOTE: 0 };

describe('verdict', () => {
  test('the worst severity decides', () => {
    const state = { missingStages: [], checks: [], incomplete: [] };

    assert.equal(decideVerdict({ ...NONE, BLOCKER: 1, MAJOR: 2 }, state), 'UNSAFE');
    assert.equal(decideVerdict({ ...NONE, MAJOR: 1 }, state), 'NEEDS_CHANGES');
    assert.equal(decideVerdict({ ...NONE, MINOR: 1, NOTE: 3 }, state), 'SAFE_WITH_NITS');
    assert.equal(decideVerdict({ ...NONE, NOTE: 3 }, state), 'SAFE');
  });

  test('a missing stage or an inconclusive check replaces only a safe verdict', () => {
    const inconclusive = /** @type {CheckRow[]} */ ([{ id: 'O8', status: 'INCONCLUSIVE' }]);

    assert.equal(
      decideVerdict({ ...NONE, MINOR: 1 }, { missingStages: ['oracle'], checks: [], incomplete: [] }),
      'INCONCLUSIVE',
    );
    assert.equal(
      decideVerdict(NONE, { missingStages: [], checks: inconclusive, incomplete: [] }),
      'INCONCLUSIVE',
    );
    assert.equal(
      decideVerdict(
        { ...NONE, MAJOR: 1 },
        { missingStages: ['oracle'], checks: inconclusive, incomplete: [] },
      ),
      'NEEDS_CHANGES',
    );
  });

  test('an incomplete analysis leaves only UNSAFE', () => {
    const state = { missingStages: [], checks: [], incomplete: ['intent.summary/kind'] };

    assert.equal(decideVerdict({ ...NONE, MAJOR: 1 }, state), 'INCONCLUSIVE');
    assert.equal(decideVerdict({ ...NONE, BLOCKER: 1 }, state), 'UNSAFE');
  });

  test('the verdict line carries the scope', () => {
    assert.equal(verdictLine('SAFE', null), 'SAFE');
    assert.equal(
      verdictLine('UNSAFE', { flags: ['x'], default_requests: 1, text: 'flag x only' }),
      'UNSAFE (flag x only)',
    );
  });
});

describe('scope', () => {
  test('a flag-only PR is scoped to its flag', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-color/f', { flags: ['custom-functions'] }), { delta: true });

    run.addCase(probeCase('p-color/plain'));
    run.corpus.flag_only = { 'custom-functions': [id] };
    run.oracle.verdicts[id] = verdict(id, { base: 'unknown', head: 'different', transition: 'introduced' });

    assert.deepEqual(evaluateRun(run).scope, {
      flags: ['custom-functions'],
      default_requests: 1,
      text: 'flag custom-functions only',
    });
  });

  test('mutations of flagged cases count as flagged; one unflagged delta drops the scope', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-color/f'), { delta: true });

    run.addCase(mutationCase(id, 'wrap'), { delta: true });
    run.corpus.flag_only = { nesting: [id] };
    assert.equal(evaluateRun(run).scope?.default_requests, 0);

    run.addCase(probeCase('p-color/g'), { delta: true });
    assert.equal(evaluateRun(run).scope, null);
  });
});
