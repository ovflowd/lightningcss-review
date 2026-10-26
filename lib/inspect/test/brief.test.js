/**
 * `lcr brief`: the sections of the digest, delta grouping by source and mutation family, and the
 * full text of a small run.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { driverGolden, printed, writeScenario } from '../../../test/fixtures/driver/golden.js';
import { captureOutput, tempDir, writeFiles } from '../../../test/helpers/index.js';
import { brief, deltaGroups, deltaLines, mutationParent } from '../brief.js';

describe('brief', () => {
  test('the risk flags line is always printed', async () => {
    using dir = tempDir();

    writeFiles(dir.path, { 'prepare.json': { run_id: 'r', pr: { number: 1 } } });

    const plain = await captureOutput(() => brief(dir.path));

    assert.ok(/** @type {string} */ (plain.result).includes('\nrisk flags: none\n'));

    writeFiles(dir.path, {
      'prepare.json': {
        run_id: 'r',
        pr: { number: 1 },
        risk_flags: [
          { id: 'core-file', detail: 'wide' },
          { id: 'bindings', detail: 'napi' },
        ],
      },
    });

    const flagged = await captureOutput(() => brief(dir.path));

    assert.ok(
      /** @type {string} */ (flagged.result).includes('\nrisk flags: core-file: wide; bindings: napi\n'),
    );
    assert.equal(flagged.stdout, `${flagged.result}\n`);
  });

  test('every section of a small run', async () => {
    using dir = tempDir();

    writeFiles(dir.path, {
      'prepare.json': {
        run_id: 'pr7-h1-b2',
        pr: { number: 7, title: 'Fix', author: 'me', body: '  Body text  \n' },
        strategy: 'merged-into-master',
        areas: ['color'],
        radius_areas: [],
        files: { 'src/b.rs': { added: 2, removed: 0 }, 'src/a.rs': { added: 1, removed: 1 } },
        changed_items: [{ file: 'src/a.rs', impl: { type: 'Color' }, item: null }],
        linked_issues: [{ number: 5, state: 'OPEN', title: 'Bug' }],
      },
      'build.json': { head: { summary: { passed: 1 }, test_exit: 0, adapter_ok: true } },
      'corpus.json': {
        cases: { tuple: 2 },
        deltas: {},
        tuples: { modified: [{ test: 'tests::color::red', line: 9 }], removed_same: [] },
        robustness: { head: [{}], base: [] },
        flag_only: { 'custom-media': ['t-1'] },
      },
      'corpus/deltas.jsonl': [{ id: 't-1', source: 'tuple' }],
      'oracle.json': { verdicts: { 't-1': [{ summary: { latest: { transition: 'fixed' } } }] } },
    });

    const { stdout } = await captureOutput(() => brief(dir.path));

    assert.equal(
      stdout,
      [
        '# pr7-h1-b2: #7 Fix (@me)',
        '',
        'PR body:',
        'Body text',
        '',
        'strategy: merged-into-master; areas: color; radius adds: -',
        '  src/a.rs +1/-1',
        '  src/b.rs +2/-0',
        'changed items: Color::- (src/a.rs)',
        'risk flags: none',
        `linked issue #5 (OPEN): Bug  -> ${dir.path}/issues/5.json`,
        "build head: tests {'passed': 1} exit=0 adapter=ok",
        "cases: {'tuple': 2}; deltas: none",
        '  delta tuple (1): t-1',
        'tests modified: 1  e.g. red:9',
        'panics/timeouts: head 1, base 0',
        'flag-only requests (base rejects the flag): custom-media 1',
        "oracle transitions: {'fixed': 1}",
        '',
        `inspect a case: lcr show pr7-h1-b2 <case-id>; full diff: ${dir.path}/diff.patch`,
        '',
      ].join('\n'),
    );
  });
});

describe('delta groups', () => {
  test('mutation parents, longest mutation name first', () => {
    assert.equal(mutationParent('m-p-a/x-reverse-decls'), 'p-a/x');
    assert.equal(mutationParent('m-t-1-engine-legacy-2021'), 't-1');
    assert.equal(mutationParent('m-p-a/x-value-prefixed-sibling'), 'p-a/x');
    assert.equal(mutationParent('m-p-a/x-prefixed-sibling'), 'p-a/x');
    assert.equal(mutationParent('t-1'), null);
  });

  test('delta ids grouped by source and family', () => {
    const deltas = [
      ...['nest', 'important', 'engine-legacy-2023'].map((name) => ({
        id: `m-p-a/x-${name}`,
        source: 'mutation',
      })),
      ...Array.from({ length: 10 }, (_, index) => ({ id: `p-a/n${index}`, source: 'probe' })),
      { id: 'p-b/y', source: 'probe' },
      { id: 'r-x-minify', source: 'realworld' },
      { id: 't-2', source: 'tuple' },
    ];

    assert.deepEqual(
      deltaGroups(deltas).map(([group]) => group),
      ['tuple', 'p-a/*', 'p-b/*', 'm-p-a/x-*', 'realworld'],
    );

    const lines = deltaLines(deltas);
    const shown = Array.from({ length: 8 }, (_, index) => `p-a/n${index}`).join(', ');

    assert.equal(lines[1], `  delta p-a/* (10): ${shown} (+2 more)`);
    assert.equal(lines[3], '  delta m-p-a/x-* (3): engine-legacy-2023, important, nest');
  });
});

describe('golden output', () => {
  test('every section, with caps, unknown sources and missing names, prints the frozen text', async () => {
    const scenario = driverGolden().brief;

    using dir = tempDir();
    const run = writeScenario(dir.path, scenario);
    const [{ stdout, error }] = scenario.calls;

    assert.deepEqual(await printed(run, () => brief(run)), { stdout, error });
  });
});
