/**
 * Where an adapter process runs: in a throwaway `builder-sandbox` container of the side's builder
 * image (the default), or directly on the host with `LCR_BUILD=host`.
 *
 * Stage: corpus, probe, oracle (focus sheets), show and baseline: everything that sends requests
 * to bin/<side>-adapter. The head adapter is compiled from the reviewed pull request, so its
 * library code is untrusted: in a container it has no network, a read-only root, its own binary
 * mounted read-only and nothing else of the host, few processes and bounded memory.
 *
 * Invariants:
 * - One container per adapter process. A restart (after a crash, a timeout or a protocol error)
 *   starts a new container, and every stop kills the container by name: killing the compose
 *   client alone leaves a hung adapter running.
 * - The container prints a ready line before it runs the adapter, so starting it never counts
 *   against the first request's timeout, and a container that cannot start fails the batch with
 *   the reason instead of recording a crash for every request.
 * - Exit statuses read as they did on the host. tini (compose `init`) reports a child killed by
 *   signal n as 128+n, which maps back to -n (`adapter exited (-6)` for an abort). An adapter that
 *   itself exits with a status above 128 reads as killed by a signal: the two cannot be told
 *   apart through a container, and no Lightning CSS build exits that way on its own.
 */
import { join } from 'node:path';

import { killContainer } from '../core/docker.js';
import { LcrError } from '../core/errors.js';
import { readJson } from '../core/files.js';
import { LineProcess } from '../core/proc.js';
import { isHostBuild, toolchainChannel } from '../build/tree.js';
import { ensureBuilder, SANDBOX_SERVICE, sandboxCommand } from '../setup/images.js';

/** @import { Build, Side } from '../types.js' */

/** Where the adapter binary is mounted in its container. */
export const CONTAINER_ADAPTER = '/adapter';
/** The line the container prints once it is up, before it runs the adapter. */
export const READY_LINE = 'lcr-adapter-ready';
/**
 * Runs in the container: check the mounted binary can run, announce readiness, then become the
 * adapter. A constant: the binary's path comes in as `$0`, never through the script text.
 */
const READY_SCRIPT = `test -x "$0" || exit 126; echo ${READY_LINE}; exec "$0"`;
/** Starting a container takes well under a second; this much means Docker is in trouble. */
const START_TIMEOUT_MS = 60_000;
/** How much of a container's stderr explains why it did not start. */
const START_ERROR_CHARS = 2000;
/** Exit statuses above this are 128 + a signal number (tini and Docker report signals so). */
const SIGNAL_EXIT_BASE = 128;
/** The highest Linux signal number (SIGRTMAX). */
const MAX_SIGNAL = 64;
/** The adapter's environment: panics are caught and reported, backtraces would only be noise. */
const ADAPTER_ENV = Object.freeze({ RUST_BACKTRACE: '0' });

/**
 * One running adapter process and how to end it.
 *
 * @typedef {object} Launched
 * @property {LineProcess} process
 * @property {() => Promise<void>} stop Kill the process and whatever runs it.
 * @property {(code: number | null) => number | null} returncode The adapter's own exit status,
 *   in Python's spelling, from the status of the process that was started.
 */

/**
 * How adapter processes start.
 *
 * @typedef {object} Launcher
 * @property {string} where For messages: `on the host` or `in <service> (<image>)`.
 * @property {(binary: string) => Promise<Launched>} launch
 */

/**
 * An adapter binary and where its processes run.
 *
 * @typedef {object} Adapter
 * @property {string} binary The binary on the host.
 * @property {Launcher} launcher
 */

/**
 * Processes started directly on the host, as `LCR_BUILD=host` runs everything (and the unit tests
 * run their stand-in adapters).
 *
 * @type {Launcher}
 */
const HOST_LAUNCHER = Object.freeze({
  where: 'on the host',
  launch: async (/** @type {string} */ binary) => {
    const process = new LineProcess([binary], { env: ADAPTER_ENV });

    const stop = async () => {
      await process.kill();
    };

    return { process, stop, returncode: (code) => code };
  },
});

