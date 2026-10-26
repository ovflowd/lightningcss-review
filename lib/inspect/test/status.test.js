/**
 * `lcr status`: done and stale stages, the probe row, the mtime fallback for oracles without input
 * digests, and the printed table.
 */
import assert from 'node:assert/strict';
import { utimesSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { driverGolden, printed, writeScenario } from '../../../test/fixtures/driver/golden.js';
import { captureOutput, tempDir, writeFiles } from '../../../test/helpers/index.js';
import { SyntheticRun } from '../../../test/helpers/synthetic-run.js';
import { writeJson } from '../../core/files.js';
import { openAnalysisSlots, stageRows, status } from '../status.js';

describe('stage rows', () => {
  test('open slots and a stale oracle', () => {
    using run = new SyntheticRun();

    /** @type {any} */ (run.analysis).deltas = [{ id: 'x', classification: '' }];

    const dir = run.write();

    writeJson(join(dir, 'oracle.json'), { ...run.oracle, inputs: { cases: '0'.repeat(64) } });

    const rows = new Map(stageRows(dir));

    assert.equal(rows.get('analysis'), 'open (1 slots; refresh with `lcr worklist`)');
    assert.ok(rows.get('oracle')?.includes('stale'));
    assert.equal(rows.get('probe'), '-');
  });

  test('an oracle without digests is stale when cases.jsonl is newer; errored cases are counted', () => {
    using run = new SyntheticRun();

    /** @type {any} */ (run.oracle).verdicts = {
      'p-a/x': [{ summary: { latest: { transition: 'errored' } } }],
    };

    const dir = run.write();
    const past = new Date('2020-01-01T00:00:00Z');

    utimesSync(join(dir, 'oracle.json'), past, past);
    assert.equal(
      new Map(stageRows(dir)).get('oracle'),
      'done; stale: the corpus changed after the oracle ran; 1 errored case(s)',
    );
  });

  test('probe files newer than the corpus or not all in it', () => {
    using run = new SyntheticRun();

    /** @type {any} */ (run.corpus).probes = [{ id: 'p-a/x', origin: 'pr' }];

    const dir = run.write();
    const past = new Date('2020-01-01T00:00:00Z');

    writeFiles(dir, { 'probes/a/x.css': '.t{}' });
    utimesSync(join(dir, 'probes', 'a', 'x.css'), past, past);
    assert.equal(new Map(stageRows(dir)).get('probe'), '1 file(s), 1 in corpus');

    writeFiles(dir, { 'probes/a/.y.css': '.t{}' });
    assert.equal(new Map(stageRows(dir)).get('probe'), '2 file(s), 1 in corpus; stale: run `lcr probe`');
  });

  test('open slots count checklist answers, unclassified live deltas and the intent', () => {
    assert.equal(
      openAnalysisSlots({
        checklist: [/** @type {any} */ ({ answer: '' }), { answer: 'PASS', evidence: '' }],
        deltas: [
          /** @type {any} */ ({ id: 'a' }),
          { id: 'b', _stale: true },
          { id: 'c', classification: 'INTENDED' },
        ],
      }),
      3,
    );
  });
});

describe('status', () => {
  test('prints the table and the verdict', async () => {
    using run = new SyntheticRun();
    const dir = run.write();
    const past = new Date('2020-01-01T00:00:00Z');

    utimesSync(join(dir, 'corpus', 'cases.jsonl'), past, past);
    writeJson(join(dir, 'report.json'), {
      verdict: 'SAFE',
      verdict_scope: 'flag x only',
      counts: { BLOCKER: 0, MAJOR: 0, MINOR: 0, NOTE: 1 },
    });

    const { stdout } = await captureOutput(() => status(dir));

    assert.equal(
      stdout,
      [
        'run       run',
        'prepare   done',
        'build     done',
        'corpus    done',
        'probe     -',
        'oracle    done',
        'analysis  done',
        'report    done',
        "verdict   SAFE (flag x only) {'BLOCKER': 0, 'MAJOR': 0, 'MINOR': 0, 'NOTE': 1}",
        '',
      ].join('\n'),
    );
  });
});

describe('golden output', () => {
  test('changed probe files make the oracle stale; unknown recorded inputs are ignored', async () => {
    for (const scenario of driverGolden().status) {
      using dir = tempDir();
      const run = writeScenario(join(dir.path, 'run'), scenario);
      const [{ stdout, error }] = scenario.calls;

      assert.deepEqual(await printed(run, () => status(run)), { stdout, error });
    }
  });
});
