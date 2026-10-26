/**
 * A1 (checklist answers) and A2 (linked issues) (py-final tests/test_report.py ChecklistTest and
 * LinkedIssueTest).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { probeCase, verdict } from '../../../../test/helpers/synthetic-run.js';
import { check, evaluateRun, ITEM, omitStage, reportRun } from '../../test/support.js';

/** @import { ReportRun } from '../../test/support.js' */

/** A probe header's `repro: #7` as py-final's tests wrote it (the helper types it as a number). */
const REPRO_7 = /** @type {number} */ (/** @type {unknown} */ ('#7'));

describe('checklist answers', () => {
  test('a FAIL that contradicts its verify line is a problem', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-color/lm', { mode: 'lower-minify', targets: { chrome: 80 << 16 } }), {
      delta: true,
    });

    run.oracle.verdicts[id] = verdict(id, { base: 'different', transition: 'fixed' });
    run.analysis.checklist = [{ item: 'COLOR-01', answer: 'FAIL', evidence: `only ${id}` }];

    const evidence = check(evaluateRun(run, [ITEM]), 'A3').evidence;

    assert.ok(evidence.includes(`FAIL cites ${id} (lower-minify, fixed), which its verify line accepts`));
    assert.ok(evidence.includes('why each verify alternative does not hold'));
  });

  test('a verify mode inside a longer mode name does not count', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-color/l', { mode: 'lower' }), { delta: true });

    run.oracle.verdicts[id] = verdict(id, { base: 'different', transition: 'fixed' });
    run.analysis.checklist = [{ item: 'COLOR-01', answer: 'FAIL', evidence: `only ${id}`, note: 'n' }];

    assert.ok(!check(evaluateRun(run, [ITEM]), 'A3').evidence.includes('FAIL cites'));
  });

  test('effective_severity only lowers, with a reason', () => {
    using run = reportRun();

    run.analysis.checklist = [
      {
        item: 'COLOR-01',
        evidence: 'x',
        answer: 'FAIL',
        note: 'n',
        effective_severity: 'MINOR',
        severity_reason: 'cosmetic `.0` only',
      },
    ];
    assert.equal(evaluateRun(run, [ITEM]).verdict, 'SAFE_WITH_NITS');

    run.analysis.checklist = [
      {
        item: 'COLOR-01',
        evidence: 'x',
        answer: 'FAIL',
        note: 'n',
        effective_severity: 'BLOCKER',
        severity_reason: 'r',
      },
    ];

    const evaluation = evaluateRun(run, [ITEM]);

    assert.equal(evaluation.counts.BLOCKER, 0);
    assert.ok(check(evaluation, 'A3').evidence.includes('cannot raise'));

    run.analysis.checklist = [{ item: 'COLOR-01', evidence: 'x', answer: 'PASS', effective_severity: 'LOW' }];
    assert.ok(
      check(evaluateRun(run, [ITEM]), 'A3').evidence.includes('effective_severity LOW is not a severity'),
    );

    run.analysis.checklist = [
      { item: 'COLOR-01', evidence: 'x', answer: 'FAIL', note: 'n', effective_severity: 'NOTE' },
    ];
    assert.ok(
      check(evaluateRun(run, [ITEM]), 'A3').evidence.includes(
        'effective_severity NOTE needs a severity_reason',
      ),
    );
  });

  test('FAIL_PRE_EXISTING is a note and needs evidence that base fails', () => {
    using run = reportRun();

    run.analysis.checklist = [
      { item: 'COLOR-01', answer: 'FAIL_PRE_EXISTING', evidence: 'base too, open-issue#710' },
    ];

    const evaluation = evaluateRun(run, [ITEM]);

    assert.equal(check(evaluation, 'A1').status, 'PASS');
    assert.deepEqual(
      evaluation.findings.map((finding) => finding.severity),
      ['NOTE'],
    );

    for (const evidence of ['trust me', 'base too, #710']) {
      run.analysis.checklist = [{ item: 'COLOR-01', answer: 'FAIL_PRE_EXISTING', evidence }];
      assert.ok(
        check(evaluateRun(run, [ITEM]), 'A3').evidence.includes(
          'FAIL_PRE_EXISTING needs evidence that base fails the same way: an issue',
        ),
      );
    }
  });

  test('an area-level N/A answers every item of the area', () => {
    using run = reportRun();

    run.analysis.checklist = [{ area: 'color', answer: 'N/A', evidence: 'diff touches no color code' }];

    const evaluation = evaluateRun(run, [ITEM]);

    assert.equal(evaluation.answers.get('COLOR-01')?.answer, 'N/A');
    assert.equal(evaluation.answers.get('COLOR-01')?.area_level, true);
    assert.equal(check(evaluation, 'A3').status, 'PASS');
  });

  test('A1 counts answered items and lists failures by severity', () => {
    using run = reportRun();
    const second = { ...ITEM, item: 'COLOR-02', severity: /** @type {const} */ ('BLOCKER') };

    run.analysis.checklist = [{ item: 'COLOR-01', answer: 'PASS', evidence: 'x' }];

    let a1 = check(evaluateRun(run, [ITEM, second]), 'A1');

    assert.deepEqual([a1.status, a1.evidence], ['PARTIAL', '1/2 items answered']);

    run.analysis.checklist = [
      { item: 'COLOR-01', answer: 'FAIL', evidence: 'x', note: 'n' },
      { item: 'COLOR-02', answer: 'FAIL', evidence: 'y', note: 'n' },
    ];
    a1 = check(evaluateRun(run, [ITEM, second]), 'A1');

    assert.deepEqual(
      [a1.status, a1.severity, a1.evidence],
      ['FAIL', 'BLOCKER', '2 checklist item(s) failed: COLOR-02 (BLOCKER), COLOR-01 (MAJOR)'],
    );
  });
});

