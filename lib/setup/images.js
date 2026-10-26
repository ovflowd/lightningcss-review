/**
 * The harness's images and how stages run containers in them, through Docker Compose.
 *
 * Stage: build and perf (the builder image); oracle, selftest, baseline, wpt and spec (the browser
 * images). Stages never build Docker command lines: they call `runBuilder` / `runBrowsers` with
 * their mounts and options, and `ensureBuilder` / `ensureBrowsers` when they need an image tag.
 *
 * Images and tags (frozen, so images built by earlier versions and their env.json stay valid):
 * - `lcr-builder:rust-<channel>`: compose services `builder` (network on: only `cargo fetch` and
 *   the JS lane's dependency install without lifecycle scripts, which run no code from the
 *   reviewed tree), `builder-offline` (no network: builds and tests) and `builder-sandbox` (no
 *   network, a read-only root and process and memory limits: a built adapter or release CLI),
 *   built from docker/builder.Dockerfile.
 * - `lcr-browsers:pw-<playwright>[-analysis]`: compose service `browsers-<profile>`, built from
 *   docker/browsers.Dockerfile on the profile's Playwright pin (pins.js).
 *
 * Invariants:
 * - Every compose call gets the full set of compose variables (`composeVariables`), because
 *   compose interpolates the whole file whichever service it touches.
 * - Containers run as the host user with HOME=/tmp, TZ=UTC, LANG=C.UTF-8, `--init` and 2 GB of
 *   shared memory; browsers never have a network (service settings in compose.yaml).
 * - Every container this module starts has a unique name, and one that outlives its timeout is
 *   killed by that name: killing the compose client alone would leave it running.
 * - A missing image is built, never pulled: `lcr-*` images exist only locally.
 */
import { existsSync, readFileSync } from 'node:fs';

import { composeBuild, composeRun, composeRunArgv } from '../core/compose.js';
import { imageExists, killContainer, uniqueContainerName } from '../core/docker.js';
import { LcrError } from '../core/errors.js';
import { log } from '../core/log.js';
import { loadConfig } from '../core/paths.js';
import { readPins } from './pins.js';

/** @import { Mount } from '../core/docker.js' */
/** @import { RunResult } from '../core/proc.js' */
/** @import { EnginesConfig } from '../types.js' */
/** @import { PlaywrightPin } from './pins.js' */

/** The Rust channel compose.yaml falls back to when no stage named one (browser-only calls). */
const DEFAULT_CHANNEL = 'stable';
/** A failed image build shows this much of its output. */
const BUILD_ERROR_TAIL_CHARS = 3000;
/** Building an image downloads a toolchain or a browser bundle; give it time. */
const BUILD_TIMEOUT_MS = 2 * 60 * 60_000;

/** The compose service that runs a built binary of a reviewed tree (compose.yaml). */
export const SANDBOX_SERVICE = 'builder-sandbox';

/** Where Linux reports this process's resource limits. */
const PROC_LIMITS = '/proc/self/limits';
/** The `/proc/self/limits` row of the stack limit: soft and hard, in bytes or `unlimited`. */
const STACK_LIMIT_ROW = /^Max stack size\s+(\S+)\s+(\S+)/m;
/** What Docker takes for an unlimited ulimit. */
const UNLIMITED = '-1';

/**
 * Pins that replace compose.yaml's for this process (`lcr setup --update` tries a new release
 * before it rewrites the pin).
 *
 * @type {Map<string, PlaywrightPin>}
 */
const pinOverrides = new Map();

/**
 * Use `pin` for `profile` until the returned handle is disposed (`using _pin = …`).
 *
 * @param {string} profile
 * @param {PlaywrightPin} pin
 * @returns {Disposable}
 */
export function overridePin(profile, pin) {
  pinOverrides.set(profile, pin);

  return {
    [Symbol.dispose]() {
      pinOverrides.delete(profile);
    },
  };
}

/**
 * config/engines.json.
 *
 * @returns {EnginesConfig}
 */
function enginesConfig() {
  return /** @type {EnginesConfig} */ (loadConfig('engines.json'));
}

/**
 * An engine profile's entry in config/engines.json; an `LcrError` naming the known profiles for
 * any other name.
 *
 * @param {string} profile
 * @param {EnginesConfig} [config] Default: config/engines.json, read now.
 * @returns {EnginesConfig['profiles'][string]}
 */
