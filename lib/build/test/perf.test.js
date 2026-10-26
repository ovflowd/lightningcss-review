import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { asPythonJson, buildGolden } from '../../../test/fixtures/build/golden.js';
import { tempDir, withEnv, writeFiles } from '../../../test/helpers/index.js';
import { pyFloat, pyStr } from '../../core/py.js';
import { jsonFileText } from '../../core/pyjson.js';
import { buildRelease, perf, perfRow, summarizePerf, timeOnce } from '../perf.js';

/** @import { RunResult } from '../../core/proc.js' */

test('the release build touches the export first, then copies the binary', async () => {
  using dir = tempDir();
  const run = join(dir.path, 'run');
  const cache = join(dir.path, 'cache');
  const src = join(run, 'src', 'head', 'src', 'lib.rs');
  const old = new Date(Date.now() - 86_400_000);
  /** @type {number[]} */
  const seen = [];

  using _env = withEnv({ LCR_CACHE: cache });

  mkdirSync(join(run, 'src', 'head', 'src'), { recursive: true });
  writeFileSync(src, 'x');
  utimesSync(src, old, old);

  const runHost = async (/** @type {readonly string[]} */ argv) => {
    seen.push(statSync(src).mtimeMs);
    mkdirSync(join(cache, 'targets', 'head-release', 'release'), { recursive: true });
    writeFileSync(join(cache, 'targets', 'head-release', 'release', 'lightningcss'), 'bin');

    return /** @type {RunResult} */ ({
      argv,
      code: 0,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: '',
    });
  };
  const dest = await buildRelease(run, 'head', { host: true, runHost });

  assert.ok(seen[0] > old.getTime() + 3_600_000);
  assert.equal(readFileSync(dest, 'utf8'), 'bin');
  assert.equal(statSync(dest).mode & 0o777, 0o755);
});

test('perf rows and totals round as py-final does (NaN, 0.0 base, int totals)', () => {
  for (const [files, sizes, repeats, expected] of buildGolden().perf_summary) {
    const rows = files.map((/** @type {[string, any]} */ [name, samples]) =>
      perfRow(name, { base: samples.base.map(Number), head: samples.head.map(Number) }),
    );

    assert.equal(asPythonJson(summarizePerf(rows, { sizes, repeats })), asPythonJson(expected));
  }
});

test("totals add up as Python's sum() does, which can decide the rounded ratio", () => {
  // Ten 0.1 ms files: a naive sum is 0.9999999999999999, CPython's compensated sum 1.0, and
  // 1.00105 / 1.0 rounds to 1.001 where 1.00105 / 0.9999999999999999 rounds to 1.0011.
  const rows = Array.from({ length: 10 }, (_, index) => ({
    name: `f${index}`,
    base_ms: pyFloat(0.1),
    head_ms: pyFloat(index === 0 ? 1.00105 : 0),
    ratio: null,
  }));
  const summary = summarizePerf(rows, { sizes: { base: 1, head: 1 }, repeats: 9 });

  assert.equal(pyStr(summary.total_ms.base), '1.0');
  assert.equal(pyStr(summary.total_ratio), '1.001');
});

test('timeOnce measures a successful run and gives NaN for a failed one', () => {
  using dir = tempDir();
  const ok = join(dir.path, 'ok');
  const bad = join(dir.path, 'bad');

  writeFileSync(ok, '#!/bin/sh\nexit 0\n');
  writeFileSync(bad, '#!/bin/sh\nexit 1\n');
  chmodSync(ok, 0o755);
  chmodSync(bad, 0o755);

  assert.ok(timeOnce(ok, 'x.css') > 0);
  assert.ok(Number.isNaN(timeOnce(bad, 'x.css')));
});

test('stale release binaries skip the timing and say why in perf.json', async (t) => {
  using dir = tempDir();
  const runDir = join(dir.path, 'run');
  const bin = join(dir.path, 'bin');
  const timed = join(dir.path, 'timed');

  // A cargo whose release build is the same script on both sides: byte-identical binaries.
  writeFiles(dir.path, {
    'run/prepare.json': { files: { 'src/lib.rs': {} } },
    'run/src/base/src/lib.rs': 'base',
    'run/src/head/src/lib.rs': 'head',
    'bin/cargo': `#!/bin/sh\nmkdir -p "$CARGO_TARGET_DIR/release"\nprintf '#!/bin/sh\\ntouch ${timed}\\n' > "$CARGO_TARGET_DIR/release/lightningcss"\n`,
  });
  chmodSync(join(bin, 'cargo'), 0o755);

  using _env = withEnv({
    LCR_BUILD: 'host',
    LCR_CACHE: join(dir.path, 'cache'),
    PATH: `${bin}:${process.env.PATH}`,
  });
  // Only stderr is silenced: node:test reports other tests' results on this process's stdout.
  const stderr = t.mock.method(process.stderr, 'write', () => true);
  const data = await perf(runDir, { files: [['x', join(dir.path, 'x.css')]] });

  stderr.mock.restore();

  assert.match(/** @type {string} */ (data.skip_reason), /byte-identical/);
  assert.equal(data.repeats, 0);
  assert.equal(readFileSync(join(runDir, 'perf.json'), 'utf8'), jsonFileText(data));
  assert.throws(() => statSync(timed), 'a stale build was timed');
});

test('perf refuses to run without a real-world corpus', async () => {
  using dir = tempDir();

  await assert.rejects(perf(dir.path, { files: [] }), {
    message: 'real-world corpus missing; run `lcr realworld`',
  });
});