/**
 * A run with one open linked issue (#7), as py-final's LinkedIssueTest set it up.
 *
 * @returns {ReportRun}
 */
function linkedRun() {
  const run = reportRun();

  run.prep.linked_issues = [{ number: 7, state: 'OPEN', title: 't' }];

  return run;
}

/**
 * A2 for a PR probe `repro: #7` with the given verdict (py-final's `repro` helper).
 *
 * @param {ReportRun} run
 * @param {string} transition
 * @param {{ head?: string, perEngine?: Record<string, [string, string]>, targets?: Record<string, number> }} [options]
 * @returns {import('../../../types.js').CheckRow}
 */
function repro(run, transition, { head = 'equivalent', perEngine = {}, targets } = {}) {
  const id = run.addCase(
    probeCase('p-color/repro', { repro: REPRO_7, known: 'open-bug', targets: targets ?? null }),
    {
      delta: true,
    },
  );

  run.addCase(probeCase('p-color/other', { known: 'open-issue#7' }));
  run.corpus.probes = [
    {
      id,
      probe: id.slice(2),
      origin: 'pr',
      known: 'open-bug',
      repro: '#7',
      changed: true,
      assert: { base: { equivalent: null }, head: { equivalent: null } },
    },
  ];
  run.oracle.verdicts[id] = verdict(id, { base: 'different', head, transition, perEngine });

  return check(evaluateRun(run), 'A2');
}

describe('linked issues', () => {
  test('a fixed repro passes', () => {
    using run = linkedRun();

    assert.equal(repro(run, 'fixed').status, 'PASS');
  });

  test('an errored oracle is inconclusive', () => {
    using run = linkedRun();
    /** @type {Record<string, [string, string]>} */
    const perEngine = {
      chromium: ['error', 'error'],
      firefox: ['error', 'error'],
      webkit: ['error', 'error'],
    };

    assert.equal(repro(run, 'errored', { head: 'error', perEngine }).status, 'INCONCLUSIVE');
  });

  test('engines outside the targets do not count', () => {
    using run = linkedRun();
    const a2 = repro(run, 'fixed', {
      perEngine: { firefox: ['different', 'different'] },
      targets: { chrome: 100 << 16 },
    });

    assert.equal(a2.status, 'PASS');
  });

  test('a missing repro leads the evidence before probe credit', () => {
    using run = linkedRun();

    run.prep.linked_issues = [{ number: 7, title: 'x', state: 'OPEN', closing: true }];

    const id = run.addCase(probeCase('p-color/curated', { origin: 'curated', known: 'open-issue#7' }), {
      delta: true,
    });

    run.oracle.verdicts[id] = verdict(id, { base: 'different', transition: 'fixed' });
    run.corpus.probes = [
      {
        id,
        probe: id.slice(2),
        origin: 'curated',
        known: 'open-issue#7',
        assert: { base: { equivalent: null }, head: { equivalent: null } },
      },
    ];
    run.analysis.deltas = [{ id, classification: 'INTENDED', reason: 'fix' }];

    const a2 = check(evaluateRun(run), 'A2');

    assert.deepEqual([a2.status, a2.items], ['FAIL', ['#7: no PR probe with `repro: #7`']]);
    assert.ok(a2.evidence.includes('1 probe assertion(s) fixed by this PR'));
  });

  test('a closed issue without a repro is a note', () => {
    using run = linkedRun();

    run.prep.linked_issues = [{ number: 9, state: 'CLOSED', title: 't' }];

    const a2 = check(evaluateRun(run), 'A2');

    assert.deepEqual([a2.status, a2.severity], ['PARTIAL', 'NOTE']);
  });

  test('a repro that passes on base too does not reproduce the issue', () => {
    using run = linkedRun();
    const id = run.addCase(probeCase('p-color/repro', { repro: REPRO_7 }), { delta: true });

    run.corpus.probes = [
      {
        id,
        probe: id.slice(2),
        origin: 'pr',
        known: 'none',
        repro: 7,
        changed: false,
        assert: { base: { 'output-contains:"x"': true }, head: { 'output-contains:"x"': true } },
      },
    ];

    assert.deepEqual(check(evaluateRun(run), 'A2').items, [
      '#7: color/repro passes on base too (does it reproduce the issue?)',
    ]);
  });

  test('without linked issues or without an analysis A2 skips', () => {
    using run = linkedRun();

    run.prep.linked_issues = [];
    assert.equal(check(evaluateRun(run), 'A2').evidence, 'no linked issues');

    run.prep.linked_issues = [{ number: 7, state: 'OPEN', title: 't' }];
    omitStage(run, 'analysis');
    assert.equal(
      check(evaluateRun(run), 'A2').evidence,
      'analysis.json missing (write an issue probe first)',
    );
  });
});
