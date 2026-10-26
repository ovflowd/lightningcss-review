/**
 * The harness's images and how stages run containers in them, through Docker Compose.
 *
 * Stage: build and perf (the builder image); oracle, selftest, baseline, wpt and spec (the browser
 * images). Stages never build Docker command lines: they call `runBuilder` / `runBrowsers` with
 * their mounts and options, and `ensureBuilder` / `ensureBrowsers` when they need an image tag.
 *
 * Images and tags (unchanged from py-final, so existing images and env.json stay valid):
 * - `lcr-builder:rust-<channel>`: compose services `builder` (network on, for cargo) and
 *   `builder-offline` (no network), built from docker/builder.Dockerfile.
 * - `lcr-browsers:pw-<playwright>[-analysis]`: compose service `browsers-<profile>`, built from
 *   docker/browsers.Dockerfile on the profile's Playwright pin (pins.js).
 *
 * Invariants:
 * - Every compose call gets the full set of compose variables (`composeVariables`), because
 *   compose interpolates the whole file whichever service it touches.
 * - Containers run as the host user with HOME=/tmp, TZ=UTC, LANG=C.UTF-8, `--init` and 2 GB of
 *   shared memory; browsers never have a network (service settings in compose.yaml).
 * - A missing image is built, never pulled: `lcr-*` images exist only locally.
 */
import { composeBuild, composeRun } from '../core/compose.js';
import { imageExists } from '../core/docker.js';
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
  const variables = { LCR_RUST_CHANNEL: channel };

  for (const profile of readPins().keys()) {
    const pin = playwrightPin(profile);

    variables[`LCR_PLAYWRIGHT_${variableSuffix(profile)}`] = pin.version;
    variables[`LCR_BASE_${variableSuffix(profile)}`] = pin.image;
  }

  return variables;
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

  return composeRun(network ? 'builder' : 'builder-offline', command, {
    ...options,
    projectEnv: composeVariables(channel),
  });
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
