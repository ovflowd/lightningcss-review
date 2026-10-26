import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { tempDir, writeFiles } from '../../test/helpers/index.js';
import { sheetJob } from '../lib/jobs.mjs';
import { collectResults, resultProfiles, verdictRow } from '../lib/verdicts.mjs';

/** @import { Job, OracleCase, SheetCase } from '../lib/types.mjs' */

describe('resultProfiles', () => {
  test('roles come from env.json, latest defaults to reference, and the reference goes first', () => {
    const profiles = resultProfiles(['legacy-2023=/r/a.jsonl', 'latest=/r/b.jsonl', 'x=/r/c.jsonl'], {
      profiles: { x: { role: 'reference' } },
    });

    assert.deepEqual(profiles, [
      { name: 'latest', file: '/r/b.jsonl', role: 'reference' },
      { name: 'x', file: '/r/c.jsonl', role: 'reference' },
      { name: 'legacy-2023', file: '/r/a.jsonl', role: 'legacy' },
    ]);
  });
});

describe('collectResults and verdictRow', () => {
  /** @type {SheetCase} */
  const sheetCase = {
    id: 'p-a/b',
    kind: 'sheet',
    sheets: { input: '.a{color:red}', base: '.a{color:red}', head: '.a{color:#00f}' },
    targets: { safari: 1 << 16 },
  };
  const job = /** @type {Job} */ (sheetJob(sheetCase).jobs[0]);
  const touched = { 'div#0': { color: 'rgb(255, 0, 0)' } };
  const reference = (/** @type {string} */ engine) => ({
    id: 'p-a/b',
    engine,
    version: '1',
    ms: 1,
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
  const legacy = {
    id: 'p-a/b',
    engine: 'webkit',
    version: '16.4',
    ms: 1,
    result: {
      elements: [],
      variants: {
        input: { info: {}, values: { 'div#0': { color: 'rgb(255, 0, 0)' } } },
        base: { info: {}, values: { 'div#0': { color: 'rgb(255, 0, 0)' } } },
        head: { info: {}, values: { 'div#0': { color: 'rgb(255, 0, 0)' } } },
      },
    },
  };

  test('reference and legacy entries are filed per profile and engine, sorted, with summaries', async () => {
    using dir = tempDir();

    writeFiles(dir.path, {
      'latest.jsonl': [
        reference('webkit'),
        reference('chromium'),
        { ...reference('firefox'), id: 'unknown-job' },
      ],
      'legacy.jsonl': [legacy],
    });

    const profiles = resultProfiles(
      [`legacy-2023=${join(dir.path, 'legacy.jsonl')}`, `latest=${join(dir.path, 'latest.jsonl')}`],
      {},
    );
    const cases = new Map([[sheetCase.id, /** @type {OracleCase} */ (sheetCase)]]);
    const results = await collectResults(profiles, new Map([[job.id, job]]), cases, null);
    const row = verdictRow(job.id, job, sheetCase, profiles, results);

    assert.deepEqual(Object.keys(row), ['id', 'case', 'kind', 'scheme', 'latest', 'legacy', 'summary']);
    assert.deepEqual([row.case, row.kind, row.scheme], ['p-a/b', 'sheet', 'light']);
    assert.deepEqual(Object.keys(row.latest), ['chromium', 'webkit']);
    assert.equal(row.summary?.latest.transition, 'regressed');
    assert.deepEqual(Object.keys(row.legacy), ['legacy-2023']);
    assert.equal(row.legacy['legacy-2023'].webkit.shared, 0);
    assert.equal(row.summary?.legacy['legacy-2023'].transition, 'both-equivalent');
  });

  test('a job without results still gets a row; dark twins are marked', async () => {
    const dark = /** @type {Job} */ ({ ...job, id: 'p-a/b~dark' });
    const row = verdictRow(dark.id, dark, {}, [], { buckets: new Map(), refTouched: new Map() });

    assert.deepEqual(
      [row.case, row.scheme, row.latest, row.legacy, row.summary?.latest.transition],
      ['p-a/b', 'dark', {}, {}, 'unverified'],
    );
  });

  test('screenshots and screenshot errors are attached to the entry', async () => {
    using dir = tempDir();

    writeFiles(dir.path, {
      'latest.jsonl': [
        { ...reference('chromium'), shots: { input: 'h', base: 'h', head: 'x' }, visualError: 'timeout' },
      ],
    });

    const profiles = resultProfiles([`latest=${join(dir.path, 'latest.jsonl')}`], {});
    const results = await collectResults(profiles, new Map([[job.id, job]]), new Map(), null);
    const entry = results.buckets.get(job.id)?.latest.chromium;

    assert.deepEqual(
      [entry?.visual, entry?.visualError],
      [{ base: 'pixel-identical', head: 'pixel-different' }, 'timeout'],
    );
    assert.deepEqual(Object.keys(entry ?? {}).slice(-2), ['visual', 'visualError']);
  });
});
