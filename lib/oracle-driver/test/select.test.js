/**
 * Case selection: ported from py-final tests/test_pipeline.py
 * `OracleDriverTest.test_select_cases_marks_flag_only_and_mutation_dom`, plus the priority order,
 * the `--max-cases` cut, property/value/attribute cases and the focus sheet of large sheets.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { writeFakeAdapters } from '../../../test/fixtures/driver/fake-adapter.js';
import { driverGolden, writeScenario } from '../../../test/fixtures/driver/golden.js';
import { captureOutput, tempDir, writeFiles } from '../../../test/helpers/index.js';
import { jsonLineText } from '../../core/pyjson.js';
import { focusCss } from '../focus.js';
import { selectCases } from '../select.js';
import { oracleInputs } from '../verdicts.js';

/**
 * @param {string} root
 * @param {Record<string, unknown>} files
 * @returns {string}
 */
function writeRun(root, files) {
  writeFiles(root, {
    'corpus/deltas.jsonl': [],
    'corpus/outputs-base.jsonl': [],
    'corpus/outputs-head.jsonl': [],
    'corpus.json': {},
    'prepare.json': { areas: [] },
    ...files,
  });

  return root;
}

describe('selectCases', () => {
  test('marks flag-only cases and keeps the mutation DOM', async () => {
    using dir = tempDir();
    const run = writeRun(dir.path, {
      'corpus/cases.jsonl': [
        {
          id: 'p-a/x',
          source: 'probe',
          origin: 'pr',
          area: 'color',
          probe: { area: 'color', dom: '<p></p>' },
          request: { kind: 'sheet', css: '.a{}', flags: ['custom-functions'] },
        },
        {
          id: 'm-p-a/x-nest',
          source: 'mutation',
          parent: 'p-a/x',
          area: 'color',
          dom: '<div class="lcr-n"><p></p></div>',
          request: { kind: 'sheet', css: '.lcr-n{.a{}}' },
        },
      ],
      'corpus/outputs-base.jsonl': [
        { id: 'p-a/x', ok: false, stage: 'request' },
        { id: 'm-p-a/x-nest', ok: true, code: 'x' },
      ],
      'corpus/outputs-head.jsonl': [
        { id: 'p-a/x', ok: true, code: '.a{}' },
        { id: 'm-p-a/x-nest', ok: true, code: 'y' },
      ],
      'corpus.json': { flag_only: { 'custom-functions': ['p-a/x'] } },
      'prepare.json': { areas: ['color'] },
    });
    const { cases, stats } = await selectCases(run, 10);
    const byId = new Map(cases.map((entry) => [entry.id, /** @type {any} */ (entry)]));

    assert.deepEqual([byId.get('p-a/x').introduced, byId.get('p-a/x').flagOnly], [true, 'custom-functions']);
    assert.ok(!('introduced' in byId.get('m-p-a/x-nest')));
    assert.equal(byId.get('m-p-a/x-nest').dom, '<div class="lcr-n"><p></p></div>');
    assert.deepEqual(stats, {
      candidates: 2,
      selected: 2,
      dropped: 0,
      by_reason: { 'pr-probe': 1, mutation: 1 },
    });
    assert.deepEqual(Object.keys(oracleInputs(run)).sort(), [
      'cases',
      'outputs-base',
      'outputs-head',
      'probe_files',
    ]);
  });

  test('priority order and the --max-cases cut', async () => {
    using dir = tempDir();
    const sheet = { kind: 'sheet', css: '.a{}' };
    const run = writeRun(dir.path, {
      'corpus/cases.jsonl': [
        { id: 'w-1', source: 'wpt', request: sheet },
        { id: 't-2', source: 'tuple', side: 'base', request: sheet },
        { id: 't-1', source: 'tuple', side: 'head', request: sheet },
        { id: 'p-b', source: 'probe', origin: 'pr', request: sheet },
        { id: 'p-a', source: 'probe', origin: 'curated', request: sheet },
      ],
      'corpus/deltas.jsonl': [{ id: 'w-1' }, { id: 'p-a' }, { id: 'gone' }],
      'corpus/outputs-base.jsonl': ['w-1', 't-1', 't-2', 'p-a', 'p-b'].map((id) => ({
        id,
        ok: true,
        code: 'x',
      })),
      'corpus.json': { tuples: { modified: [{ id: 't-2' }, { id: 'missing' }] } },
    });
    const all = await selectCases(run, 10);

    assert.deepEqual(
      all.cases.map((entry) => entry.id),
      ['p-b', 't-1', 't-2', 'p-a', 'w-1'],
    );
    assert.deepEqual(all.stats.by_reason, {
      'pr-probe': 1,
      'new-or-changed-test': 1,
      'tuple-modified': 1,
      'probe-delta': 1,
      'wpt-delta': 1,
    });

    const wpt = /** @type {any} */ (all.cases.at(-1));

    assert.equal(wpt.dom, '<div class="t">x</div>');
    assert.deepEqual(wpt.sheets, { input: '.a{}', base: 'x', head: null });

    const { result, stderr } = await captureOutput(() => selectCases(run, 2));
    const capped = /** @type {Awaited<ReturnType<typeof selectCases>>} */ (result);

    assert.deepEqual(
      capped.cases.map((entry) => entry.id),
      ['p-b', 't-1'],
    );
    assert.deepEqual(capped.stats, {
      candidates: 5,
      selected: 2,
      dropped: 3,
      by_reason: { 'pr-probe': 1, 'new-or-changed-test': 1 },
    });
    assert.equal(
      stderr,
      '[lcr] oracle: 5 candidate cases, keeping the first 2 by priority; 3 not run (raise --max-cases to include them)\n',
    );
  });

  test('property, value, attribute and CSS-modules cases', async () => {
    using dir = tempDir();
    const run = writeRun(dir.path, {
      'corpus/cases.jsonl': [
        {
          id: 'p-1',
          source: 'probe',
          origin: 'pr',
          request: { kind: 'value', property: 'color', value: 'red' },
          expectation: { type: 'value-unparsed' },
        },
        {
          id: 'p-2',
          source: 'probe',
          origin: 'pr',
          request: { kind: 'property', property: 'color', value: 'red' },
        },
        { id: 'p-3', source: 'probe', origin: 'pr', request: { kind: 'attr', css: 'color: red' } },
        {
          id: 'p-4',
          source: 'probe',
          origin: 'pr',
          request: { kind: 'sheet', css: '.a{}', css_modules: {} },
        },
        { id: 'p-5', source: 'probe', origin: 'pr', request: { kind: 'sheet', css: '.a{}' } },
      ],
      'corpus/outputs-base.jsonl': [
        { id: 'p-1', ok: true, code: '#f00', recognition: 'typed' },
        { id: 'p-2', ok: true, code: 'red' },
        { id: 'p-3', ok: true, code: 'color:red' },
      ],
      'corpus/outputs-head.jsonl': [{ id: 'p-1', ok: true, code: 'red', recognition: 'custom' }],
    });
    const { cases } = await selectCases(run, 10);

    assert.deepEqual(cases, [
      {
        id: 'p-1',
        kind: 'property',
        property: 'color',
        value: 'red',
        wptKind: 'invalid',
        expected: null,
        outputs: { base: 'color: #f00', head: 'color: red' },
        targets: null,
      },
      {
        id: 'p-2',
        kind: 'property',
        property: 'color',
        value: 'red',
        wptKind: 'valid',
        expected: null,
        outputs: { base: 'red', head: null },
        targets: null,
      },
      {
        id: 'p-3',
        kind: 'sheet',
        sheets: { input: '#lcr-attr{color: red}', base: '#lcr-attr{color:red}', head: null },
        targets: null,
        dom: '<div id="lcr-attr">x</div>',
        domFrom: null,
        visual: false,
      },
    ]);
  });

  test('large sheets without a DOM get a focus sheet', async () => {
    using dir = tempDir();
    const filler = `.f { color: red }\n`.repeat(1200);
    const run = writeRun(dir.path, {
      'corpus/cases.jsonl': [
        { id: 'r-big-print', source: 'realworld', request: { kind: 'sheet', css: filler } },
      ],
      'corpus/deltas.jsonl': [{ id: 'r-big-print' }],
      'corpus/outputs-base.jsonl': [{ id: 'r-big-print', ok: true, code: `${filler}.x { color: blue }` }],
      'corpus/outputs-head.jsonl': [{ id: 'r-big-print', ok: true, code: `${filler}.x { color: green }` }],
    });

    writeFakeAdapters(run);

    const { cases } = await selectCases(run, 10);
    const [entry] = /** @type {any[]} */ (cases);

    assert.equal(entry.domFrom, '.x { color: green }\n.x { color: blue }\n');
    assert.equal(entry.visual, false);
  });
});

