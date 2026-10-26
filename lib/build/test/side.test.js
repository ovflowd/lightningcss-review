import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { FIXTURES_DIR, tempDir, withEnv } from '../../../test/helpers/index.js';
import { buildSide } from '../side.js';

/**
 * A cargo stand-in whose `--locked` runs fail because Cargo.lock is outdated, and whose
 * `-D warnings` runs fail on a warning when `warns` is set.
 *
 * @param {boolean} warns
 * @returns {string}
 */
function fakeCargo(warns) {
  return `#!/bin/sh
case "$*" in *--locked*)
  echo "error: the lock file /src/Cargo.lock needs to be updated but --locked was passed to prevent this"
  exit 101 ;;
esac
case "$1 $2" in
  "test --all-features")
    if [ "${warns}" = true ] && [ "$RUSTFLAGS" = "-D warnings" ]; then
      echo "  = note: \\\`-D unused\\\` implied by \\\`-D warnings\\\`"
      echo "error: could not compile \\\`lightningcss\\\`"
      exit 101
    fi
    echo "     Running unittests src/lib.rs (/target/debug/deps/lightningcss-0123)"
    echo "test tests::test_a ... ok" ;;
  "build --all-features")
    mkdir -p "$CARGO_TARGET_DIR/debug/examples"
    printf 'adapter' > "$CARGO_TARGET_DIR/debug/examples/lcr_adapter" ;;
esac
exit 0
`;
}

/**
 * Build head of a copy of the host-build fixture with `fakeCargo(warns)` on PATH.
 *
 * @param {boolean} warns
 * @returns {Promise<import('../../types.js').BuildSide>}
 */
async function buildWithOutdatedLockfile(warns) {
  using dir = tempDir();
  const runDir = join(dir.path, 'cache', 'runs', 'r');
  const bin = join(dir.path, 'bin');

  cpSync(join(FIXTURES_DIR, 'build', 'host-build', 'run'), runDir, { recursive: true });
  cpSync(join(FIXTURES_DIR, 'build', 'host-build', 'bin'), bin, { recursive: true });
  writeFileSync(join(bin, 'cargo'), fakeCargo(warns));
  chmodSync(join(bin, 'cargo'), 0o755);

  using _env = withEnv({
    LCR_BUILD: 'host',
    LCR_CACHE: join(dir.path, 'cache'),
    CARGO_HOME: join(dir.path, 'cargo'),
    PATH: `${bin}:${process.env.PATH}`,
  });
  const record = await buildSide(runDir, { side: 'head', jobs: 2 });

  assert.ok(existsSync(join(runDir, 'bin', 'head-adapter')));

  return record;
}

test('an outdated Cargo.lock is a finding: the build retries without --locked', async () => {
  const record = await buildWithOutdatedLockfile(false);

  assert.deepEqual(record.attempts, [
    { rustflags: '-D warnings', locked: true, exit: 101 },
    { rustflags: '-D warnings', locked: false, exit: 0 },
  ]);
  assert.equal(record.lockfile_outdated, true);
  assert.equal(record.warnings_as_errors, false);
  assert.equal(record.test_exit, 0);
  assert.deepEqual(record.summary, { passed: 1, failed: 0, ignored: 0 });
  // The lanes of the last attempt ran without --locked too.
  assert.equal(record.lanes.selectors.exit, 0);
});

test('then a warning under -D warnings retries without the flag, still unlocked', async () => {
  const record = await buildWithOutdatedLockfile(true);

  assert.deepEqual(record.attempts, [
    { rustflags: '-D warnings', locked: true, exit: 101 },
    { rustflags: '-D warnings', locked: false, exit: 101 },
    { rustflags: '', locked: false, exit: 0 },
  ]);
  assert.equal(record.lockfile_outdated, true);
  assert.equal(record.warnings_as_errors, true);
  assert.equal(record.compile_errors, null);
});
