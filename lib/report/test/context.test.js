/**
 * The evaluation context: missing, empty and falsy stage files read as `{}`, and the check
 * recorder's item ranking and cap.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { tempDir } from '../../../test/helpers/index.js';
import { mutationCase, probeCase } from '../../../test/helpers/synthetic-run.js';
import { loadConfig } from '../../core/paths.js';
import { CheckRecorder, stageFile } from '../context.js';
import { ELLIPSIS } from '../glyphs.js';
import { check, evaluateRun, reportRun } from './support.js';

/** @import { ChecksConfig } from '../../types.js' */

const CONFIG = /** @type {ChecksConfig} */ (loadConfig('checks.json'));

describe('stage files', () => {
  test('a missing, empty or falsy stage file reads as {}', () => {
    using dir = tempDir();

    writeFileSync(join(dir.path, 'empty.json'), '{}');
    writeFileSync(join(dir.path, 'null.json'), 'null');
    writeFileSync(join(dir.path, 'list.json'), '[]');
    writeFileSync(join(dir.path, 'full.json'), '{"a": 1}');

    for (const name of ['missing.json', 'empty.json', 'null.json', 'list.json']) {
      assert.deepEqual(stageFile(dir.path, name), {}, name);
    }

    assert.deepEqual(stageFile(dir.path, 'full.json'), { a: 1 });
  });
});

describe('check recorder', () => {
  test('items are listed in evidence rank order, ties in their own order', () => {
    const ranks = new Map([
      ['realworld', 5],
      ['wpt', 4],
      ['mutation', 3],
      ['curated', 2],
      ['pr', 1],
      ['tuple', 0],
      ['unknown', 6],
    ]);
    const recorder = new CheckRecorder(CONFIG, (item) => ranks.get(item.split(' ')[0]) ?? 6);

    recorder.add('O1', 'FAIL', 'x', [
      'unknown a',
      'realworld',
      'pr 1',
      'tuple',
      'curated',
      'pr 2',
      'wpt',
      'mutation',
    ]);

    assert.deepEqual(recorder.rows[0].items, [
      'tuple',
      'pr 1',
      'pr 2',
      'curated',
      'mutation',
      'wpt',
      'realworld',
      'unknown a',
    ]);
  });

  test('a row lists max_listed_cases items and counts the rest; the full list is kept', () => {
    const recorder = new CheckRecorder(CONFIG, () => 0);
    const items = Array.from({ length: CONFIG.thresholds.max_listed_cases + 3 }, (_, index) => `c${index}`);

    recorder.add('O1', 'FAIL', '', items);

    assert.equal(recorder.rows[0].items.length, CONFIG.thresholds.max_listed_cases + 1);
    assert.equal(recorder.rows[0].items.at(-1), `${ELLIPSIS} 3 more`);
    assert.deepEqual(recorder.fullItems.get('O1'), items);
  });

  test('FAIL takes the catalog severity unless overridden; PASS carries none', () => {
    const recorder = new CheckRecorder(CONFIG, () => 0);

    recorder.add('O1', 'FAIL');
    recorder.add('O5', 'FAIL', '', [], { severity: 'NOTE' });
    recorder.add('O3', 'PASS');

    assert.deepEqual(
      recorder.rows.map((row) => row.severity),
      [CONFIG.checks.find((meta) => meta.id === 'O1')?.fail, 'NOTE', null],
    );
    assert.throws(() => recorder.add('Z9', 'PASS'), /Z9 is not in config\/checks.json/);
  });

  test('a run ranks PR tests, PR probes, curated probes, mutations, WPT, then real-world cases', () => {
    using run = reportRun();
    const tuple = run.addCase(
      {
        id: 't-1',
        source: 'tuple',
        side: 'head',
        test: 'tests::test_color',
        helper: 'minify_test',
        line: 1,
        request: { kind: 'sheet', css: 'a{}', minify: true },
      },
      { delta: true },
    );
    const curated = run.addCase(probeCase('p-color/a-curated', { origin: 'curated' }), { delta: true });
    const pr = run.addCase(probeCase('p-color/b-pr'), { delta: true });
    const mutation = run.addCase(mutationCase(pr, 'nest'), { delta: true });
    const realworld = run.addCase(
      { id: 'r-a', source: 'realworld', name: 'a', mode: 'minify', request: { kind: 'sheet', css: 'a{}' } },
      { delta: true },
    );
    const wpt = run.addCase(
      {
        id: 'w-a',
        source: 'wpt',
        mode: 'minify',
        wpt: { property: 'color', file: 'f', value: 'red', kind: 'valid' },
        request: { kind: 'property', property: 'color', value: 'red' },
      },
      { delta: true },
    );

    // O8 lists every delta without a verdict, in rank order.
    assert.deepEqual(check(evaluateRun(run), 'O8').items, [tuple, pr, curated, mutation, wpt, realworld]);
  });
});
