/**
 * `lcr table`: ported from py-final tests/test_pipeline.py `InspectTest.test_table` and
 * `PreOracleTableTest`, plus `--check`, `--case` and the JSON rows.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { driverGolden, printed, writeScenario } from '../../../test/fixtures/driver/golden.js';
import { captureOutput, tempDir, writeFiles } from '../../../test/helpers/index.js';
import { checkCaseIds, formatOutputTable, formatTable, outputRows, table, tableRows } from '../table.js';

/** A verdict with a fixed transition and a legacy profile (py-final's InspectTest.VERDICT). */
const VERDICT = /** @type {any} */ ({
  case: 't-1',
  scheme: 'light',
  summary: {
    latest: {
      transition: 'fixed',
      base: 'different',
      head: 'equivalent',
      enginesBase: { bad: ['webkit', 'chromium'] },
      enginesHead: { bad: [] },
      divergent: false,
      rejectedBase: 0,
      rejectedHead: 1,
    },
    legacy: { 'legacy-2023': { transition: 'unverified' } },
  },
});

/**
 * @param {string} root
 * @returns {string}
 */
function preOracleRun(root) {
  writeFiles(root, {
    'corpus/cases.jsonl': [
      { id: 'p-a/x', source: 'probe', probe: { area: 'selectors' }, request: {} },
      { id: 't-1', source: 'tuple', request: {} },
      { id: 'w-1', source: 'wpt', area: 'color', request: {} },
    ],
    'corpus/outputs-base.jsonl': [
      { id: 'p-a/x', ok: true },
      { id: 't-1', ok: true },
      { id: 'w-1', ok: false },
    ],
    'corpus/outputs-head.jsonl': [
      { id: 'p-a/x', ok: false },
      { id: 't-1', ok: true },
      { id: 'w-1', ok: false },
    ],
    'corpus/deltas.jsonl': [{ id: 'p-a/x', source: 'probe' }],
  });

  return root;
}

describe('oracle table', () => {
  test('filters by transition; abbreviates engines and legacy profiles', () => {
    const rows = tableRows(
      { 't-1': [VERDICT], 't-2': [{ ...VERDICT, summary: { latest: { transition: 'regressed' } } }] },
      { transitions: new Set(['fixed']) },
    );

    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].bad_base, ['chromium', 'webkit']);

    const text = formatTable(rows);

    assert.ok(text.includes('CW/-'));
    assert.ok(text.includes('2023:unverified'));
    assert.ok(text.endsWith('1 row(s): fixed=1'));
  });

  test('rows of a missing summary print dashes and count under None', () => {
    const rows = tableRows({ 'x-1': [/** @type {any} */ ({ case: 'x-1' })] });

    assert.deepEqual(rows[0], {
      id: 'x-1',
      scheme: null,
      transition: null,
      base: null,
      head: null,
      bad_base: [],
      bad_head: [],
      divergent: false,
      legacy: {},
      rejected: [0, 0],
    });
    assert.equal(
      formatTable(rows),
      [
        'id   scheme  transition  base  head  bad b/h  div  rej b/h  legacy',
        'x-1  -       -           -     -     -/-      -    0/0      -',
        '1 row(s): None=1',
      ].join('\n'),
    );
    assert.equal(formatTable([]), 'no matching cases');
  });

  test('--case keeps matching ids; --check reads the ids of a report check', async () => {
    using dir = tempDir();

    writeFiles(dir.path, {
      'oracle.json': { verdicts: { 't-1': [VERDICT], 'p-a/x': [{ ...VERDICT, case: 'p-a/x' }] } },
      'report.json': { checks: [{ id: 'O1', items: ['p-a/x~dark@legacy-2023 (note)'] }] },
    });
    assert.deepEqual(checkCaseIds(dir.path, 'O1'), new Set(['p-a/x']));
    assert.throws(() => checkCaseIds(dir.path, 'O9'), { message: 'no check O9 in report.json' });

    const checked = await captureOutput(() => table(dir.path, { check: 'O1', json: true }));

    assert.deepEqual(
      JSON.parse(checked.stdout).map((/** @type {{ id: string }} */ row) => row.id),
      ['p-a/x'],
    );

    const globbed = await captureOutput(() => table(dir.path, { pattern: 't-*' }));

    assert.match(globbed.stdout, /^id {3}/);
    assert.match(globbed.stdout, /\nt-1 /);
    assert.doesNotMatch(globbed.stdout, /p-a\/x/);
  });

  test('--check without report.json is an error', () => {
    using dir = tempDir();

    assert.throws(() => checkCaseIds(dir.path, 'O1'), {
      message: '--check needs report.json; run `lcr report <run> --allow-incomplete` first',
    });
  });
});

describe('before the oracle', () => {
  test('deltas by default, every case by glob', () => {
    using dir = tempDir();
    const run = preOracleRun(dir.path);

    assert.deepEqual(outputRows(run), [
      { id: 'p-a/x', source: 'probe', area: 'selectors', base_ok: true, head_ok: false, changed: true },
    ]);

    const rows = outputRows(run, { pattern: '*' });

    assert.deepEqual(
      rows.map((row) => [row.id, row.area, row.changed]),
      [
        ['p-a/x', 'selectors', true],
        ['t-1', null, false],
        ['w-1', 'color', false],
      ],
    );

    const text = formatOutputTable(rows);

    assert.ok(text.includes('w-1    wpt     color      error  error  -'));
    assert.ok(text.endsWith('3 row(s), 1 changed; no oracle yet, outputs only'));
  });

  test('the table runs before the oracle; --transition and a missing corpus are errors', async () => {
    using dir = tempDir();
    const run = preOracleRun(dir.path);
    const { stdout } = await captureOutput(() => table(run));

    assert.ok(stdout.includes('p-a/x  probe   selectors  ok    error  yes'));
    assert.ok(stdout.endsWith("; deltas only (`--case '*'` lists every case)\n"));
    await assert.rejects(table(run, { transition: 'fixed' }), {
      message: '--transition needs oracle.json; run `lcr oracle <run>` first',
    });

    using empty = tempDir();

    await assert.rejects(table(empty.path), { message: 'no corpus yet; run `lcr corpus <run>` first' });
  });
});

describe('py-final golden', () => {
  for (const name of ['table_oracle', 'table_pre_oracle']) {
    test(`${name}: every filter prints exactly as py-final`, async () => {
      const scenario = driverGolden()[name];

      using dir = tempDir();
      const run = writeScenario(dir.path, scenario);

      for (const { call, stdout, error } of scenario.calls) {
        const [, , { as_json: json = false, ...filters }] = call;

        assert.deepEqual(await printed(run, () => table(run, { ...filters, json })), { stdout, error }, call);
      }
    });
  }
});