/**
 * An adapter whose processes run on the host.
 *
 * @param {string} binary
 * @returns {Adapter}
 */
export function hostAdapter(binary) {
  return { binary, launcher: HOST_LAUNCHER };
}

/**
 * Processes started in `builder-sandbox` containers of a Rust channel's builder image, one per
 * process.
 *
 * @param {string} channel
 * @returns {Launcher}
 */
export function containerLauncher(channel) {
  return {
    where: `in ${SANDBOX_SERVICE} (lcr-builder:rust-${channel})`,
    launch: (binary) => launchContainer(channel, binary),
  };
}

/**
 * The argv, compose environment and name of one adapter container.
 *
 * @param {string} channel
 * @param {string} binary
 * @returns {{ argv: string[], env: Record<string, string>, name: string }}
 */
export function adapterContainerCommand(channel, binary) {
  return sandboxCommand(channel, ['sh', '-c', READY_SCRIPT, CONTAINER_ADAPTER], {
    mounts: [{ host: binary, container: CONTAINER_ADAPTER, mode: 'ro' }],
    env: ADAPTER_ENV,
    label: 'adapter',
  });
}

/**
 * Start one adapter container and wait until it is up.
 *
 * @param {string} channel
 * @param {string} binary
 * @returns {Promise<Launched>}
 */
async function launchContainer(channel, binary) {
  const { argv, env, name } = adapterContainerCommand(channel, binary);
  const process = new LineProcess(argv, { env, stderrTail: START_ERROR_CHARS });
  /** @type {{ error: Error | null }} */
  const spawned = { error: null };

  process.child.once('error', (error) => {
    spawned.error = error;
  });

  const stop = async () => {
    await killContainer(name);
    await process.kill();
  };
  const first = await process.readLine(START_TIMEOUT_MS);

  if (first !== READY_LINE) {
    await stop();

    const detail =
      first === 'timeout'
        ? `not up after ${START_TIMEOUT_MS / 1000}s`
        : (spawned.error?.message ?? process.stderrText().trim());

    throw new LcrError(`cannot run the adapter ${binary} in ${SANDBOX_SERVICE}: ${detail || 'no output'}`, {
      remedy: 'check Docker with `lcr doctor`, then rebuild the adapter with `lcr build`',
    });
  }

  return { process, stop, returncode: containerReturncode };
}

/**
 * The adapter's own exit status from its container's: 128+n (a signal, as tini reports it) is
 * -n, as a process killed on the host reads; a status from the client itself (killed by a signal,
 * already negative) and every other status stay as they are.
 *
 * @param {number | null} code
 * @returns {number | null}
 */
export function containerReturncode(code) {
  if (code !== null && code > SIGNAL_EXIT_BASE && code <= SIGNAL_EXIT_BASE + MAX_SIGNAL) {
    return -(code - SIGNAL_EXIT_BASE);
  }

  return code;
}

/**
 * The adapter of one side of a run, where it must run: in the side's builder image, unless
 * `LCR_BUILD=host`. The channel is the one the adapter was built with (build.json), else the
 * tree's.
 *
 * @param {string} runDir
 * @param {Side} side
 * @returns {Promise<Adapter>}
 */
export async function sideAdapter(runDir, side) {
  const binary = join(runDir, 'bin', `${side}-adapter`);

  if (isHostBuild()) {
    return hostAdapter(binary);
  }

  const built = /** @type {Partial<Build> | null} */ (readJson(join(runDir, 'build.json')))?.[side];

  if (built?.image === 'host') {
    throw new LcrError(`the ${side} adapter was built on the host (LCR_BUILD=host)`, {
      remedy: 'set LCR_BUILD=host for this run too, or rebuild it in the builder image with `lcr build`',
    });
  }

  const channel = built?.toolchain ?? toolchainChannel(join(runDir, 'src', side));

  await ensureBuilder(channel);

  return { binary, launcher: containerLauncher(channel) };
}