describe('focusCss', () => {
  test('keeps changed leaves inside their grouping rules, head first', async () => {
    using dir = tempDir();

    writeFakeAdapters(dir.path);

    const base = '.a { color: red }\n@media print { @layer x { .b { color: blue } } }\n@import "y.css";';
    const head = '.a {  color: red }\n@media print { @layer x { .b { color: green } } }\n@import "y.css";';

    assert.equal(
      await focusCss(dir.path, base, head),
      '@media print {\n@layer x {\n.b { color: green }\n}\n}\n@media print {\n@layer x {\n.b { color: blue }\n}\n}\n',
    );
    assert.equal(await focusCss(dir.path, base, base), null);
  });
});

describe('py-final golden', () => {
  test('priority, delta order, visual areas, attribute focus carry-over and the cut match py-final', async () => {
    const scenario = driverGolden().select;

    using dir = tempDir();
    const run = writeScenario(dir.path, scenario);

    for (const [cap, expected] of Object.entries(scenario.select)) {
      const { result, stderr } = await captureOutput(() => selectCases(run, Number(cap)));
      const { cases, stats } = /** @type {Awaited<ReturnType<typeof selectCases>>} */ (result);

      assert.equal(jsonLineText([cases, stats]), expected.result, `--max-cases ${cap}`);
      assert.equal(stderr, expected.stderr);
    }
  });
});
