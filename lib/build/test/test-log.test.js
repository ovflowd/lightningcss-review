import assert from 'node:assert/strict';
import { test } from 'node:test';

import { asPythonJson, buildGolden } from '../../../test/fixtures/build/golden.js';
import { tempDir, writeFiles } from '../../../test/helpers/index.js';
import { parseTestLog, readLanes } from '../test-log.js';

test('parseTestLog reads results, failure excerpts, compile errors and CI flags', () => {
  for (const [text, expected] of buildGolden().parse_test_log) {
    assert.equal(asPythonJson(parseTestLog(text)), asPythonJson(expected));
  }
});

test('test results are named <suite>::<test>', () => {
  const parsed = parseTestLog(
    [
      '     Running unittests src/lib.rs (/target/debug/deps/lightningcss-0123abcd)',
      'test tests::a ... ok',
      '     Running /target/debug/deps/cli-89ab',
      'test tests::a ... ignored',
    ].join('\n'),
  );

  assert.deepEqual(parsed.tests, { 'cli::tests::a': 'ignored', 'src/lib.rs::tests::a': 'ok' });
  assert.deepEqual(parsed.summary, { passed: 1, failed: 0, ignored: 1 });
  assert.equal(parsed.compile_errors, null);
});

test('readLanes reads each lane exit, duration, errors and tail', () => {
  using dir = tempDir();
  const log = [
    '   Compiling x',
    ...Array.from({ length: 20 }, (_, index) => `line ${index}`),
    'error: boom',
  ].join('\n');

  writeFiles(dir.path, {
    'lane-selectors.exit': '101\n',
    'lane-selectors.seconds': '7\n',
    'lane-selectors.log': `${log}\n`,
    'lane-no-default-features.exit': '',
    'lane-c.log': 'no exit file: not a lane',
  });

  const lanes = readLanes(dir.path);

  assert.deepEqual(Object.keys(lanes), ['no-default-features', 'selectors']);
  assert.deepEqual(lanes['no-default-features'], { exit: 1, seconds: null, errors: [], tail: '' });
  assert.equal(lanes.selectors.exit, 101);
  assert.equal(lanes.selectors.seconds, 7);
  assert.deepEqual(lanes.selectors.errors, ['error: boom']);
  assert.equal(lanes.selectors.tail.split('\n').length, 15);
});
