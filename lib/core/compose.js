/**
 * Docker Compose: building and running the harness's images.
 *
 * Stage: setup (build), and every stage that runs a container. `compose.yaml` at the skill root
 * declares one `builder` service (the Rust toolchain image) and one browser service per engine
 * profile; this module turns a service name plus per-run mounts and environment into a
 * `docker compose run` command line. Which services exist, their image tags, network and resource
 * settings live in compose.yaml, not here.
 *
 * Invariants:
 * - Always the same project (`-p lcr`, `--project-directory <skill>`, `-f <skill>/compose.yaml`),
 *   whatever the caller's working directory, so images and containers are shared across runs.
 * - `run --rm --no-deps -T`: throwaway containers, no TTY, so output is captured byte for byte.
 * - `run` passes `--progress=quiet`: compose's own "Container … Creating/Created" lines would
 *   otherwise land in the captured stderr, and so in stage files such as build/<side>/fmt.txt.
 *   Compose also appends one `\n` to stderr when the container exits non-zero; composeRun removes
 *   it, so captured stderr is the container's own.
 * - Containers run as the host user; per-run mounts and environment are passed on the command line
 *   because they differ per run directory (`docker compose run` has no `--network` or
 *   `--shm-size`: those are service settings).
 * - Compose variables (`${LCR_RUST_CHANNEL}` in compose.yaml) come from `projectEnv`, which is
 *   given to the compose CLI, never to the container.
 */
import { join } from 'node:path';

import { envArgs, hostUser, mountArgs } from './docker.js';
import { LcrError } from './errors.js';
import { SKILL_DIR } from './paths.js';
import { checked, run } from './proc.js';

/** @import { Mount } from './docker.js' */
/** @import { RunResult } from './proc.js' */

/** The compose file every compose call uses. */
export const COMPOSE_FILE = join(SKILL_DIR, 'compose.yaml');

/** The compose project name: containers show up as `lcr-<service>-run-<id>`. */
export const COMPOSE_PROJECT = 'lcr';

/**
 * `docker compose …` with the fixed project, directory and file.
 *
 * @param {readonly string[]} args The compose subcommand and its arguments.
 * @param {{ progress?: 'quiet' | 'plain' }} [options] Compose's progress output (default: its own
 *   choice; a build keeps it, because a failed build shows the end of that output).
 * @returns {string[]}
 */
export function composeArgv(args, { progress } = {}) {
  return [
    'docker',
    'compose',
    ...(progress ? [`--progress=${progress}`] : []),
    '--project-name',
    COMPOSE_PROJECT,
    '--project-directory',
    SKILL_DIR,
    '--file',
    COMPOSE_FILE,
    ...args,
  ];
}

/**
 * @typedef {object} ComposeRunOptions
 * @property {readonly Mount[]} [mounts] Per-run bind mounts.
 * @property {Record<string, string>} [env] Container environment, on top of HOME=/tmp, TZ=UTC,
 *   LANG=C.UTF-8.
 * @property {string} [workdir]
 * @property {string} [user] Default: the host user (`uid:gid`).
 * @property {'always' | 'missing' | 'never'} [pull] Passed as `--pull`; default: compose's policy.
 * @property {string} [name] The container's name (`--name`), so it can be killed by name: killing
 *   the compose client alone leaves a container that ignores its stdin running.
 * @property {boolean} [interactive] Keep stdin open (`--interactive`), for a line protocol.
 * @property {Record<string, string>} [projectEnv] Variables compose.yaml interpolates.
 * @property {string} [input] Text for the container's stdin.
 * @property {number} [timeoutMs]
 * @property {boolean} [check] Default true.
 * @property {boolean} [capture] Default true.
 */

/**
 * The argv of `docker compose run` for one throwaway container.
 *
 * @param {string} service
 * @param {readonly string[]} command
 * @param {ComposeRunOptions} [options]
 * @returns {string[]}
 */
