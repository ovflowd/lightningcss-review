import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { captureOutput, tempDir, withEnv, writeFiles } from '../../../test/helpers/index.js';
import { readJson, readJsonl } from '../../core/files.js';
import { corpus } from '../corpus.js';
import { diskNeed } from '../differential.js';
import { inRanges, modeRequest, realworldCases, tupleCases, wptCases } from '../sources.js';
import { fakeAdapter, writeProbe } from './support.js';

/** @import { CorpusCase, CorpusSummary, Prepare } from '../../types.js' */

const TARGETS_RS = 'bitflags! {\n  pub struct Features: u32 {\n    const Nesting = 1 << 0;\n  }\n}\n';
const NO_OPTIONS = { css_modules: 'None', error_recovery: false, filename: '', flags: 'ParserFlags(0x0)' };

/**
 * A recorded `minify_test` call.
 *
 * @param {string} test
 * @param {number} line
 * @param {string} source
 * @param {string} expected
 * @param {string} [helper]
 * @returns {object}
 */
function tuple(test, line, source, expected, helper = 'minify_test_with_options_and_browsers') {
  return {
    test,
    helper,
    file: 'src/lib.rs',
    line,
    fields: { browsers: 'None', expected, options: NO_OPTIONS, source },
  };
}

/**
 * A run that went through prepare and build, with fake adapters: base appends a comment to CSS
 * containing `delta-me`, so those cases differ.
 *
 * @param {string} run
 * @returns {void}
 */
function makeRun(run) {
  const both = tuple('tests::test_a', 1, '.a{color:red}', '.a{color:red}');

  fakeAdapter(join(run, 'bin'), 'base-adapter', { marker: '/*b*/' });
  fakeAdapter(join(run, 'bin'), 'head-adapter');
  writeProbe(join(run, 'probes'), 'pr-one');
  writeFiles(run, {
    'prepare.json': { files: { 'src/lib.rs': { head: [[10, 20]], base: [] } } },
    'build.json': { base: {}, head: {} },
    'src/base/src/targets.rs': TARGETS_RS,
    'src/head/src/targets.rs': TARGETS_RS,
    'build/base/tuples.jsonl': [
      both,
      tuple('tests::test_b', 2, '.b{x:y}', 'old'),
      tuple('tests::test_c', 3, '.c{x:y}', '.c{x:y}'),
      { test: 'tests::test_z', helper: 'nope', file: 'src/lib.rs', line: 9, fields: {} },
    ],
    'build/head/tuples.jsonl': [
      both,
      both,
      tuple('tests::test_b', 12, '.b{x:y}', '.b{x:y}'),
      tuple('tests::test_d', 15, '.d{delta-me:1}', '.d{delta-me:1}'),
    ],
  });
}

describe('corpus (end to end on a synthetic run)', () => {
  test('cases, outputs, deltas and the summary', async () => {
    using run = tempDir();
    using cache = tempDir();
    using _env = withEnv({ LCR_CACHE: cache.path });

    makeRun(run.path);

    const { result, stderr } = await captureOutput(() =>
      corpus(run.path, { wpt: 'none', realworld: 'none' }),
    );
    const summary = /** @type {CorpusSummary} */ (result);

    assert.deepEqual(readJson(join(run.path, 'corpus.json')), summary);
    assert.equal(summary.cases.tuple, 5);
    assert.ok(/** @type {number} */ (summary.cases.mutation) > 0);
    assert.deepEqual(summary.tuple_stats.base_tuples, 4);
    assert.deepEqual(summary.tuple_stats.head_tuples, 3);
    assert.deepEqual(summary.tuple_stats.unmappable_helpers, ['nope']);
    assert.equal(summary.tuple_stats.unmappable_cases[0].side, 'base');

    const ids = (/** @type {string} */ bucket) =>
      summary.tuples[/** @type {keyof CorpusSummary['tuples']} */ (bucket)].map((entry) => entry.test);

    assert.deepEqual(ids('new_failing_on_base'), ['tests::test_d']);
    assert.deepEqual(ids('modified'), ['tests::test_b']);
    assert.deepEqual(ids('removed_same'), ['tests::test_c']);
    assert.deepEqual(ids('head_mismatch'), []);
    assert.equal(summary.tuples.new_failing_on_base[0].in_diff, true);
    assert.equal(summary.deltas.tuple, 1);
    assert.equal(summary.probes.filter((entry) => entry.origin === 'pr').length, 1);

    const prProbe = summary.probes.find((entry) => entry.probe === 'color/pr-one');

    assert.deepEqual(prProbe?.assert.head, { idempotent: true, 'output-contains:"red"': true });

    const cases = /** @type {CorpusCase[]} */ (readJsonl(join(run.path, 'corpus', 'cases.jsonl')));

    assert.ok(cases.every((corpusCase) => !('tuple' in corpusCase)));
    assert.ok(cases.some((corpusCase) => corpusCase.id.startsWith('m-p-color/pr-one-')));

    const outputIds = readJsonl(join(run.path, 'corpus', 'outputs-head.jsonl')).map(
      (row) => /** @type {{ id: string }} */ (row).id,
    );

    assert.deepEqual(outputIds, outputIds.toSorted());
    assert.equal(outputIds.length, cases.length);
    assert.match(
      stderr,
      /\[lcr\] deltas: \{'tuple': 1, 'mutation': \d+\}; robustness head=0 base=0; tuple changes: /,
    );
    assert.ok(readFileSync(join(run.path, 'corpus.json'), 'utf8').endsWith('}\n'));
  });

  test('missing stages and adapters', async () => {
    using run = tempDir();

    await assert.rejects(corpus(run.path), { message: 'run `lcr prepare` and `lcr build` first' });

    makeRun(run.path);
    writeFiles(run.path, { 'bin/base-adapter': '' });

    using cache = tempDir();
    using _env = withEnv({ LCR_CACHE: cache.path });

    rmSync(join(run.path, 'bin', 'head-adapter'));
    await assert.rejects(
      captureOutput(() => corpus(run.path, { wpt: 'none', realworld: 'none' })),
      { message: 'adapters missing; `lcr build` must succeed for both sides first' },
    );
  });
});