export function engineProfile(profile, config = enginesConfig()) {
  if (!Object.hasOwn(config.profiles, profile)) {
    throw new LcrError(`unknown engine profile ${profile}`, {
      remedy: `pick one of ${Object.keys(config.profiles).join(', ')} (config/engines.json)`,
    });
  }

  return config.profiles[profile];
}

/**
 * The Playwright pin of an engine profile.
 *
 * @param {string} profile
 * @returns {PlaywrightPin}
 */
export function playwrightPin(profile) {
  const pin = pinOverrides.get(profile) ?? readPins().get(profile);

  if (!pin) {
    throw new LcrError(`compose.yaml has no Playwright pin for engine profile ${profile}`, {
      remedy: `add a \`${browsersService(profile)}\` service whose base image is a Playwright release`,
    });
  }

  return pin;
}

/**
 * `lcr-builder:rust-<channel>`.
 *
 * @param {string} channel
 * @returns {string}
 */
export function builderTag(channel) {
  return `lcr-builder:rust-${channel}`;
}

/**
 * `lcr-browsers:pw-<playwright>[-analysis]` for an engine profile.
 *
 * @param {string} profile
 * @returns {string}
 */
export function browsersTag(profile) {
  const suffix = engineProfile(profile).analysis ? '-analysis' : '';

  return `lcr-browsers:pw-${playwrightPin(profile).version}${suffix}`;
}

/**
 * The profiles `lcr setup` and the oracle use by default.
 *
 * @returns {string[]}
 */
export function defaultProfiles() {
  return enginesConfig().default_profiles;
}

/**
 * The compose service of an engine profile.
 *
 * @param {string} profile
 * @returns {string}
 */
export function browsersService(profile) {
  return `browsers-${profile}`;
}

/**
 * `legacy-2023` -> `LEGACY_2023` (compose variable names cannot hold dashes).
 *
 * @param {string} profile
 * @returns {string}
 */
function variableSuffix(profile) {
  return profile.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_');
}

/**
 * Every variable compose.yaml interpolates: the Rust channel, and per pinned profile its
 * Playwright version (`LCR_PLAYWRIGHT_<PROFILE>`) and base image (`LCR_BASE_<PROFILE>`).
 *
 * @param {string} [channel]
 * @returns {Record<string, string>}
 */
export function composeVariables(channel = DEFAULT_CHANNEL) {
  /** @type {Record<string, string>} */
  const variables = { LCR_RUST_CHANNEL: channel, ...stackVariables() };

  for (const profile of readPins().keys()) {
    const pin = playwrightPin(profile);

    variables[`LCR_PLAYWRIGHT_${variableSuffix(profile)}`] = pin.version;
    variables[`LCR_BASE_${variableSuffix(profile)}`] = pin.image;
  }

  return variables;
}

/**
 * `LCR_STACK_SOFT` and `LCR_STACK_HARD`: this process's stack limit, which the sandbox service
 * gives its containers, so an adapter overflows its stack exactly where it did on the host. Empty
 * where the host does not report it (compose.yaml then keeps Docker's 8 MiB, the usual default).
 *
 * @param {string} [limits] The text of `/proc/self/limits` (default: read it now).
 * @returns {Record<string, string>}
 */
export function stackVariables(limits = existsSync(PROC_LIMITS) ? readFileSync(PROC_LIMITS, 'utf8') : '') {
  const match = STACK_LIMIT_ROW.exec(limits);

  if (!match) {
    return {};
  }

  const value = (/** @type {string} */ text) => (text === 'unlimited' ? UNLIMITED : text);

  return { LCR_STACK_SOFT: value(match[1]), LCR_STACK_HARD: value(match[2]) };
}

/**
 * Build one service's image; an `LcrError` with the end of the build output when it fails.
 *
 * @param {string} service
 * @param {string} tag
 * @param {Record<string, string>} variables
 * @returns {Promise<void>}
 */
async function buildImage(service, tag, variables) {
  log(`building ${tag} (this can take a few minutes the first time)`);

  const result = await composeBuild([service], {
    projectEnv: variables,
    check: false,
    timeoutMs: BUILD_TIMEOUT_MS,
  });

  if (result.code !== 0) {
    const output = Array.from(`${result.stdout}${result.stderr}`).slice(-BUILD_ERROR_TAIL_CHARS).join('');

    throw new LcrError(`docker build ${tag} failed:\n${output}`);
  }
}

/**
 * The builder image for a Rust channel, built when missing or `rebuild`.
 *
 * @param {string} channel
 * @param {{ rebuild?: boolean }} [options]
 * @returns {Promise<string>} The image tag.
 */
