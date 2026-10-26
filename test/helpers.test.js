import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { readJson, readJsonl } from '../lib/core/files.js';
import { SyntheticRun, mutationCase, probeCase, verdict } from './helpers/synthetic-run.js';
import { captureOutput, fromHexFloat, tempDir, writeFiles } from './helpers/index.js';

test('SyntheticRun writes every stage file the report reads', () => {
  let root;

  {
    using run = new SyntheticRun();

    root = run.root;
    run.addCase(probeCase('p-color/a'), { delta: true });
    run.addCase(mutationCase('p-color/a', 'nest'));
    run.oracle = {
      ...run.oracle,
      verdicts: {
        'p-color/a': verdict('p-color/a', {
          head: 'different',
          transition: 'regressed',
          perEngine: { webkit: ['equivalent', 'equivalent'] },
        }),
      },
    };
    run.analysis = null;

    const dir = run.write();
    const corpus = /** @type {any} */ (readJson(join(dir, 'corpus.json')));
    const oracle = /** @type {any} */ (readJson(join(dir, 'oracle.json')));

    assert.deepEqual(corpus.cases, { mutation: 1, probe: 1 });
    assert.deepEqual(corpus.deltas, { probe: 1 });
    assert.deepEqual(
      readJsonl(join(dir, 'corpus', 'outputs-head.jsonl')).map((row) => /** @type {any} */ (row).code),
      ['a', 'ax'],
    );
    assert.deepEqual(oracle.verdicts['p-color/a'][0].summary.latest.enginesHead, {
      ok: ['webkit'],
      bad: ['chromium', 'firefox'],
      divergent: true,
    });
    assert.equal(existsSync(join(dir, 'analysis.json')), false);
  }

  assert.equal(existsSync(root), false);
});

test('writeFiles, captureOutput and fromHexFloat', async () => {
  using dir = tempDir();

  writeFiles(dir.path, { 'a/x.json': { b: 1 }, 'a/y.jsonl': [{ id: 'r' }], 'z.txt': 'text' });
  assert.deepEqual(readJson(join(dir.path, 'a', 'x.json')), { b: 1 });

  const captured = await captureOutput(() => {
    process.stdout.write('out');
    process.stderr.write('err');

    return 7;
  });

  assert.deepEqual(captured, { stdout: 'out', stderr: 'err', result: 7 });
  assert.equal(fromHexFloat('-0x1.8000000000000p+1'), -3);
  assert.equal(fromHexFloat('0x0.0000000000001p-1022'), 5e-324);
});
