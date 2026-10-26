/**
 * T6, probe assertions.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { probeCase, verdict } from '../../../../test/helpers/synthetic-run.js';
import { check, evaluateRun, ITEM, reportRun } from '../../test/support.js';

/** @import { ReportRun } from '../../test/support.js' */

/**
 * A PR probe whose assertion holds on base and fails on head while the oracle finds base and head
 * both wrong (base wrong another way).
 *
 * @param {ReportRun} run
 * @returns {string}
 */
function brokenByAnotherBaseBug(run) {
  const id = run.addCase(probeCase('p-color/a'), { delta: true });

  run.oracle.verdicts[id] = verdict(id, {
    base: 'different',
    head: 'different',
    transition: 'still-different',
  });
  run.corpus.probes = [
    {
      id,
      probe: id.slice(2),
      origin: 'pr',
      known: 'none',
      changed: true,
      assert: { base: { 'output-not-contains:" or "': true }, head: { 'output-not-contains:" or "': false } },
    },
  ];

  return id;
}

describe('probe assertions', () => {
  test('an assertion broken by head fails T6; one head fixes is credited', () => {
    using run = reportRun();
    const a = run.addCase(probeCase('p-color/a'), { delta: true });
    const b = run.addCase(probeCase('p-color/b', { origin: 'curated', known: 'open-bug' }), { delta: true });

    run.corpus.probes = [
      {
        id: a,
        probe: a.slice(2),
        origin: 'pr',
        known: 'none',
        changed: true,
        assert: { base: { 'output-not-contains:"x"': true }, head: { 'output-not-contains:"x"': false } },
      },
      {
        id: b,
        probe: b.slice(2),
        origin: 'curated',
        known: 'open-bug',
        changed: true,
        assert: { base: { idempotent: null }, head: { idempotent: null } },
      },
    ];
    run.corpus.idempotency = { [b]: { stable: true } };
    run.corpus.idempotency_base = { [b]: { stable: false } };

    const evaluation = evaluateRun(run);
    const t6 = check(evaluation, 'T6');

    assert.deepEqual([t6.status, t6.severity], ['FAIL', 'MAJOR']);
    assert.deepEqual(t6.items, [`${a}: output-not-contains:"x" (holds on base, fails on head)`]);
    assert.deepEqual(evaluation.probeFixed, [`${b}: idempotent`]);
  });

  test('a PRE_EXISTING classification naming the probe makes T6 a note', () => {
    using run = reportRun();
    const a = brokenByAnotherBaseBug(run);

    run.analysis.findings = [
      { id: 'F1', severity: 'NOTE', title: 'Base drops the conjunct, head turns it into or', evidence: [a] },
    ];
    run.analysis.deltas = [
      {
        id: a,
        classification: 'PRE_EXISTING',
        reason: 'base drops the and conjunct; both wrong in the same engines',
        evidence: `${a} is still-different`,
        finding: 'F1',
      },
    ];

    const evaluation = evaluateRun(run);
    const t6 = check(evaluation, 'T6');

    assert.deepEqual([t6.status, t6.severity], ['PARTIAL', 'NOTE']);
    assert.deepEqual(t6.items, [
      `${a}: output-not-contains:" or " (holds on base, fails on head; base is wrong another way per PRE_EXISTING ${a})`,
    ]);
    assert.ok(t6.evidence.includes('hold on base only because base is wrong another way'));
    assert.equal(check(evaluation, 'A3').status, 'PASS');
    assert.deepEqual(
      evaluation.findings.map((finding) => [finding.id, finding.severity]),
      [['F1', 'NOTE']],
    );
    assert.equal(evaluation.verdict, 'SAFE');
  });

  test('a FAIL_PRE_EXISTING answer, or the finding it links, makes T6 a note', () => {
    using run = reportRun();
    const a = brokenByAnotherBaseBug(run);

    run.analysis.checklist = [
      { item: 'COLOR-01', answer: 'FAIL_PRE_EXISTING', evidence: `base is wrong too: ${a}` },
    ];

    let t6 = check(evaluateRun(run, [ITEM]), 'T6');

    assert.deepEqual([t6.status, t6.severity], ['PARTIAL', 'NOTE']);
    assert.ok(t6.items[0].includes('per FAIL_PRE_EXISTING COLOR-01'));

    // An answer to an item outside this run's checklist is never validated, so it clears nothing.
    assert.equal(check(evaluateRun(run), 'T6').severity, 'MAJOR');

    const other = run.addCase(probeCase('p-color/other'), { delta: true });

    run.oracle.verdicts[other] = verdict(other, {
      base: 'different',
      head: 'different',
      transition: 'still-different',
    });
    run.analysis.checklist = [];
    run.analysis.findings = [
      { id: 'F1', severity: 'NOTE', title: 'Pre-existing merge bug', evidence: [a, other] },
    ];
    run.analysis.deltas = [
      { id: other, classification: 'PRE_EXISTING', reason: 'base wrong the same way', finding: 'F1' },
    ];
    t6 = check(evaluateRun(run), 'T6');

    assert.deepEqual([t6.status, t6.severity], ['PARTIAL', 'NOTE']);
    assert.ok(t6.items[0].includes(`per PRE_EXISTING ${other}`));
  });

  test('a PRE_EXISTING classification naming another probe leaves T6 MAJOR', () => {
    using run = reportRun();
    const a = brokenByAnotherBaseBug(run);
    const other = run.addCase(probeCase('p-color/other'), { delta: true });

    run.oracle.verdicts[other] = verdict(other, {
      base: 'different',
      head: 'different',
      transition: 'still-different',
    });
    run.analysis.deltas = [{ id: other, classification: 'PRE_EXISTING', reason: 'base wrong the same way' }];

    const t6 = check(evaluateRun(run), 'T6');

    assert.deepEqual([t6.status, t6.severity], ['FAIL', 'MAJOR']);
    assert.deepEqual(t6.items, [`${a}: output-not-contains:" or " (holds on base, fails on head)`]);
  });

  test('equivalent is filled from the in-target engines and left to the oracle checks', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-color/e'), { delta: true });

    run.oracle.verdicts[id] = verdict(id, { base: 'different', head: 'equivalent', transition: 'fixed' });
    run.corpus.probes = [
      {
        id,
        probe: id.slice(2),
        origin: 'pr',
        known: 'none',
        changed: true,
        assert: { base: { equivalent: null }, head: { equivalent: null } },
      },
    ];

    const evaluation = evaluateRun(run);

    assert.deepEqual(Object.fromEntries(evaluation.probeAsserts.get(id)?.head ?? []), { equivalent: true });
    assert.deepEqual(evaluation.probeFixed, [`${id}: equivalent`]);
    assert.equal(
      check(evaluation, 'T6').evidence,
      '1 assertion(s) checked; 1 assertion(s) now pass (fixed by this PR)',
    );
  });

  test('an idempotent assertion is left to R2 when R2 lists the case', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-color/i'), { delta: true });

    run.corpus.probes = [
      {
        id,
        probe: id.slice(2),
        origin: 'pr',
        known: 'none',
        changed: true,
        assert: { base: { idempotent: true }, head: { idempotent: false } },
      },
    ];
    run.corpus.idempotency_failures = [id];

    let evaluation = evaluateRun(run);

    assert.equal(check(evaluation, 'R2').status, 'FAIL');
    assert.equal(check(evaluation, 'T6').status, 'PASS');

    run.corpus.idempotency_failures = [];
    evaluation = evaluateRun(run);

    assert.deepEqual(check(evaluation, 'T6').items, [`${id}: idempotent (holds on base, fails on head)`]);
  });
});