describe('case sources', () => {
  test('tuples merge base and head by identity', () => {
    using run = tempDir();

    makeRun(run.path);

    const prep = /** @type {Prepare} */ (readJson(join(run.path, 'prepare.json')));
    const { cases, stats } = tupleCases(run.path, prep);

    assert.deepEqual(
      cases
        .map((tupleCase) => [tupleCase.test, tupleCase.side, tupleCase.line_side, tupleCase.in_diff])
        .toSorted(),
      [
        ['tests::test_a', 'both', 'head', false],
        ['tests::test_b', 'base', 'base', false],
        ['tests::test_b', 'head', 'head', true],
        ['tests::test_c', 'base', 'base', false],
        ['tests::test_d', 'head', 'head', true],
      ],
    );
    assert.equal(stats.unmappable, 1);
    assert.ok(cases.every((tupleCase) => tupleCase.id.startsWith('t-')));
  });

  test('inRanges', () => {
    assert.ok(
      inRanges(5, [
        [1, 3],
        [5, 5],
      ]),
    );
    assert.ok(
      !inRanges(4, [
        [1, 3],
        [5, 5],
      ]),
    );
    assert.ok(!inRanges(null, [[1, 3]]));
  });

  test('the WPT lane wraps lowering modes in a style rule', () => {
    using cache = tempDir();
    using _env = withEnv({ LCR_CACHE: cache.path });
    const commit = /** @type {{ commit: string }} */ (
      JSON.parse(readFileSync(new URL('../../../config/wpt.json', import.meta.url), 'utf8'))
    ).commit;

    writeFiles(cache.path, {
      [`wpt/fixtures-${commit.slice(0, 12)}.json`]: {
        cases: [
          { id: 'w1', file: 'f.html', kind: 'valid', property: 'color', value: 'red', expected: 'red' },
          { id: 'w2', file: 'f.html', kind: 'invalid', property: 'color', value: 'a;b' },
        ],
      },
    });

    const cases = wptCases('auto');
    const lowered = cases.filter((wptCase) => wptCase.request.kind === 'sheet');

    assert.ok(cases.length > 0);
    assert.ok(lowered.every((wptCase) => wptCase.request.css === '.t{color:red}'));
    assert.ok(cases.every((wptCase) => /^w-[0-9a-f]{16}$/.test(wptCase.id)));
    assert.equal(
      /** @type {{ wpt: { expected: unknown } }} */ (
        /** @type {unknown} */ (cases.find((c) => c.request.value === 'a;b'))
      ).wpt.expected,
      null,
    );
    assert.deepEqual(wptCases('none'), []);
  });

  test('missing WPT fixtures and real-world files are logged, not fatal', async () => {
    using cache = tempDir();
    using _env = withEnv({ LCR_CACHE: cache.path });
    const { stderr, result } = await captureOutput(() => [...wptCases('all'), ...realworldCases('auto')]);

    assert.deepEqual(result, []);
    assert.ok(stderr.includes('[lcr] WPT fixtures missing; run `lcr wpt` once to enable the WPT lane'));
    assert.ok(stderr.includes('real-world corpus not downloaded'));
    assert.deepEqual(realworldCases('none'), []);
  });

  test('mode requests come from config/modes.json', () => {
    assert.deepEqual(Object.keys(modeRequest('minify')), ['minify', 'compact', 'targets']);
  });

  test('disk need counts every CSS four times plus headroom', () => {
    const cases = /** @type {CorpusCase[]} */ (
      /** @type {unknown} */ ([{ request: { css: 'abc' } }, { request: { kind: 'value' } }])
    );

    assert.equal(diskNeed(cases), 100 * 2 ** 20 + 4 * (3 + 200 + 200));
  });
});
