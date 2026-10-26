/**
 * `lcr show`: a case and its verdicts, the text layout of engine blocks and summary lines, prefix
 * resolution and the fallback to oracle.json.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { driverGolden, RUN_TOKEN, writeScenario } from '../../../test/fixtures/driver/golden.js';
import { captureOutput, REPO_ROOT, tempDir, writeFiles } from '../../../test/helpers/index.js';
import { run as runProcess } from '../../core/proc.js';
import { findRows } from '../rows.js';
import { caseMeta, caseVerdicts, diffRows, engineBlock, resolveCase, show, summaryLine } from '../show.js';

/** The CLI entry point. */
const LCR = join(REPO_ROOT, 'bin', 'lcr');

/** A verdict with a fixed transition and a legacy profile. */
const VERDICT = {
  case: 't-1',
  scheme: 'light',
  latest: {
    chromium: {
      version: '1',
      touched: 1,
      variants: {
        base: { status: 'different', diffs: [{ key: 'div#1', prop: 'display', ref: 'flex', val: 'block' }] },
        head: { status: 'equivalent', diffs: [] },
      },
    },
  },
  legacy: {},
  summary: {
    latest: {
      transition: 'fixed',
      base: 'different',
      head: 'equivalent',
      enginesBase: { bad: ['chromium', 'webkit'] },
      enginesHead: { bad: [] },
      divergent: false,
      rejectedBase: 0,
      rejectedHead: 1,
    },
    legacy: { 'legacy-2023': { transition: 'unverified' } },
  },
};

/**
 * @param {string} root
 * @returns {string}
 */
function writeRun(root) {
  writeFiles(root, {
    'corpus/cases.jsonl': [
      { id: 't-1', source: 'tuple', request: { kind: 'sheet', css: '.a{}' } },
      { id: 't-10', source: 'tuple', request: { kind: 'sheet', css: '.b{}' } },
    ],
    'corpus/outputs-base.jsonl': [
      { id: 't-1', ok: true, code: 'B' },
      { id: 't-10', ok: true, code: 'X' },
    ],
    'corpus/outputs-head.jsonl': [{ id: 't-1', ok: true, code: 'H' }],
    'oracle/verdicts.jsonl': [VERDICT],
  });

  return root;
}

describe('diffRows', () => {
  test('merges both variants; = means the side matches the input', () => {
    assert.deepEqual(diffRows(/** @type {any} */ (VERDICT.latest.chromium.variants)), [
      ['div#1', 'display', 'flex', 'block', '='],
    ]);
  });

  test('sorts by element, then property; the first ref wins', () => {
    const rows = diffRows({
      base: { status: 'different', diffs: [/** @type {any} */ ({ key: 'b', prop: 'x', ref: 'r1', val: 1 })] },
      head: {
        status: 'different',
        diffs: [
          /** @type {any} */ ({ key: 'b', prop: 'x', ref: 'r2', val: null }),
          { key: 'a', prop: 'y', ref: 'r', val: 'v' },
        ],
      },
    });

    assert.deepEqual(rows, [
      ['a', 'y', 'r', '=', 'v'],
      ['b', 'x', 'r1', '1', 'None'],
    ]);
  });
});

