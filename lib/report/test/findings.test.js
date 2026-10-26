/**
 * Findings: one per defect, how regressions, decisions and failed checklist items fold into them,
 * and their order.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { mutationCase, probeCase, verdict } from '../../../test/helpers/synthetic-run.js';
import { ARROW } from '../glyphs.js';
import { check, evaluateRun, ITEM, reportRun } from './support.js';

describe('classification findings', () => {
  test('REGRESSION cases are one blocker finding and close the check', () => {
    using run = reportRun();
    const ids = [0, 1].map((index) => run.addCase(probeCase(`p-color/r${index}`), { delta: true }));

    for (const id of ids) {
      run.oracle.verdicts[id] = verdict(id, { head: 'different', transition: 'regressed' });
    }

    run.analysis.deltas = ids.map((id) => ({
      id,
      classification: 'REGRESSION',
      reason: 'drops the fallback',
    }));

    const evaluation = evaluateRun(run);
    const regressions = evaluation.findings.filter((finding) => finding.title.startsWith('Regression'));

    assert.equal(check(evaluation, 'O1').status, 'FAIL');
    assert.equal(regressions.length, 1);
    assert.deepEqual(regressions[0].evidence, ids);
    assert.ok(!evaluation.findings.some((finding) => finding.check === 'O1'));
    assert.equal(evaluation.counts.BLOCKER, 1);
    assert.equal(evaluation.verdict, 'UNSAFE');
  });

  test('a maintainer decision closes the slot and never blocks', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-color/d'), { delta: true });

    run.oracle.verdicts[id] = verdict(id, { head: 'different', transition: 'regressed' });
    run.analysis.deltas = [
      { id, classification: 'NEEDS_MAINTAINER_DECISION', reason: 'policy: keep the prefix?' },
    ];

    const evaluation = evaluateRun(run);

    assert.equal(check(evaluation, 'O1').status, 'PASS');
    assert.equal(evaluation.verdict, 'NEEDS_CHANGES');
    assert.deepEqual(evaluation.decision, ['policy: keep the prefix? (1 case(s))']);
  });

  test('a decision the browsers do not show worse is a note; reasons group after stripping', () => {
    using run = reportRun();
    const ids = [0, 1].map((index) => run.addCase(probeCase(`p-color/n${index}`), { delta: true }));

    for (const id of ids) {
      run.oracle.verdicts[id] = verdict(id, {
        base: 'different',
        head: 'different',
        transition: 'still-different',
      });
    }

    run.analysis.deltas = [
      { id: ids[0], classification: 'NEEDS_MAINTAINER_DECISION', reason: 'keep it?' },
      { id: ids[1], classification: 'NEEDS_MAINTAINER_DECISION', reason: ' keep it? ' },
    ];

    const evaluation = evaluateRun(run);
    const decisions = evaluation.findings.filter((finding) => finding.source === 'classification');

    assert.deepEqual(
      decisions.map((finding) => [finding.severity, finding.title, finding.evidence]),
      [['NOTE', 'Decision needed: keep it?', ids]],
    );
    assert.equal(evaluation.verdict, 'SAFE');
  });

  test('an unclassified decision bucket adds a decision line', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-color/x'), { delta: true });

    run.oracle.verdicts[id] = verdict(id, {
      base: 'no-coverage',
      head: 'different',
      transition: 'input-rejected',
    });

    assert.deepEqual(evaluateRun(run).decision, [
      '1 case(s) the browsers cannot judge against base are unclassified (O10)',
    ]);
  });
});

describe('folding', () => {
  test('A1 is a row only; a checklist failure folds into the finding it links', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-color/x'), { delta: true });

    run.analysis.findings = [{ id: 'F1', severity: 'MINOR', title: 'Gradient loses a stop', evidence: [id] }];
    run.analysis.checklist = [
      { item: 'COLOR-01', evidence: 'x', answer: 'FAIL', note: 'no alternative holds', finding: 'F1' },
    ];

    const evaluation = evaluateRun(run, [ITEM]);

    assert.equal(check(evaluation, 'A1').status, 'FAIL');
    assert.ok(!evaluation.findings.some((finding) => finding.check === 'A1'));
    assert.equal(evaluation.findings.length, 1);
    assert.deepEqual(
      [evaluation.findings[0].severity, evaluation.findings[0].folded?.[0].check],
      ['MAJOR', 'COLOR-01'],
    );
  });

  test('a check failure folds into the analysis finding citing its cases', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-color/x'), { delta: true });

    run.oracle.verdicts[id] = verdict(id, { head: 'different', transition: 'regressed' });
    run.analysis.findings = [
      { severity: 'MAJOR', title: 'Drops the fallback', evidence: [`${id} renders red`] },
    ];

    assert.deepEqual(
      evaluateRun(run).findings.map((finding) => [finding.severity, finding.title]),
      [['BLOCKER', 'Drops the fallback']],
    );
  });

  test("a check failure citing only some of a finding's cases stays standalone and names it", () => {
    using run = reportRun();
    const ids = [0, 1].map((index) => run.addCase(probeCase(`p-color/r${index}`), { delta: true }));

    for (const id of ids) {
      run.oracle.verdicts[id] = verdict(id, { head: 'different', transition: 'regressed' });
    }

    run.analysis.findings = [{ id: 'F1', severity: 'NOTE', title: 'One of them', evidence: [ids[0]] }];

    const o1 = evaluateRun(run).findings.find((finding) => finding.check === 'O1');

    assert.deepEqual(o1?.related, ['F1: One of them']);
  });

  test('a same-root failure folds into its root; alone it is a finding of its own', () => {
    using run = reportRun();

    run.addCase(probeCase('p-color/x'));

    const root = {
      ...ITEM,
      item: 'GEN-06',
      severity: /** @type {const} */ ('BLOCKER'),
      list: 'general',
      verify: 'mutations',
    };
    const dependent = {
      ...ITEM,
      item: 'TESTS-03',
      list: 'tests',
      verify: 'mutations',
      same_root_as: 'GEN-06',
    };

    run.analysis.checklist = [
      { item: 'GEN-06', answer: 'FAIL', evidence: 'm-x' },
      { item: 'TESTS-03', answer: 'FAIL', evidence: 'm-x' },
    ];

    let findings = evaluateRun(run, [root, dependent]).findings;

    assert.deepEqual(
      findings.map((finding) => [finding.check, finding.severity]),
      [['GEN-06', 'BLOCKER']],
    );
    assert.deepEqual(
      findings[0].folded?.map((entry) => entry.check),
      ['TESTS-03'],
    );

    run.analysis.checklist = [
      { item: 'GEN-06', answer: 'PASS', evidence: 'm-x' },
      { item: 'TESTS-03', answer: 'FAIL', evidence: 'm-x' },
    ];
    findings = evaluateRun(run, [root, dependent]).findings;

    assert.deepEqual(
      findings.map((finding) => finding.check),
      ['TESTS-03'],
    );
  });

  test('a lowered severity is explained in the finding detail', () => {
    using run = reportRun();

    run.analysis.checklist = [
      {
        item: 'COLOR-01',
        answer: 'FAIL',
        evidence: 'x',
        note: 'n',
        effective_severity: 'MINOR',
        severity_reason: 'cosmetic',
      },
    ];

    const [finding] = evaluateRun(run, [ITEM]).findings;

    assert.equal(finding.detail, `n (severity MAJOR ${ARROW} MINOR: cosmetic)`);
  });

  test('findings are ordered by severity, source, check and title, and numbered', () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-color/x'), { delta: true });

    run.addCase(mutationCase(id, 'wrap'), { delta: true });
    run.oracle.verdicts[id] = verdict(id, { head: 'different', transition: 'regressed' });
    run.analysis.findings = [
      { severity: 'NOTE', title: 'b note', evidence: ['x'] },
      { severity: 'NOTE', title: 'a note', evidence: ['y'] },
      { severity: 'BOGUS', title: 'dropped', evidence: ['z'] },
    ];

    const findings = evaluateRun(run).findings;

    assert.deepEqual(
      findings.map((finding) => [
        finding.n,
        finding.severity,
        finding.source,
        finding.check,
        finding.id ?? null,
      ]),
      [
        [1, 'BLOCKER', 'check', 'O1', null],
        [2, 'MAJOR', 'check', 'A3', null],
        [3, 'MAJOR', 'check', 'O8', null],
        [4, 'NOTE', 'analysis', null, 'F2'],
        [5, 'NOTE', 'analysis', null, 'F1'],
      ],
    );
    assert.ok(findings.every((finding) => !('folded' in finding) || (finding.folded ?? []).length > 0));
  });

  test('what folds into a finding adds at most max_listed_cases new evidence lines', () => {
    using run = reportRun();
    const ids = Array.from({ length: 14 }, (_, index) =>
      run.addCase(probeCase(`p-color/r${String(index).padStart(2, '0')}`), { delta: true }),
    );

    for (const id of ids) {
      run.oracle.verdicts[id] = verdict(id, { head: 'different', transition: 'regressed' });
    }

    run.analysis.findings = [{ severity: 'MAJOR', title: 'Drops the fallback', evidence: [ids.join(' ')] }];

    const [finding] = evaluateRun(run).findings;

    assert.deepEqual(
      finding.folded?.map((entry) => entry.check),
      ['O1'],
    );
    assert.equal(finding.evidence.length, 1 + 12);
    assert.equal(finding.evidence.at(-1), ids[11]);
  });
});