export async function ensureBuilder(channel, { rebuild = false } = {}) {
  const tag = builderTag(channel);

  if (rebuild || !imageExists(tag)) {
    await buildImage('builder', tag, composeVariables(channel));
  }

  return tag;
}

/**
 * The browser image of an engine profile, built when missing or `rebuild`.
 *
 * @param {string} profile
 * @param {{ rebuild?: boolean }} [options]
 * @returns {Promise<string>} The image tag.
 */
export async function ensureBrowsers(profile, { rebuild = false } = {}) {
  const tag = browsersTag(profile);

  if (rebuild || !imageExists(tag)) {
    await buildImage(browsersService(profile), tag, composeVariables());
  }

  return tag;
}

/**
 * @typedef {object} ContainerOptions
 * @property {readonly Mount[]} [mounts] Bind mounts (`{ host, container, mode }`).
 * @property {Record<string, string>} [env] Container environment on top of HOME, TZ and LANG.
 * @property {string} [workdir]
 * @property {number} [timeoutMs]
 * @property {boolean} [check] Throw an `LcrError` on a non-zero exit (default true).
 * @property {boolean} [capture] Capture stdout/stderr (default true).
 * @property {string} [input] Text for the container's stdin.
 */

/**
 * Run a command in a throwaway builder container for `channel` (built first if missing).
 *
 * @param {string} channel
 * @param {readonly string[]} command
 * @param {ContainerOptions & { network?: boolean }} [options] `network` (default false) picks the
 *   `builder` service, which can reach crates.io; otherwise `builder-offline`.
 * @returns {Promise<RunResult>}
 */
export async function runBuilder(channel, command, { network = false, ...options } = {}) {
  await ensureBuilder(channel);

  return runNamed(network ? 'builder' : 'builder-offline', command, {
    ...options,
    projectEnv: composeVariables(channel),
  });
}

/**
 * Run a built binary of a reviewed tree in a throwaway `builder-sandbox` container for `channel`:
 * no network, a read-only root, few processes, bounded memory and the host's stack limit.
 *
 * @param {string} channel
 * @param {readonly string[]} command
 * @param {ContainerOptions} [options]
 * @returns {Promise<RunResult>}
 */
export async function runSandbox(channel, command, options = {}) {
  await ensureBuilder(channel);

  return runNamed(SANDBOX_SERVICE, command, { ...options, projectEnv: composeVariables(channel) });
}

/**
 * @typedef {object} SandboxCommandOptions
 * @property {readonly Mount[]} [mounts]
 * @property {Record<string, string>} [env] Container environment on top of HOME, TZ and LANG.
 * @property {string} [label] Names the container: `lcr-<label>-…`.
 */

/**
 * The command line of a long-lived `builder-sandbox` container that talks on stdin and stdout
 * (the adapter), for `LineProcess`: its argv, the environment the compose client needs, and the
 * container's name. The image must exist (`ensureBuilder`).
 *
 * @param {string} channel
 * @param {readonly string[]} command
 * @param {SandboxCommandOptions} [options]
 * @returns {{ argv: string[], env: Record<string, string>, name: string }}
 */
export function sandboxCommand(channel, command, { mounts = [], env, label = 'sandbox' } = {}) {
  const name = uniqueContainerName(label);

  return {
    argv: composeRunArgv(SANDBOX_SERVICE, command, { mounts, env, name, interactive: true }),
    env: composeVariables(channel),
    name,
  };
}

/**
 * `composeRun` in a container with a unique name, killed by that name unless it finished in time
 * (after a timeout the compose client is gone, the container may not be).
 *
 * @param {string} service
 * @param {readonly string[]} command
 * @param {import('../core/compose.js').ComposeRunOptions} options
 * @returns {Promise<RunResult>}
 */
async function runNamed(service, command, options) {
  const name = uniqueContainerName(service);
  let finished = false;

  try {
    const result = await composeRun(service, command, { ...options, name });

    finished = !result.timedOut;

    return result;
  } finally {
    if (!finished) {
      await killContainer(name);
    }
  }
}

/**
 * Run a command in a throwaway, offline browser container of an engine profile (built first if
 * missing).
 *
 * @param {string} profile
 * @param {readonly string[]} command
 * @param {ContainerOptions} [options]
 * @returns {Promise<RunResult>}
 */
export async function runBrowsers(profile, command, options = {}) {
  await ensureBrowsers(profile);

  return composeRun(browsersService(profile), command, { ...options, projectEnv: composeVariables() });
}
