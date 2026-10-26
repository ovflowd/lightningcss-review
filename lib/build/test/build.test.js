import assert from 'node:assert/strict';
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { asPythonJson, buildGolden } from '../../../test/fixtures/build/golden.js';
import { fakeDocker } from '../../../test/helpers/fake-docker.js';
import { captureOutput, FIXTURES_DIR, tempDir, withEnv, writeFiles } from '../../../test/helpers/index.js';
import { jsonFileText, loads } from '../../core/pyjson.js';
import { build } from '../build.js';
import { JS_INSTALL } from '../scripts.js';
import { failOnTimeout } from '../side.js';

/** @import { RunResult } from '../../core/proc.js' */
/** @import { FakeDockerCall } from '../../../test/helpers/fake-docker.js' */

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

describe('in the builder image', () => {
  /**
   * Build the fixture run with the fake docker; returns the compose runs it made.
   *
   * @param {string} root
   * @returns {Promise<{ cache: string, runDir: string, runs: FakeDockerCall[] }>}
   */
  async function dockerBuild(root) {
    const docker = fakeDocker(root);
    const cache = join(root, 'cache');
    const runDir = join(cache, 'runs', 'r');

    cpSync(join(FIXTURE, 'run'), runDir, { recursive: true });
    writeFiles(cache, {
      'targets/base/debug/deps/libdep.rlib': 'base',
      'targets/head/debug/deps/libdep.rlib': 'left by an earlier pull request',
      'targets/head/debug/build/evil/output': 'marker',
    });

    using _env = withEnv({
      LCR_BUILD: undefined,
      LCR_CACHE: cache,
      PATH: `${docker.bin}:${process.env.PATH}`,
      FAKE_DOCKER_STATE: docker.state,
    });

    await captureOutput(() => build(runDir, { jobs: 2 }));

    return { cache, runDir, runs: docker.calls().filter((call) => call.service) };
  }

  /**
   * The fmt check, the fetch and the test attempt of one side.
   *
   * @param {FakeDockerCall[]} runs
   * @param {{ cache: string, runDir: string, side: string }} where
   * @returns {void}
   */
  function assertSideRuns(runs, { cache, runDir, side }) {
    const cargoHome = join(cache, 'cargo-home');
    const out = join(runDir, 'build', side);
    const mine = runs.filter((run) => run.mounts?.some((mount) => mount.host.startsWith(out)));
    const fmt = runs.find((run) => run.mounts?.some((mount) => mount.host === join(runDir, 'src', side)));
    const fetch = mine.find(
      (run) => run.service === 'builder' && run.command?.join(' ').includes('cargo fetch'),
    );
    const attempt = mine.find((run) => run.mounts?.some((mount) => mount.container === '/target'));

    assert.equal(fmt?.service, 'builder-offline', side);
    assert.deepEqual(fmt?.mounts?.[1], { host: cargoHome, container: '/cargo', mode: 'ro' });
    assert.deepEqual(fetch?.mounts, [
      { host: join(out, 'fetch-tree'), container: '/src', mode: 'rw' },
      { host: cargoHome, container: '/cargo', mode: 'rw' },
    ]);
    assert.equal(attempt?.service, 'builder-offline');
    assert.deepEqual(attempt?.mounts, [
      { host: join(out, 'tree'), container: '/src', mode: 'rw' },
      { host: cargoHome, container: '/cargo', mode: 'ro' },
      { host: join(cache, 'targets', side), container: '/target', mode: 'rw' },
      { host: out, container: '/out', mode: 'rw' },
    ]);
    assert.equal(attempt?.env?.CARGO_NET_OFFLINE, 'true');
  }

  /**
   * The networked runs are the fetches and the JS lane's install, which mounts no Cargo home and
   * only the yarn cache writable; every other run has the caches read-only.
   *
   * @param {FakeDockerCall} run
   * @param {string} cargoHome
   * @returns {void}
   */
  function assertCacheModes(run, cargoHome) {
    const command = run.command?.join(' ') ?? '';
    const writable = (run.mounts ?? [])
      .filter((mount) => mount.host.startsWith(cargoHome) && mount.mode === 'rw')
      .map((mount) => mount.container);

    if (run.service !== 'builder') {
      assert.deepEqual(writable, [], command);
    } else if (command.includes('cargo fetch')) {
      assert.deepEqual(writable, ['/cargo']);
    } else {
      assert.ok(command.includes(JS_INSTALL), command);
      assert.equal(run.env?.YARN_IGNORE_PATH, '1');
      assert.deepEqual(writable, ['/cargo/yarn-cache']);
    }
  }

  test('only cargo fetch and the JS install get the network, and only they write the caches', async () => {
    using dir = tempDir();
    const { cache, runDir, runs } = await dockerBuild(dir.path);

    for (const side of ['base', 'head']) {
      assertSideRuns(runs, { cache, runDir, side });
    }

    for (const run of runs) {
      assertCacheModes(run, join(cache, 'cargo-home'));
    }

    const jsTargets = runs.flatMap(
      (run) => run.mounts?.filter((mount) => mount.container === '/target-js') ?? [],
    );

    // The fixture's change needs the JS tests but no regeneration: head's lane only, in its
    // per-run target.
    assert.deepEqual(
      jsTargets.map((mount) => [mount.host, mount.mode]),
      [[join(cache, 'targets', 'js-head'), 'rw']],
    );
  });

  test("head starts from a copy of base's target, never from what an earlier review left", async () => {
    using dir = tempDir();
    const { cache } = await dockerBuild(dir.path);
    const head = join(cache, 'targets', 'head');

    assert.equal(readFileSync(join(head, 'debug', 'deps', 'libdep.rlib'), 'utf8'), 'base');
    assert.equal(existsSync(join(head, 'debug', 'build', 'evil')), false);
    assert.ok(existsSync(join(cache, 'targets', 'head-nowarn')));
    assert.equal(existsSync(join(cache, 'targets', 'head.lock.d')), false);
    assert.equal(existsSync(join(cache, 'targets', 'base.lock.d')), false);
  });
});
