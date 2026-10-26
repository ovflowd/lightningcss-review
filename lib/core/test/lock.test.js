import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { tempDir } from '../../../test/helpers/index.js';
import { acquireLock } from '../lock.js';

test('a lock excludes a second holder until it is released', async () => {
  using dir = tempDir();
  const path = join(dir.path, 'side.lock');
  const order = [];

  {
    await using first = await acquireLock(path);
    const second = acquireLock(path).then((lock) => {
      order.push('second');

      return lock;
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    order.push('first done');
    first.release();
    (await second).release();
  }

  assert.deepEqual(order, ['first done', 'second']);
});

test('a lock left by a dead process is taken over', async () => {
  using dir = tempDir();
  const path = join(dir.path, 'side.lock');

  mkdirSync(`${path}.d`);
  // PIDs are below 2^22 on Linux, so this one is never alive.
  writeFileSync(join(`${path}.d`, 'owner'), '99999999\n');

  await using lock = await acquireLock(path, { signal: AbortSignal.timeout(2000) });

  assert.equal(lock.released, false);
});

test('a stale lock is reaped once: a waiter never deletes the lock another just took', async () => {
  using dir = tempDir();
  const path = join(dir.path, 'side.lock');
  const lockDir = `${path}.d`;

  mkdirSync(lockDir);
  writeFileSync(join(lockDir, 'owner'), '99999999\n');

  // Another waiter is reaping right now: this one waits instead of deleting anything itself.
  mkdirSync(`${lockDir}.reap`);

  const waiting = acquireLock(path, { signal: AbortSignal.timeout(5000) });

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(readFileSync(join(lockDir, 'owner'), 'utf8'), '99999999\n');

  // The other waiter took the lock and finished reaping; the live lock must survive.
  writeFileSync(join(lockDir, 'owner'), `${process.pid}\n`);
  rmSync(`${lockDir}.reap`, { recursive: true });
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(readFileSync(join(lockDir, 'owner'), 'utf8'), `${process.pid}\n`);

  // Once the holder releases it, the waiter gets it.
  rmSync(lockDir, { recursive: true });
  (await waiting).release();
});

test('a reap lock left by a crash is cleared after the grace period', async () => {
  using dir = tempDir();
  const path = join(dir.path, 'side.lock');
  const lockDir = `${path}.d`;
  const old = new Date(Date.now() - 60_000);

  mkdirSync(lockDir);
  writeFileSync(join(lockDir, 'owner'), '99999999\n');
  mkdirSync(`${lockDir}.reap`);
  utimesSync(`${lockDir}.reap`, old, old);

  await using lock = await acquireLock(path, { signal: AbortSignal.timeout(5000) });

  assert.equal(readFileSync(join(lockDir, 'owner'), 'utf8'), `${process.pid}\n`);
  assert.equal(existsSync(`${lockDir}.reap`), false);
  assert.equal(lock.released, false);
});