describe('findRows and show', () => {
  test('finds exact rows only and prints everything as JSON', async () => {
    using dir = tempDir();
    const run = writeRun(dir.path);

    assert.deepEqual(findRows(join(run, 'corpus', 'outputs-base.jsonl'), 'id', 't-1'), [
      { id: 't-1', ok: true, code: 'B' },
    ]);
    assert.equal(resolveCase(run, 't-1').id, 't-1');

    const { stdout } = await captureOutput(() => show(run, 't-1', { json: true }));
    const data = JSON.parse(stdout);

    assert.deepEqual([data.base.code, data.head.code, data.oracle.length], ['B', 'H', 1]);
  });

  test('a prefix resolves to the smallest matching id; no match is an error', () => {
    using dir = tempDir();
    const run = writeRun(dir.path);

    assert.equal(resolveCase(run, 't-').id, 't-1');
    assert.throws(() => resolveCase(run, 'p-'), {
      message: 'no case p-; list the case ids with `lcr table <run>`',
    });
  });

  test('the text view: meta, request, outputs and the engine table', async () => {
    using dir = tempDir();
    const run = writeRun(dir.path);
    const { stdout } = await captureOutput(() => show(run, 't-1'));

    assert.equal(
      stdout,
      [
        '== t-1 (tuple)',
        '{"source": "tuple"}',
        '== request options: {"kind": "sheet"}',
        '== input:',
        '.a{}',
        '== base: ok',
        'B',
        '== head: ok',
        'H',
        '== oracle (light) latest: fixed (base different, head equivalent; bad engines base CW head -; rejected base 0 head 1)',
        '  chromium 1: base different, head equivalent; touched 1; rejected base 0 head 0',
        '    element  property  input  base   head',
        '    div#1    display   flex   block  =',
        '',
      ].join('\n'),
    );
  });

  test('a missing output prints None; verdicts fall back to oracle.json', async () => {
    using dir = tempDir();
    const run = writeRun(dir.path);

    writeFiles(run, { 'oracle/verdicts.jsonl': '', 'oracle.json': { verdicts: { 't-10': [VERDICT] } } });
    assert.equal(caseVerdicts(run, 't-10').length, 1);

    const { stdout } = await captureOutput(() => show(run, 't-10'));

    assert.match(stdout, /\n== head: None error\nNone\n/);
  });
});

describe('engineBlock and summaryLine', () => {
  test('skipped and errored engines are one line', () => {
    assert.deepEqual(engineBlock('webkit', { version: '15.4', skipped: 'engine-not-in-targets' }), [
      '  webkit 15.4: skipped (engine-not-in-targets)',
    ]);
    assert.deepEqual(engineBlock('firefox', { error: 'x'.repeat(400) }), [
      `  firefox : error ${'x'.repeat(300)}`,
    ]);
  });

  test('rejected items are listed per side and kind', () => {
    const lines = engineBlock('chromium', {
      version: '1',
      variants: {
        base: { status: 'equivalent' },
        head: { status: 'different', rejected: { decls: [{ prop: 'a', value: 'b', important: true }] } },
      },
    });

    assert.deepEqual(lines, [
      '  chromium 1: base equivalent, head different; touched -; rejected base 0 head 1',
      "    rejected on head (decls): {'prop': 'a', 'value': 'b', 'important': True}",
    ]);
  });

  test('summary line of an empty summary', () => {
    assert.equal(
      summaryLine({}),
      'None (base None, head None; bad engines base - head -; rejected base 0 head 0)',
    );
    assert.match(summaryLine({ divergent: true }), /; divergent; rejected/);
  });

  test('case meta drops empty probe fields', () => {
    const meta = caseMeta(
      /** @type {any} */ ({
        id: 'p-a/x',
        source: 'probe',
        request: {},
        probe: { id: 'a/x', dom: null, refs: [], note: '', expect: ['idempotent'] },
      }),
    );

    assert.deepEqual(meta, { source: 'probe', probe: { id: 'a/x', expect: ['idempotent'] } });
  });
});

describe('golden output', () => {
  // Through the CLI in a child process: the large-output diff awaits the adapters, and while it
  // waits the test runner writes its own messages to this process's stdout.
  test('long inputs, large-output diffs, every engine block and --json print the frozen output', async () => {
    const scenario = driverGolden().show;

    using dir = tempDir();
    const run = writeScenario(join(dir.path, 'runs', 'run'), scenario);

    for (const { call, stdout, error } of scenario.calls) {
      const [, [caseId], { as_json: json = false }] = call;
      const result = await runProcess(
        [process.execPath, LCR, 'show', 'run', caseId, ...(json ? ['--json'] : [])],
        {
          env: { LCR_CACHE: dir.path },
          check: false,
        },
      );

      assert.equal(result.stdout.replaceAll(run, RUN_TOKEN), stdout, caseId);
      assert.equal(result.code, error === null ? 0 : 2, caseId);

      // The golden file records the message only; the remedy after it (`; list the case ids …`) is newer.
      if (error !== null) {
        assert.equal(result.stderr.split('; ')[0], `[lcr] error: ${error}`);
        assert.match(result.stderr, /; list the case ids with `lcr table <run>`\n$/);
      }
    }
  });
});
