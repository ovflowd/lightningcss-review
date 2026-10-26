/**
 * Disk-space preflight and mount inspection.
 *
 * Stage: build, corpus, probe, oracle and perf call `preflightDisk` before they start writing, so a
 * stage refuses to start instead of running out of space halfway (a half-written corpus or oracle
 * directory is worse than none). `doctor` reports the cache's filesystem: a cache on tmpfs lives in
 * RAM and disappears on reboot.
 */
import { mkdirSync, readFileSync, realpathSync, statfsSync } from 'node:fs';

import { DISK_REMEDY, LcrError } from './errors.js';
import { logWarning } from './log.js';

/** Bytes in a mebibyte: messages and stage estimates use binary units. */
export const MIB = 2 ** 20;
/** Bytes in a gibibyte. */
export const GIB = 2 ** 30;

const RAM_FILESYSTEMS = new Set(['tmpfs', 'ramfs']);

/**
 * @typedef {object} FilesystemMount A line of /proc/mounts.
 * @property {string} mountPoint
 * @property {string} fsType
 */

/**
 * The mount holding `path` (longest matching mount point in /proc/mounts); null where /proc is
 * unavailable.
 *
 * @param {string} path
 * @returns {FilesystemMount | null}
 */
export function mountOf(path) {
  let lines;

  try {
    lines = readFileSync('/proc/mounts', 'utf8').split('\n');
  } catch {
    return null;
  }

  const target = realpathSync(path);
  /** @type {FilesystemMount | null} */
  let best = null;

  for (const line of lines) {
    const fields = line.split(/\s+/).filter(Boolean);

    if (fields.length < 3) {
      continue;
    }

    // /proc/mounts escapes spaces in mount points as \040.
    const mountPoint = fields[1].replaceAll('\\040', ' ');
    const contains = target === mountPoint || target.startsWith(`${mountPoint.replace(/\/+$/, '')}/`);

    if (contains && (best === null || mountPoint.length > best.mountPoint.length)) {
      best = { mountPoint, fsType: fields[2] };
    }
  }

  return best;
}

/**
 * True when `path` is on a RAM filesystem.
 *
 * @param {string} path
 * @returns {boolean}
 */
export function onTmpfs(path) {
  const mount = mountOf(path);

  return mount !== null && RAM_FILESYSTEMS.has(mount.fsType);
}

/**
 * Bytes available to this user on the filesystem holding `path`.
 *
 * @param {string} path
 * @returns {number}
 */
export function freeBytes(path) {
  const stats = statfsSync(path);

  return Number(stats.bavail) * Number(stats.bsize);
}

/**
 * Refuse to start a stage that would run out of space; warn when the cache is in RAM.
 *
 * @param {string} path Where the stage writes (created if missing).
 * @param {number} needBytes Estimated bytes the stage writes.
 * @param {string} stage Stage name for the message.
 * @returns {void}
 */
export function preflightDisk(path, needBytes, stage) {
  mkdirSync(path, { recursive: true });

  const free = freeBytes(path);

  if (onTmpfs(path)) {
    logWarning(`${path} is on tmpfs (RAM); set LCR_CACHE to an on-disk directory`);
  }

  if (free < needBytes) {
    throw new LcrError(
      `${stage} needs about ${Math.floor(needBytes / MIB)} MiB in ${path}, ${Math.floor(free / MIB)} MiB free`,
      { remedy: DISK_REMEDY },
    );
  }
}
