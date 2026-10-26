import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { captureOutput, tempDir, withEnv, writeFiles } from '../../../test/helpers/index.js';
import { readJson, readJsonl } from '../../core/files.js';
import { probeTable, prProbeCaseIds, runProbes } from '../run-probes.js';
import { probeFilesHash } from '../sources.js';
import { fakeAdapter, writeProbe } from './support.js';

/** @import { CorpusCase, CorpusSummary, ProbeResult } from '../../types.js' */

/**
 * A run with fake adapters (base does not know `custom-functions`), three PR probes and an empty
 * corpus pass.
 *
 * @param {string} run
 * @returns {void}
 */
function makeRun(run) {
  fakeAdapter(join(run, 'bin'), 'base-adapter', { unknownFlag: 'custom-functions' });
  fakeAdapter(join(run, 'bin'), 'head-adapter');
  writeProbe(join(run, 'probes'), 'kept');
  writeProbe(join(run, 'probes'), 'gone');
  writeProbe(join(run, 'probes'), 'flagged', { extra: 'flags: custom-functions\n' });
  writeFiles(run, {
    'corpus/cases.jsonl': [],
    'corpus/outputs-base.jsonl': [],
    'corpus/outputs-head.jsonl': [],
    'corpus/deltas.jsonl': [],
    'corpus.json': {
      cases: {},
      deltas: {},
      robustness: { base: [], head: [] },
      probes: [],
      idempotency: {},
      idempotency_failures: [],
    },
  });
}

/**
 * @param {string} run
 * @returns {Set<string>}
 */
function caseIds(run) {
  return new Set(
    readJsonl(join(run, 'corpus', 'cases.jsonl')).map((row) => /** @type {CorpusCase} */ (row).id),
  );
}

describe('runProbes', () => {
  test('a re-run drops deleted probes from every stage', async () => {
    using run = tempDir();
    using cache = tempDir();
    using _env = withEnv({ LCR_CACHE: cache.path });

    makeRun(run.path);
    await captureOutput(() => runProbes(run.path));

    const first = caseIds(run.path);

    assert.ok(first.has('p-color/gone'));
    assert.ok([...first].some((id) => id.startsWith('m-p-color/gone-')));

    writeFiles(run.path, {
      'oracle.json': { verdicts: { 'p-color/gone': [], 'p-color/kept': [] }, dom: { 'p-color/gone': {} } },
      'oracle/verdicts.jsonl': [{ case: 'p-color/gone' }, { case: 'p-color/kept' }],
    });
    unlinkSync(join(run.path, 'probes', 'gone.css'));

    const { stdout, result } = await captureOutput(() => runProbes(run.path));
    const summary = /** @type {CorpusSummary} */ (result);

    assert.ok(!stdout.includes('color/gone'));
    assert.ok(stdout.includes('color/kept'));
    assert.ok(![...caseIds(run.path)].some((id) => id.includes('gone')));
    assert.ok(
      !readJsonl(join(run.path, 'corpus', 'outputs-head.jsonl')).some((row) =>
        /** @type {{ id: string }} */ (row).id.includes('gone'),
      ),
    );
    assert.ok(!Object.keys(summary.idempotency).some((id) => id.includes('gone')));
    assert.deepEqual(
      summary.probes.map((entry) => entry.probe),
      ['color/flagged', 'color/kept'],
    );
    assert.equal(summary.cases.probe, 2);
    assert.deepEqual(
      Object.keys(/** @type {{ verdicts: object }} */ (readJson(join(run.path, 'oracle.json'))).verdicts),
      ['p-color/kept'],
    );
    assert.deepEqual(readJsonl(join(run.path, 'oracle', 'verdicts.jsonl')), [{ case: 'p-color/kept' }]);

    const kept = summary.probes.find((entry) => entry.probe === 'color/kept');

    assert.equal(kept?.assert.head.idempotent, true);
    assert.equal(summary.flag_only['custom-functions'][0], 'm-p-color/flagged-duplicate-nonadjacent');
    assert.ok(summary.flag_only['custom-functions'].includes('p-color/flagged'));
    assert.equal(summary.probe_files, probeFilesHash(run.path));
  });

  test('cases that are not PR probes keep their place in the files', async () => {
    using run = tempDir();
    using cache = tempDir();
    using _env = withEnv({ LCR_CACHE: cache.path });

    makeRun(run.path);
    writeFiles(run.path, {
      'corpus/cases.jsonl': [
        { id: 't-x', source: 'tuple', request: { kind: 'sheet', css: 'a' } },
        { id: 'p-color/kept', source: 'probe', origin: 'pr', request: { kind: 'sheet', css: 'old' } },
        { id: 'm-t-x-nest', source: 'mutation', parent: 't-x', request: { kind: 'sheet', css: 'b' } },
      ],
      'corpus/deltas.jsonl': [{ id: 't-x', source: 'tuple', base: {}, head: {} }],
    });

    const { stderr } = await captureOutput(() => runProbes(run.path));
    const ids = [...caseIds(run.path)];

    assert.deepEqual(ids.slice(0, 2), ['t-x', 'm-t-x-nest']);
    assert.equal(ids[2], 'p-color/flagged');
    assert.ok(stderr.includes('[lcr] probes: '));

    const summary = /** @type {CorpusSummary} */ (readJson(join(run.path, 'corpus.json')));

    assert.equal(summary.deltas.tuple, 1);
  });

  test('no corpus pass yet', async () => {
    using run = tempDir();

    await assert.rejects(runProbes(run.path), { message: 'run `lcr corpus` first' });
  });

  test('without PR probes nothing runs and the table says so', async () => {
    using run = tempDir();
    using cache = tempDir();
    using _env = withEnv({ LCR_CACHE: cache.path });

    makeRun(run.path);

    for (const slug of ['kept', 'gone', 'flagged']) {
      unlinkSync(join(run.path, 'probes', `${slug}.css`));
    }

    const { stdout, stderr } = await captureOutput(() => runProbes(run.path));

    assert.equal(stdout, 'PR probes: none\n');
    assert.ok(stderr.includes('[lcr] no PR probes found in <run>/probes'));
  });
});

