/**
 * Cross-process exclusive locks for shared cache directories.
 *
 * Stage: build and perf. The cargo target directories under `<cache>/targets/` are shared by every
 * run (warm incremental builds), so two concurrent reviews must not build into the same one, and
 * a review must not copy an adapter another review is rebuilding. Node has no `flock`, so a lock
 * is a directory created with `mkdir` (atomic on every local filesystem) that records the owner's
 * pid. A lock whose owner is gone (crash, SIGKILL) is taken over; two waiters that find the same
 * stale lock take turns removing it (`reapStale`), so neither deletes the lock the other just took.
 *
 * Usage: `await using lock = await acquireLock(path)`; the lock is released when the block exits,
 * on success or failure.
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/** How often a waiting process checks the lock again. */
const POLL_MS = 250;
/** A lock directory without an owner file older than this was left by a crash during creation. */
const OWNERLESS_GRACE_MS = 10_000;

/**
 * A held lock.
 */
export class FileLock {
  /** @param {string} directory */
  constructor(directory) {
    this.directory = directory;
    this.released = false;
  }

  /** Release the lock (idempotent). */
  release() {
    if (!this.released) {
      this.released = true;
      rmSync(this.directory, { recursive: true, force: true });
    }
  }

  [Symbol.dispose]() {
    this.release();
  }

  async [Symbol.asyncDispose]() {
    this.release();
  }
}

/**
 * Wait until the lock named `path` is free and take it. The lock directory is `<path>.d` (the
 * Python harness kept a flock file at `<path>`; the two never collide).
 *
 * @param {string} path e.g. `<cache>/targets/head.lock`.
 * @param {{ signal?: AbortSignal }} [options] Abort to stop waiting.
 * @returns {Promise<FileLock>}
 */
export async function acquireLock(path, { signal } = {}) {
  const directory = `${path}.d`;

  mkdirSync(dirname(directory), { recursive: true });

  for (;;) {
    signal?.throwIfAborted();

    if (tryCreate(directory)) {
      return new FileLock(directory);
    }

    // Retry at once after removing a stale lock; wait while another waiter is removing it.
    if (!ownerAlive(directory) && reapStale(directory)) {
      continue;
    }

    await sleep(POLL_MS, undefined, { signal });
  }
}

/**
 * @param {string} directory
 * @returns {boolean} True when this process created (and so owns) the lock.
 */
function tryCreate(directory) {
  if (!tryMkdir(directory)) {
    return false;
  }

  writeFileSync(join(directory, 'owner'), `${process.pid}\n`);

  return true;
}

/**
 * @param {string} directory
 * @returns {boolean} False when the directory already exists.
 */
function tryMkdir(directory) {
  try {
    mkdirSync(directory);

    return true;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EEXIST') {
      return false;
    }

    throw error;
  }
}

/**
 * Remove a lock whose owner is gone. Checking the owner and deleting are two steps, so two waiters
 * that both saw the stale lock could otherwise interleave: the first deletes it and takes a fresh
 * lock, then the second deletes that fresh lock. Removal therefore happens under a short-lived
 * second lock (`<lock>.reap`), with the owner checked again while holding it. A reap lock left by
 * a crash is cleared after the grace period.
 *
 * @param {string} directory
 * @returns {boolean} False when another waiter holds the reap lock (try again later).
 */
function reapStale(directory) {
  const reaper = `${directory}.reap`;

  if (!tryMkdir(reaper)) {
    if (!isFresh(reaper)) {
      rmSync(reaper, { recursive: true, force: true });
    }

    return false;
  }

  try {
    if (!ownerAlive(directory)) {
      rmSync(directory, { recursive: true, force: true });
    }
  } finally {
    rmSync(reaper, { recursive: true, force: true });
  }

  return true;
}

/**
 * Whether the process that holds the lock still runs. A lock without an owner file is being
 * created right now and counts as alive for a grace period.
 *
 * @param {string} directory
 * @returns {boolean}
 */
function ownerAlive(directory) {
  let pid;

  try {
    pid = Number(readFileSync(join(directory, 'owner'), 'utf8').trim());
  } catch {
    return isFresh(directory);
  }

  try {
    // Signal 0 checks existence without delivering anything.
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
  }
}

/**
 * Whether a directory was created within the grace period (one being set up right now).
 *
 * @param {string} directory
 * @returns {boolean}
 */
function isFresh(directory) {
  try {
    return Date.now() - statSync(directory).mtimeMs < OWNERLESS_GRACE_MS;
  } catch {
    // Gone already: the next mkdir attempt decides.
    return false;
  }
}
