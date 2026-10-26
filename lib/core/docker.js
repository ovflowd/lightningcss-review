/**
 * Docker daemon checks and image queries.
 *
 * Stage: setup, doctor and every stage that runs a container (build, oracle, perf, wpt, spec).
 * Containers are started through compose.js; this module answers "is Docker usable" and "does
 * this image exist", with the fix for the common failures spelled out.
 *
 * Invariant: containers run as the host user (`uid:gid`), so files they write into mounted run
 * directories stay owned by the user and `lcr clean` can delete them.
 */
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import { LcrError } from './errors.js';
import { run, runSync, which } from './proc.js';

/**
 * @typedef {object} DockerStatus
 * @property {boolean} ok
 * @property {string} detail The server version, or what is wrong and how to fix it.
 */

/**
 * Whether the Docker daemon answers, with the fix when it does not.
 *
 * @returns {DockerStatus}
 */
export function dockerAvailable() {
  if (!which('docker')) {
    return { ok: false, detail: 'docker is not installed' };
  }

  const result = runSync(['docker', 'info', '--format', '{{.ServerVersion}}'], { check: false });

  if (result.code === 0) {
    return { ok: true, detail: result.stdout.trim() };
  }

  return { ok: false, detail: dockerProblem(result.stderr.trim()) };
}

/**
 * @param {string} stderr
 * @returns {string}
 */
function dockerProblem(stderr) {
  if (stderr.includes('permission denied')) {
    return (
      'docker socket permission denied. Fix: sudo usermod -aG docker $USER (then log in again), ' +
      'or for the current session: sudo setfacl -m u:$USER:rw /var/run/docker.sock'
    );
  }

  if (stderr.includes('Cannot connect') || stderr.includes('Is the docker daemon running')) {
    return 'docker daemon is not running. Fix: sudo systemctl enable --now docker';
  }

  return stderr || 'docker info failed';
}

/**
 * Throw an `LcrError` with the fix unless Docker is usable.
 *
 * @returns {void}
 */
export function requireDocker() {
  const status = dockerAvailable();

  if (!status.ok) {
    throw new LcrError(status.detail);
  }
}

/**
 * Whether a local image has this tag.
 *
 * @param {string} tag
 * @returns {boolean}
 */
export function imageExists(tag) {
  return runSync(['docker', 'image', 'inspect', tag], { check: false }).code === 0;
}

/**
 * The image id (`sha256:…`) of a local tag, or null.
 *
 * @param {string} tag
 * @returns {string | null}
 */
export function imageId(tag) {
  const result = runSync(['docker', 'image', 'inspect', '--format', '{{.Id}}', tag], { check: false });

  return result.code === 0 ? result.stdout.trim() : null;
}

/** `docker kill` answers within milliseconds; anything longer is a daemon in trouble. */
const KILL_TIMEOUT_MS = 30_000;
/** Random bytes in a container name: pids are reused, and two lcr processes may run at once. */
const NAME_RANDOM_BYTES = 4;
/** Containers this process named so far. */
let namedContainers = 0;

/**
 * A container name no other container has: `lcr-<label>-<pid>-<n>-<random>`.
 *
 * @param {string} label What runs in it (`adapter`, `builder`, …).
 * @returns {string}
 */
export function uniqueContainerName(label) {
  namedContainers++;

  return `lcr-${label}-${process.pid}-${namedContainers}-${randomBytes(NAME_RANDOM_BYTES).toString('hex')}`;
}

/**
 * Kill a container by name and wait for docker to confirm. A container that already exited (and
 * was removed by `--rm`) is not an error: this is cleanup after a timeout, a crash or a close.
 *
 * @param {string} name
 * @returns {Promise<void>}
 */
export async function killContainer(name) {
  await run(['docker', 'kill', name], { check: false, timeoutMs: KILL_TIMEOUT_MS });
}

/**
 * `uid:gid` of the current user, for `--user`.
 *
 * @returns {string}
 */
export function hostUser() {
  return `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
}

/**
 * @typedef {object} Mount
 * @property {string} host Host path (resolved to an absolute path).
 * @property {string} container Path inside the container.
 * @property {'ro' | 'rw'} mode
 */

/**
 * `-v host:container:mode` arguments, with host paths made absolute.
 *
 * @param {readonly Mount[]} mounts
 * @returns {string[]}
 */
export function mountArgs(mounts) {
  return mounts.flatMap(({ host, container, mode }) => ['-v', `${resolve(host)}:${container}:${mode}`]);
}

/**
 * Environment every container gets; callers add to it. The host user has no home in the image
 * (HOME=/tmp is writable), and UTC plus a UTF-8 locale keep tool output independent of the host.
 */
export const CONTAINER_ENV = Object.freeze({ HOME: '/tmp', TZ: 'UTC', LANG: 'C.UTF-8' });

/**
 * `-e KEY=VALUE` arguments for the default environment plus `env`, sorted by key.
 *
 * @param {Record<string, string>} [env]
 * @returns {string[]}
 */
export function envArgs(env = {}) {
  /** @type {Record<string, string>} */
  const merged = { ...CONTAINER_ENV, ...env };

  return Object.keys(merged)
    .sort()
    .flatMap((key) => ['-e', `${key}=${merged[key]}`]);
}
