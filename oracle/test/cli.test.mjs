import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { tempDir, writeFiles } from '../../test/helpers/index.js';
import { USAGE_EXIT, parseOptions } from '../lib/cli.mjs';

// The analysis scripts end to end, on the host (css-tree, colorjs.io and pngjs are dev
// dependencies). The engine runner needs Playwright and the spec script @webref/css: both run in
// the Docker images only and are covered by the oracle parity checks.
const ORACLE = join(import.meta.dirname, '..');

/**
 * @param {string} script
 * @param {string[]} args
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function node(script, args) {
  return spawnSync(process.execPath, [join(ORACLE, script), ...args], { encoding: 'utf8' });
}

/**
 * @param {string} file
 * @returns {any[]}
 */
function rows(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const CASES = [
  {
    id: 'p-a/one',
    kind: 'sheet',
    sheets: { input: '.a{color:red}', base: '.a{color:red}', head: '.a{color:#00f}' },
    targets: { safari: 1 << 16 },
  },
  {
    id: 'p-a/dark',
    kind: 'sheet',
    sheets: { input: '.a{color:light-dark(red,blue)}', base: '', head: null },
    targets: null,
  },
  {
    id: 'w-1',
    kind: 'property',
    property: 'color',
    value: 'red',
    wptKind: 'valid',
    outputs: { base: 'color:red', head: 'color:red' },
    targets: null,
  },
];

describe('prepare-jobs.mjs', () => {
  test('reference mode writes jobs and meta rows', () => {
    using dir = tempDir();

    writeFiles(dir.path, { 'cases.jsonl': CASES });

    const result = node('prepare-jobs.mjs', [
      '--cases',
      join(dir.path, 'cases.jsonl'),
      '--out',
      join(dir.path, 'jobs.jsonl'),
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      rows(join(dir.path, 'jobs.jsonl')).map((job) => job.id),
      ['p-a/one', 'p-a/dark', 'p-a/dark~dark', 'w-1'],
    );
    // --meta defaults to <out>.meta.
    assert.deepEqual(
      rows(join(dir.path, 'jobs.jsonl.meta')).map((meta) => [meta.id, meta.dark ?? false]),
      [
        ['p-a/one', false],
        ['p-a/dark', true],
        ['w-1', false],
      ],
    );
  });

  test('legacy mode writes the requested sheet jobs in id order, narrowed per engine', () => {
    using dir = tempDir();
    const touched = { 'div#0': { color: 'rgb(255, 0, 0)' } };

    writeFiles(dir.path, {
      'cases.jsonl': CASES,
      'results.jsonl': [
        { id: 'w-1', engine: 'webkit', result: { baseline: null, variants: {} } },
        { id: 'p-a/one', engine: 'webkit', result: { variants: { input: { touched } } } },
        { id: 'p-a/dark', engine: 'webkit', result: { variants: { input: { touched } } } },
      ],
    });
    node('prepare-jobs.mjs', [
      '--cases',
      join(dir.path, 'cases.jsonl'),
      '--out',
      join(dir.path, 'jobs.jsonl'),
    ]);

    const args = [
      '--legacy',
      '--jobs',
      join(dir.path, 'jobs.jsonl'),
      '--results',
      join(dir.path, 'results.jsonl'),
    ];

    assert.equal(
      node('prepare-jobs.mjs', [...args, '--out', join(dir.path, 'all.jsonl'), '--ids', '']).status,
      0,
    );
    assert.deepEqual(
      rows(join(dir.path, 'all.jsonl')).map((job) => [job.id, job.visual, job.propsByEngine.webkit]),
      [
        ['p-a/dark', false, ['color']],
        ['p-a/one', false, ['color']],
      ],
    );

    node('prepare-jobs.mjs', [...args, '--out', join(dir.path, 'one.jsonl'), '--ids', 'p-a/one']);
    assert.deepEqual(
      rows(join(dir.path, 'one.jsonl')).map((job) => job.id),
      ['p-a/one'],
    );
  });

  test('without --out nothing is written', () => {
    using dir = tempDir();

    writeFiles(dir.path, { 'cases.jsonl': CASES });

    assert.equal(node('prepare-jobs.mjs', ['--cases', join(dir.path, 'cases.jsonl')]).status, 0);
    assert.equal(existsSync(join(dir.path, 'jobs.jsonl')), false);
  });

  test('a case that cannot become a job is reported in the meta file and skipped', () => {
    using dir = tempDir();

    writeFiles(dir.path, { 'cases.jsonl': [{ id: 'broken', kind: 'sheet' }, CASES[2]] });
    node('prepare-jobs.mjs', [
      '--cases',
      join(dir.path, 'cases.jsonl'),
      '--out',
      join(dir.path, 'jobs.jsonl'),
      '--meta',
      join(dir.path, 'meta.jsonl'),
    ]);

    assert.deepEqual(
      rows(join(dir.path, 'jobs.jsonl')).map((job) => job.id),
      ['w-1'],
    );
    assert.match(rows(join(dir.path, 'meta.jsonl'))[0].error, /Cannot convert undefined or null to object/);
  });
});

describe('usage errors', () => {
  test('parseOptions returns the typed values with their defaults', () => {
    const options = parseOptions(
      { out: { type: 'string' }, ids: { type: 'string', default: '' }, legacy: { type: 'boolean' } },
      'usage',
      ['--out', 'o', '--legacy'],
    );

    assert.deepEqual({ ...options }, { out: 'o', ids: '', legacy: true });
  });

  test('a malformed command line prints the usage and exits 2 without writing anything', () => {
    using dir = tempDir();

    writeFiles(dir.path, { 'cases.jsonl': CASES });

    const cases = ['--cases', join(dir.path, 'cases.jsonl')];
    const out = join(dir.path, 'jobs.jsonl');

    for (const [script, args] of /** @type {[string, string[]][]} */ ([
      ['prepare-jobs.mjs', [...cases, '--out', out, '--bogus']],
      ['prepare-jobs.mjs', [...cases, 'stray', '--out', out]],
      ['prepare-jobs.mjs', [...cases, '--legacy', '--out', out, '--ids']],
      ['compare.mjs', [...cases, '--env', join(dir.path, 'env.json'), '--out']],
    ])) {
      const result = node(script, args);

      assert.equal(result.status, USAGE_EXIT, `${script} ${args.join(' ')}`);
      assert.match(result.stderr, new RegExp(`^usage: ${script}`, 'm'));
      assert.equal(existsSync(out), false);
    }
  });
});

describe('compare.mjs', () => {
  test('writes one verdict per job, sorted, across profiles', () => {
    using dir = tempDir();
    const touched = { 'div#0': { color: 'rgb(255, 0, 0)' } };
    const reference = (/** @type {string} */ engine) => ({
      id: 'p-a/one',
      engine,
      version: '1',
      ms: 3,
      result: {
        elements: [],
        variants: {
          empty: { info: {} },
          input: { info: {}, touched },
          base: { info: {}, diff: [] },
          head: { info: {}, diff: [['div#0', 'color', 'rgb(255, 0, 0)', 'rgb(0, 0, 255)']] },
        },
      },
    });

    writeFiles(dir.path, {
      'cases.jsonl': CASES,
      'env.json': { profiles: { latest: { role: 'reference' }, 'legacy-2023': { role: 'legacy' } } },
      'latest.jsonl': [reference('webkit'), reference('chromium')],
      'legacy.jsonl': [{ id: 'p-a/one', engine: 'webkit', version: '16.4', ms: 2, error: 'crashed' }],
    });
    node('prepare-jobs.mjs', [
      '--cases',
      join(dir.path, 'cases.jsonl'),
      '--out',
      join(dir.path, 'jobs.jsonl'),
    ]);

    const result = node('compare.mjs', [
      ...['--cases', join(dir.path, 'cases.jsonl'), '--jobs', join(dir.path, 'jobs.jsonl')],
      ...['--env', join(dir.path, 'env.json'), '--out', join(dir.path, 'verdicts.jsonl')],
      ...[
        '--results',
        `legacy-2023=${join(dir.path, 'legacy.jsonl')}`,
        '--results',
        `latest=${join(dir.path, 'latest.jsonl')}`,
      ],
    ]);

    assert.equal(result.status, 0, result.stderr);

    const verdicts = rows(join(dir.path, 'verdicts.jsonl'));

    assert.deepEqual(
      verdicts.map((v) => [v.id, v.scheme, v.summary.latest.transition]),
      [
        ['p-a/dark', 'light', 'unverified'],
        ['p-a/dark~dark', 'dark', 'unverified'],
        ['p-a/one', 'light', 'regressed'],
        ['w-1', 'light', 'unverified'],
      ],
    );
    assert.deepEqual(Object.keys(verdicts[2].latest), ['chromium', 'webkit']);
    assert.equal(verdicts[2].summary.legacy['legacy-2023'].transition, 'errored');
  });
});
