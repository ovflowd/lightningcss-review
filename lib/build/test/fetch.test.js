import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { fakeDocker } from '../../../test/helpers/fake-docker.js';
import { tempDir, withEnv, writeFiles } from '../../../test/helpers/index.js';
import { copyForFetch, FETCH_SCRIPT, fetchCrates } from '../fetch.js';

/**
 * A tree whose files would steer cargo and rustup if the fetch saw them.
 *
 * @param {string} root
 * @returns {string}
 */
function steeringTree(root) {
  writeFiles(root, {
    'tree/Cargo.toml': '[package]\nname = "x"\n',
    'tree/Cargo.lock': 'version = 4\n',
    'tree/src/lib.rs': '',
    'tree/.cargo/config.toml': '[source.crates-io]\nreplace-with = "evil"\n',
    'tree/rust-toolchain.toml': '[toolchain]\npath = "/src/evil"\n',
    'tree/rust-toolchain': 'stable\n',
  });

  return join(root, 'tree');
}

test('the fetch copy keeps the manifests and drops what steers cargo or rustup', () => {
  using dir = tempDir();
  const tree = steeringTree(dir.path);
  const scratch = join(dir.path, 'scratch');

  copyForFetch(tree, scratch);

  assert.ok(existsSync(join(scratch, 'Cargo.toml')));
  assert.ok(existsSync(join(scratch, 'Cargo.lock')));
  assert.ok(existsSync(join(scratch, 'src', 'lib.rs')));

  for (const name of ['.cargo', 'rust-toolchain.toml', 'rust-toolchain']) {
    assert.equal(existsSync(join(scratch, name)), false, name);
    assert.ok(existsSync(join(tree, name)), `the tree keeps ${name}`);
  }
});

test('only the fetch has the network and a writable Cargo home, on a throwaway copy', async () => {
  using dir = tempDir();
  const docker = fakeDocker(dir.path);
  const tree = steeringTree(dir.path);
  const cache = join(dir.path, 'cache');
  const scratch = join(dir.path, 'out', 'fetch-tree');
  const logFile = join(dir.path, 'out', 'fetch.log');

  using _env = withEnv({ PATH: `${docker.bin}:${process.env.PATH}`, FAKE_DOCKER_STATE: docker.state });

  assert.equal(await fetchCrates(tree, { channel: '1.96.0', cache, scratch, logFile, label: 'head' }), 0);

  const [run] = docker.calls().filter((call) => call.service);

  assert.equal(run.service, 'builder');
  assert.deepEqual(run.mounts, [
    { host: scratch, container: '/src', mode: 'rw' },
    { host: join(cache, 'cargo-home'), container: '/cargo', mode: 'rw' },
  ]);
  assert.equal(run.env?.RUSTUP_TOOLCHAIN, '1.96.0');
  assert.equal(run.env?.CARGO_HOME, '/cargo');
  assert.deepEqual(run.command, ['bash', '-c', FETCH_SCRIPT]);
  assert.match(FETCH_SCRIPT, /cargo fetch --locked \|\| cargo fetch/);
  assert.equal(existsSync(scratch), false, 'the copy is gone');
  assert.equal(readFileSync(logFile, 'utf8'), '');
});

test('a channel that is not a toolchain name never reaches rustup', async () => {
  using dir = tempDir();
  const tree = steeringTree(dir.path);
  const options = {
    cache: dir.path,
    scratch: join(dir.path, 's'),
    logFile: join(dir.path, 'l'),
    label: 'head',
  };

  await assert.rejects(fetchCrates(tree, { ...options, channel: '/src/evil' }), {
    name: 'LcrError',
    message:
      'head: the Rust channel "/src/evil" is not a toolchain name; name a released channel such as 1.96.0 or stable in rust-toolchain.toml',
  });
});
