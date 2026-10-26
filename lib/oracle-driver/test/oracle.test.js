/**
 * The oracle stage's file handling that runs without Docker: dropping the cases of deleted probes,
 * fresh output directories and the disk estimate.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { tempDir, writeFiles } from '../../../test/helpers/index.js';
import { readJson, readJsonl } from '../../core/files.js';
import { dropCases, freshDirectory } from '../oracle.js';
import { oracleDiskNeed } from '../pipeline.js';

describe('dropCases', () => {
  test('removes the cases from oracle.json and verdicts.jsonl', () => {
    using dir = tempDir();

    writeFiles(dir.path, {
      'oracle.json': { stats: { selected: 2 }, verdicts: { 'p-a/x': [1], 't-1': [2] }, dom: { 'p-a/x': {} } },
      'oracle/verdicts.jsonl': [
        { case: 'p-a/x', id: 'p-a/x' },
        { case: 't-1', id: 't-1' },
      ],
    });
    dropCases(dir.path, new Set(['p-a/x']));

    assert.deepEqual(readJson(join(dir.path, 'oracle.json')), {
      stats: { selected: 2 },
      verdicts: { 't-1': [2] },
      dom: {},
    });
    assert.deepEqual(readJsonl(join(dir.path, 'oracle', 'verdicts.jsonl')), [{ case: 't-1', id: 't-1' }]);
  });

  test('does nothing without oracle files', () => {
    using dir = tempDir();

    dropCases(dir.path, new Set(['p-a/x']));
    assert.ok(!existsSync(join(dir.path, 'oracle.json')));
    assert.ok(!existsSync(join(dir.path, 'oracle', 'verdicts.jsonl')));
  });

  test('an empty oracle.json is left alone', () => {
    using dir = tempDir();

    writeFiles(dir.path, { 'oracle.json': '{}\n' });
    dropCases(dir.path, new Set(['p-a/x']));
    assert.equal(readFileSync(join(dir.path, 'oracle.json'), 'utf8'), '{}\n');
  });
});

describe('helpers', () => {
  test('freshDirectory empties a directory', () => {
    using dir = tempDir();
    const out = join(dir.path, 'oracle');

    writeFiles(out, { 'old.txt': 'x' });
    assert.equal(freshDirectory(out), out);
    assert.ok(existsSync(out));
    assert.ok(!existsSync(join(out, 'old.txt')));
  });

  test('freshDirectory refuses a symbolic link and leaves its target alone', () => {
    using dir = tempDir();
    const target = join(dir.path, 'shared');
    const link = join(dir.path, 'selftest');

    writeFiles(target, { 'keep.txt': 'x' });
    symlinkSync(target, link);
    assert.throws(() => freshDirectory(link), {
      message: /^cannot replace .*selftest: it is a symbolic link; remove the link/,
    });
    assert.ok(existsSync(join(target, 'keep.txt')));
  });

  test('disk need: 200 MiB plus 512 KiB per case', () => {
    assert.equal(oracleDiskNeed(0), 200 * 2 ** 20);
    assert.equal(oracleDiskNeed(4), 200 * 2 ** 20 + 4 * 512 * 2 ** 10);
  });
});
