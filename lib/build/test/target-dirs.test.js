import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { tempDir, writeFiles } from '../../../test/helpers/index.js';
import { lockTarget, SEEDS, seedTarget, seedTargets, targetDir } from '../target-dirs.js';

const OLD = new Date('2026-01-02T03:04:05Z');

/**
 * A base target with a nested file (dated OLD) and a symlink, and a head target holding what a
 * reviewed pull request's build left there.
 *
 * @param {string} root
 * @returns {{ base: string, head: string }}
 */
function targets(root) {
  const base = join(root, 'targets', 'base');
  const head = join(root, 'targets', 'head');

  writeFiles(root, {
    'targets/base/debug/deps/libx.rlib': 'base artifact',
    'targets/head/debug/deps/libx.rlib': 'poisoned by the PR',
    'targets/head/debug/build/evil/out': 'marker',
  });
  utimesSync(join(base, 'debug', 'deps', 'libx.rlib'), OLD, OLD);
  symlinkSync('deps/libx.rlib', join(base, 'debug', 'link'));

  return { base, head };
}

/**
 * @param {string} head
 * @returns {void}
 */
function assertSeeded(head) {
  const file = join(head, 'debug', 'deps', 'libx.rlib');

  assert.equal(readFileSync(file, 'utf8'), 'base artifact');
  assert.equal(statSync(file).mtimeMs, OLD.getTime(), 'timestamps are kept for cargo');
  assert.ok(lstatSync(join(head, 'debug', 'link')).isSymbolicLink());
  assert.equal(readlinkSync(join(head, 'debug', 'link')), 'deps/libx.rlib');
  assert.equal(existsSync(join(head, 'debug', 'build', 'evil')), false, 'nothing of the old head is left');
}

describe('seedTarget', () => {
  test('replaces head with a copy of base, timestamps and symlinks kept', async () => {
    using dir = tempDir();
    const { base, head } = targets(dir.path);

    await seedTarget(base, head);

    assertSeeded(head);
    assert.equal(readFileSync(join(base, 'debug', 'deps', 'libx.rlib'), 'utf8'), 'base artifact');
  });

  test('copies with fs.cpSync where cp cannot (no reflink option, no cp)', async () => {
    using dir = tempDir();
    const { base, head } = targets(dir.path);
    /** @type {string[][]} */
    const tried = [];

    await seedTarget(base, head, {
      copy: async (from, to) => {
        tried.push([from, to]);
        // A cp that fails half-way leaves a partial copy behind.
        mkdirSync(join(to, 'partial'), { recursive: true });

        return false;
      },
    });

    assert.deepEqual(tried, [[base, head]]);
    assertSeeded(head);
    assert.equal(existsSync(join(head, 'partial')), false);
  });

  test('a base that was never built gives an empty head', async () => {
    using dir = tempDir();
    const { head } = targets(dir.path);

    await seedTarget(join(dir.path, 'targets', 'base-nowarn'), head);

    assert.equal(statSync(head).isDirectory(), true);
    assert.equal(existsSync(join(head, 'debug')), false);
  });
});

test('seedTargets copies under the base lock, so it waits for a base build in progress', async () => {
  using dir = tempDir();
  const cache = dir.path;
  const { head } = targets(cache);
  const baseBuild = await lockTarget(cache, 'base');
  let seeded = false;
  const seeding = seedTargets(cache, SEEDS.build, { baseLock: 'base' }).then(() => {
    seeded = true;
  });

  await sleep(600);
  assert.equal(seeded, false, 'the copy waits while base is being built');
  assert.equal(readFileSync(join(head, 'debug', 'deps', 'libx.rlib'), 'utf8'), 'poisoned by the PR');

  baseBuild.release();
  await seeding;

  assertSeeded(head);
  assert.ok(statSync(targetDir(cache, 'head-nowarn')).isDirectory());
  // The base lock is free again for this run's own base build.
  (await lockTarget(cache, 'base')).release();
});

test('every head directory starts from a base one', () => {
  for (const [base, head] of Object.values(SEEDS).flat()) {
    assert.equal(head, base.replace('base', 'head'));
  }
});