export function composeRunArgv(
  service,
  command,
  { mounts = [], env, workdir, user = hostUser(), pull, name, interactive = false } = {},
) {
  const args = ['run', '--rm', '--no-deps', '-T', `--user=${user}`];

  if (interactive) {
    args.push('--interactive');
  }

  if (name) {
    args.push(`--name=${name}`);
  }

  if (pull) {
    args.push(`--pull=${pull}`);
  }

  args.push(...mountArgs(mounts), ...envArgs(env));

  if (workdir) {
    args.push('-w', workdir);
  }

  return composeArgv([...args, service, ...command], { progress: 'quiet' });
}

/**
 * Run a command in a throwaway container of `service`.
 *
 * @param {string} service
 * @param {readonly string[]} command
 * @param {ComposeRunOptions} [options]
 * @returns {Promise<RunResult>}
 */
export async function composeRun(service, command, options = {}) {
  const { projectEnv, input, timeoutMs, check = true, capture = true } = options;
  const result = await run(composeRunArgv(service, command, options), {
    env: projectEnv,
    input,
    timeoutMs,
    // Checked below, once compose's own line break is gone from the error detail.
    check: false,
    capture,
  });

  return checked(withoutComposeNewline(result), { check, timeoutMs });
}

/**
 * The result without the `\n` compose appends to stderr when the container exits non-zero (on a
 * signal too); `docker run` never printed it, and it would hide stdout in a failure's detail.
 *
 * @param {RunResult} result
 * @returns {RunResult}
 */
export function withoutComposeNewline(result) {
  if (result.code === 0 || !result.stderr.endsWith('\n')) {
    return result;
  }

  return { ...result, stderr: result.stderr.slice(0, -1) };
}

/**
 * @typedef {object} ComposeBuildOptions
 * @property {Record<string, string>} [projectEnv] Variables compose.yaml interpolates.
 * @property {boolean} [pull] Pull newer base images (`--pull`).
 * @property {boolean} [noCache] Rebuild every layer (`--no-cache`).
 * @property {number} [timeoutMs]
 * @property {boolean} [check] Default true.
 */

/**
 * `docker compose build` for some services.
 *
 * @param {readonly string[]} services
 * @param {ComposeBuildOptions} [options]
 * @returns {Promise<RunResult>}
 */
export function composeBuild(
  services,
  { projectEnv, pull = false, noCache = false, timeoutMs, check = true } = {},
) {
  const flags = [...(pull ? ['--pull'] : []), ...(noCache ? ['--no-cache'] : [])];

  return run(composeArgv(['build', ...flags, ...services]), { env: projectEnv, timeoutMs, check });
}

/**
 * @typedef {object} ComposeService The parts of a resolved service the harness reads.
 * @property {string} [image]
 * @property {{ context?: string, dockerfile?: string, args?: Record<string, string> }} [build]
 * @property {string[]} [profiles]
 */

/**
 * @typedef {object} ComposeModel
 * @property {Record<string, ComposeService>} services
 */

/**
 * The resolved compose model (`docker compose config --format json`): services with their
 * `image`, `build.args`, `profiles`, … after variable interpolation.
 *
 * @param {{ projectEnv?: Record<string, string> }} [options]
 * @returns {Promise<ComposeModel>}
 */
export async function composeConfig({ projectEnv } = {}) {
  const result = await run(composeArgv(['config', '--format', 'json']), { env: projectEnv });

  return /** @type {ComposeModel} */ (JSON.parse(result.stdout));
}

/**
 * The first line of `docker compose version` / `docker buildx version`, or null when the plugin
 * is missing (for `lcr doctor`).
 *
 * @param {'compose' | 'buildx'} plugin
 * @returns {Promise<string | null>}
 */
export async function pluginVersion(plugin) {
  try {
    const result = await run(['docker', plugin, 'version'], { check: false });

    return result.code === 0 ? result.stdout.trim().split('\n')[0] : null;
  } catch (error) {
    // docker itself is missing; doctor reports that separately.
    if (error instanceof LcrError) {
      return null;
    }

    throw error;
  }
}
