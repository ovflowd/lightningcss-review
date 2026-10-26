import assert from 'node:assert/strict';
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { asPythonJson, buildGolden } from '../../../test/fixtures/build/golden.js';
import { captureOutput, FIXTURES_DIR, tempDir, withEnv } from '../../../test/helpers/index.js';
import { jsonFileText, loads } from '../../core/pyjson.js';
import { build } from '../build.js';
import { failOnTimeout } from '../side.js';

/** @import { RunResult } from '../../core/proc.js' */

const FIXTURE = join(FIXTURES_DIR, 'build', 'host-build');

/**
 * build.json without the wall-clock fields.
 *
 * @param {any} record
 * @returns {any}
 */
function withoutTimings(record) {
  const copy = structuredClone(record);

  for (const side of ['base', 'head']) {
    delete copy[side].seconds;
    delete copy[side].test_seconds;

    for (const lane of Object.values(copy[side].lanes)) {
      delete (/** @type {any} */ (lane).seconds);
    }
  }

  return copy;
}

test('a host-mode build (fake cargo) produces the golden build.json', async () => {
  using dir = tempDir();
  const cache = join(dir.path, 'cache');
  const runDir = join(cache, 'runs', 'r');

  cpSync(join(FIXTURE, 'run'), runDir, { recursive: true });

  using _env = withEnv({
    LCR_BUILD: 'host',
    LCR_CACHE: cache,
    CARGO_HOME: join(dir.path, 'cargo'),
    PATH: `${join(FIXTURE, 'bin')}:${process.env.PATH}`,
  });
  const golden = buildGolden().host_build;
  const { result, stderr } = await captureOutput(() => build(runDir, { jobs: 2 }));

  assert.equal(asPythonJson(withoutTimings(result)), asPythonJson(golden.build));
  assert.equal(
    asPythonJson(withoutTimings(loads(readFileSync(join(runDir, 'build.json'), 'utf8')))),
    asPythonJson(golden.build),
  );
  assert.match(
    stderr,
    /\[lcr\] head: tests \{'passed': 1, 'failed': 1, 'ignored': 0\} exit=101 adapter=ok tuples=2/,
  );

  for (const side of /** @type {const} */ (['base', 'head'])) {
    const out = join(runDir, 'build', side);
    const adapter = join(runDir, 'bin', `${side}-adapter`);

    assert.equal(readFileSync(join(out, 'tests.json'), 'utf8'), jsonFileText(golden[side].tests));
    assert.equal(readFileSync(join(out, 'fmt.txt'), 'utf8'), golden[side].fmt);
    assert.equal(readFileSync(adapter, 'utf8'), golden[side].adapter);
    assert.equal(statSync(adapter).mode & 0o777, 0o755);
    assert.deepEqual(
      readdirSync(out)
        .filter((name) => name !== 'tree')
        .sort(),
      golden[side].files,
    );
  }

  // The target-directory locks are released.
  assert.equal(existsSync(join(cache, 'targets', 'base.lock.d')), false);
});

test('build refuses to start without prepare.json', async () => {
  using dir = tempDir();
  using _env = withEnv({
    LCR_BUILD: 'host',
    LCR_CACHE: join(dir.path, 'cache'),
    PATH: `${join(FIXTURE, 'bin')}:${process.env.PATH}`,
  });

  await assert.rejects(build(join(dir.path, 'run')), { message: 'run `lcr prepare` first' });
});

test('a host build without cargo on PATH is an error', async () => {
  using dir = tempDir();
  using _env = withEnv({ LCR_BUILD: 'host', PATH: dir.path });

  await assert.rejects(build(dir.path), {
    message:
      'LCR_BUILD=host but cargo is not on PATH; install Rust (https://rustup.rs) or unset LCR_BUILD to build in the builder image',
  });
});

test('a step that times out fails the stage with its name', () => {
  const result = /** @type {RunResult} */ ({
    argv: ['x'],
    code: null,
    signal: 'SIGKILL',
    timedOut: true,
    stdout: '',
    stderr: '',
  });

  assert.throws(() => failOnTimeout(result, { step: 'head: cargo test and build', timeoutMs: 7_200_000 }), {
    message: 'head: cargo test and build timed out after 7200s',
  });
  assert.doesNotThrow(() => failOnTimeout({ ...result, timedOut: false }, { step: 'x', timeoutMs: 1 }));
});