describe('prProbeCaseIds', () => {
  test('PR probes and mutations of probes', () => {
    const cases = new Map(
      /** @type {[string, CorpusCase][]} */ (
        /** @type {unknown} */ ([
          ['p-a', { source: 'probe', origin: 'pr' }],
          ['p-b', { source: 'probe', origin: 'curated' }],
          ['m-p-b-nest', { source: 'mutation', parent: 'p-b' }],
          ['m-t-x-nest', { source: 'mutation', parent: 't-x' }],
        ])
      ),
    );

    assert.deepEqual([...prProbeCaseIds(cases)], ['p-a', 'm-p-b-nest']);
  });
});

describe('probeTable', () => {
  test('one block per probe', () => {
    /** @type {ProbeResult[]} */
    const entries = [
      /** @type {ProbeResult} */ (
        /** @type {unknown} */ ({
          id: 'p-a/x',
          probe: 'a/x',
          changed: true,
          assert: {
            base: { equivalent: null, 'output-contains:"r"': false },
            head: { equivalent: null, 'output-contains:"r"': true },
          },
          crash: { head: 'timeout' },
        })
      ),
    ];
    const lines = probeTable(entries, { 'p-a/x': { stable: true, second: null } }, {}).split('\n');

    assert.equal(lines[0], 'PR probes: 1 (changed on head: 1)');
    assert.ok(lines[2].includes('a/x  [changed]'));
    assert.deepEqual(lines[3].split(/\s+/).slice(-2), ['FAIL', 'pass']);
    assert.ok(lines[4].includes('(re-minify stable)'));
    assert.deepEqual(lines[4].split(/\s+/).slice(-2), ['-', 'pass']);
    assert.deepEqual(lines[5].split(/\s+/).slice(-2), ['-', 'timeout']);
    assert.equal(
      lines.join('\n'),
      [
        'PR probes: 1 (changed on head: 1)',
        'probe           assertion            base  head',
        'a/x  [changed]  equivalent           -     -',
        '                output-contains:"r"  FAIL  pass',
        '                (re-minify stable)   -     pass',
        '                crash                -     timeout',
      ].join('\n'),
    );
  });

  test('no entries', () => {
    assert.equal(probeTable([]), 'PR probes: none');
  });
});
