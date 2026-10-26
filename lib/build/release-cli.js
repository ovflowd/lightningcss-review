/**
 * Running the perf stage's release CLIs (perf/<side>-lightningcss) through docker/cli-runner.mjs:
 * in one `builder-sandbox` container for a whole plan, or on the host with `LCR_BUILD=host`.
 *
 * Stage: perf (timings in perf.js, smoke outputs in stale.js). Both binaries come from the
 * reviewed trees, head's from the pull request, so they run without network, with only
 * themselves, the runner and the CSS they read mounted, all read-only.
 *
 * Invariants:
 * - Base and head run in the same container and the same way (the runner interleaves them), so
 *   neither pays for anything the other does not; container start-up is outside every timing.
 * - The container uses base's builder image: both images come from the same Debian release, and
 *   base's is the one the review trusts.
 */
import { basename, join } from 'node:path';

import { LcrError } from '../core/errors.js';
import { SKILL_DIR } from '../core/paths.js';
import { run } from '../core/proc.js';
import { runSandbox } from '../setup/images.js';

/** @import { Mount } from '../core/docker.js' */
/** @import { Side } from '../types.js' */

/** The runner on the host. */
export const RUNNER = join(SKILL_DIR, 'docker', 'cli-runner.mjs');
/** The runner and the binaries in the container. */
const CONTAINER_RUNNER = '/lcr/cli-runner.mjs';
const CONTAINER_BINARIES = '/lcr/bin';
/** Each CSS file is mounted on its own under here, keeping its name. */
const CONTAINER_INPUTS = '/lcr/in';

/**
 * @typedef {object} TimePlan
 * @property {'time'} kind
 * @property {Record<Side, string>} binaries
 * @property {[name: string, path: string][]} files
 * @property {number} repeats
 * @property {number} timeoutMs Per run.
 */

/**
 * @typedef {object} OutputPlan
 * @property {'output'} kind
 * @property {Record<Side, string>} binaries
 * @property {string[]} inputs
 * @property {number} timeoutMs Per run.
 */

/**
 * @typedef {object} CliOptions
 * @property {boolean} host `LCR_BUILD=host`: run the runner with this Node on the host.
 * @property {string} channel The builder image's Rust channel (base's).
 * @property {number} timeoutMs For the whole plan.
 */

/**
 * Run a plan and return the runner's result (shapes in docker/cli-runner.mjs).
 *
 * @param {TimePlan | OutputPlan} plan With host paths.
 * @param {CliOptions} options
 * @returns {Promise<unknown>}
 */
export async function runCliPlan(plan, { host, channel, timeoutMs }) {
  const options = { check: false, timeoutMs };
  const result = host
    ? await run([process.execPath, RUNNER], { ...options, input: JSON.stringify(plan) })
    : await runInContainer(plan, channel, options);

  if (result.timedOut || result.code !== 0) {
    throw new LcrError(
      `running the release CLIs ${host ? 'on the host' : 'in builder-sandbox'} failed (${result.timedOut ? 'timed out' : `exit ${result.code}`})`,
      { remedy: 're-run `lcr perf <run>` once Docker is fine (`lcr doctor`)', detail: result.stderr.trim() },
    );
  }

  return JSON.parse(result.stdout);
}

/**
 * @param {TimePlan | OutputPlan} plan
 * @param {string} channel
 * @param {{ check: boolean, timeoutMs: number }} options
 * @returns {Promise<import('../core/proc.js').RunResult>}
 */
function runInContainer(plan, channel, options) {
  const { plan: inContainer, mounts } = containerPlan(plan);

  return runSandbox(channel, ['node', CONTAINER_RUNNER], {
    ...options,
    mounts: [{ host: RUNNER, container: CONTAINER_RUNNER, mode: 'ro' }, ...mounts],
    input: JSON.stringify(inContainer),
  });
}

/**
 * The plan with container paths, and the read-only mounts that put each file there.
 *
 * @param {TimePlan | OutputPlan} plan
 * @returns {{ plan: TimePlan | OutputPlan, mounts: Mount[] }}
 */
export function containerPlan(plan) {
  /** @type {Mount[]} */
  const mounts = [];
  const mount = (/** @type {string} */ host, /** @type {string} */ container) => {
    mounts.push({ host, container, mode: 'ro' });

    return container;
  };
  let inputs = 0;
  const input = (/** @type {string} */ path) =>
    mount(path, `${CONTAINER_INPUTS}/${inputs++}/${basename(path)}`);
  const binaries = {
    base: mount(plan.binaries.base, `${CONTAINER_BINARIES}/base`),
    head: mount(plan.binaries.head, `${CONTAINER_BINARIES}/head`),
  };

  if (plan.kind === 'time') {
    return {
      plan: { ...plan, binaries, files: plan.files.map(([name, path]) => [name, input(path)]) },
      mounts,
    };
  }

  return { plan: { ...plan, binaries, inputs: plan.inputs.map(input) }, mounts };
}
