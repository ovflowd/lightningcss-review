/**
 * `lcr doctor` and `lcr setup`.
 *
 * Stage: before any review.
 * - `doctor` prints one row per host requirement (Node.js, git, gh, Docker with the compose and
 *   buildx plugins, daemon access, the Lightning CSS clone, disk space, the images) and exits 1
 *   when anything is missing.
 * - `setup` builds the images that are missing (or all of them with `--rebuild`), asks every
 *   browser image which engine versions it really runs, and records images and versions in
 *   `<cache>/env.json`, which reports cite. It prints env.json.
 * - `setup --update` first moves the latest profile to the newest Playwright release: build the
 *   image on the new release, run the oracle selftest (every default profile, with latest on the
 *   new release; env.json records the candidate only while it runs), and rewrite the pin in
 *   compose.yaml, plus latest's `expected` versions in engines.json, only when it passes. The
 *   legacy profiles never move.
 *
 * Reads config/engines.json and compose.yaml; writes <cache>/env.json (and, for `--update`,
 * compose.yaml and the latest profile's expected versions in config/engines.json).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { toolchainChannel } from '../build/tree.js';
import { pluginVersion } from '../core/compose.js';
import { freeBytes, GIB, mountOf, onTmpfs } from '../core/disk.js';
import { dockerAvailable, imageExists, imageId, requireDocker } from '../core/docker.js';
import { LcrError } from '../core/errors.js';
import { readJson, removeFile, writeAtomic, writeJson } from '../core/files.js';
import { log, print } from '../core/log.js';
import { cacheDir, CONFIG_DIR, loadConfig, repoDir, SKILL_DIR, skillVersion } from '../core/paths.js';
import { run, which } from '../core/proc.js';
import { pySplitlines, pyStr, pyStrip } from '../core/py.js';
import { dumps, loads } from '../core/pyjson.js';
import {
  browsersTag,
  defaultProfiles,
  engineProfile,
  ensureBrowsers,
  ensureBuilder,
  overridePin,
  playwrightPin,
  runBrowsers,
} from './images.js';
import { fetchChecked } from './http.js';
import { parsePlaywrightImage, writePin } from './pins.js';

/** @import { EnginesConfig, EnvFile, EnvProfile } from '../types.js' */
/** @import { PlaywrightPin } from './pins.js' */

const MIN_NODE_MAJOR = 24;
/** The images take about this much space. */
const MIN_FREE_GIB = 15;
const VERSIONS_TIMEOUT_MS = 300_000;
/** A failed version query shows this much of its output. */
const VERSIONS_ERROR_TAIL_CHARS = 2000;
const STATUS_WIDTH = 8;
const PLUGIN_FIX_PACMAN = 'install: sudo pacman -S docker-compose docker-buildx';
const PLUGIN_FIX_DOCS = {
  compose: 'install: https://docs.docker.com/compose/install/',
  buildx: 'install: https://docs.docker.com/build/concepts/overview/#install-buildx',
};

// ---------------------------------------------------------------------------------------------
// doctor

/** @typedef {[name: string, status: 'ok' | 'MISSING', detail: string]} DoctorRow */

/**
 * Print the requirement table; resolves to 1 when anything is missing.
 *
 * @returns {Promise<number>}
 */
export async function doctor() {
  /** @type {DoctorRow[]} */
  const rows = [];
  /** @type {(name: string, ok: boolean, detail?: string) => void} */
  const check = (name, ok, detail = '') => {
    rows.push([name, ok ? 'ok' : 'MISSING', detail]);
  };
  const nodeMajor = Number(process.versions.node.split('.')[0]);

  check(`node >= ${MIN_NODE_MAJOR}`, nodeMajor >= MIN_NODE_MAJOR, process.versions.node);

  for (const tool of ['git', 'gh', 'docker']) {
    check(tool, Boolean(which(tool)), which(tool) ?? '');
  }

  for (const plugin of /** @type {const} */ (['compose', 'buildx'])) {
    const version = which('docker') ? await pluginVersion(plugin) : null;

    check(`docker ${plugin}`, version !== null, version ?? pluginFix(plugin));
  }

  if (which('gh')) {
    const [ok, detail] = await ghAuth();

    check('gh auth', ok, detail);
  }

  const docker = dockerAvailable();

  check('docker daemon access', docker.ok, docker.detail);
  checkStorage(check);

  if (docker.ok) {
    checkImages(check);
  }

  printRows(rows);

  return rows.every(([, status]) => status === 'ok') ? 0 : 1;
}

/**
 * How to install a missing Docker plugin: the Arch package when pacman is there, else the docs.
 *
 * @param {'compose' | 'buildx'} plugin
 * @returns {string}
 */
function pluginFix(plugin) {
  return which('pacman') ? PLUGIN_FIX_PACMAN : PLUGIN_FIX_DOCS[plugin];
}

/**
 * `gh auth status`: whether it passes, and its account line (or the fix).
 *
 * @returns {Promise<[boolean, string]>}
 */
async function ghAuth() {
  const result = await run(['gh', 'auth', 'status'], { check: false });
  const lines = pySplitlines(pyStrip(`${result.stdout}${result.stderr}`));

  if (result.code === 0 && lines.length > 1) {
    return [true, pyStrip(lines[1])];
  }

  return [result.code === 0, 'run `gh auth login`'];
}

/**
 * The clone, free space and the cache's filesystem.
 *
 * @param {(name: string, ok: boolean, detail?: string) => void} check
 * @returns {void}
 */
function checkStorage(check) {
  const cache = cacheDir();
  const free = Math.floor(freeBytes(cache) / GIB);
  const mount = mountOf(cache);
  const tmpfs = onTmpfs(cache);

  check('lightningcss clone', existsSync(join(repoDir(), '.git')), repoDir());
  check(
    `disk space for images (>= ${MIN_FREE_GIB} GiB)`,
    free >= MIN_FREE_GIB,
    `${free} GiB free in ${cache}`,
  );
  check(
    'cache on disk (not tmpfs)',
    !tmpfs,
    `${cache} on ${mount ? mount.fsType : 'unknown fs'}${tmpfs ? '; set LCR_CACHE to an on-disk directory' : ''}`,
  );
}

/**
 * One row per default profile's browser image, with the versions env.json recorded (or, for a
 * missing image, the command that builds it).
 *
 * @param {(name: string, ok: boolean, detail?: string) => void} check
 * @returns {void}
 */
function checkImages(check) {
  const env = /** @type {Partial<EnvFile>} */ (readJson(join(cacheDir(), 'env.json'), {}) ?? {});

  for (const profile of defaultProfiles()) {
    const tag = browsersTag(profile);
    const versions = env.profiles?.[profile]?.versions ?? {};
    const exists = imageExists(tag);

    check(`image ${tag}`, exists, exists ? dumps(versions) : `run \`lcr setup --profiles ${profile}\``);
  }
}

/**
 * `<name>  <status>  <detail>`, names padded to the longest.
 *
 * @param {readonly DoctorRow[]} rows
 * @returns {void}
 */
function printRows(rows) {
  const width = Math.max(...rows.map(([name]) => name.length));

  for (const [name, status, detail] of rows) {
    print(`${name.padEnd(width)}  ${status.padEnd(STATUS_WIDTH)}  ${detail}`);
  }
}

// ---------------------------------------------------------------------------------------------
// setup

/**
 * @typedef {object} SetupOptions
 * @property {string | null} [profiles] Comma-separated engine profiles (default: engines.json defaults).
 * @property {boolean} [rebuild]
 * @property {boolean} [update]
 */

/**
 * Build the images, record env.json and print it; resolves to the exit status.
 *
 * @param {SetupOptions} options
 * @returns {Promise<number>}
 */
export async function setup({ profiles = null, rebuild = false, update = false }) {
  requireDocker();

  if (update) {
    await updateLatest();
  }

  const wanted = profiles ? profiles.split(',') : defaultProfiles();
  const config = /** @type {EnginesConfig} */ (loadConfig('engines.json'));
  const envPath = join(cacheDir(), 'env.json');
  const env = /** @type {EnvFile} */ (readJson(envPath, {}) || {});

  // The latest profile is the reference and the analysis image: every review needs it.
  if (!wanted.includes('latest')) {
    wanted.unshift('latest');
  }

  env.profiles ??= {};

  for (const profile of wanted) {
    // Validates the name before any image is built.
    engineProfile(profile, config);
    env.profiles[profile] = await setupProfile(profile, config, rebuild);
  }

  const channel = rustChannel();
  const builder = await ensureBuilder(channel, { rebuild });

  env.builder = { image: builder, image_id: imageId(builder), channel };
  env.skill_version = skillVersion();
  writeJson(envPath, env);
  print(dumps(env, { indent: 2, sortKeys: true }));

  return 0;
}

/**
 * Build (if needed) one profile's image and record what it runs.
 *
 * @param {string} profile
 * @param {EnginesConfig} config
 * @param {boolean} rebuild
 * @returns {Promise<EnvProfile>}
 */
async function setupProfile(profile, config, rebuild) {
  const tag = await ensureBrowsers(profile, { rebuild });
  const versions = await engineVersions(profile);
  const failed = Object.fromEntries(
    Object.entries(versions).filter(([, value]) => typeof value === 'string' && value.startsWith('ERROR')),
  );

  if (Object.keys(failed).length > 0) {
    throw new LcrError(`engines failed to launch in ${tag}: ${pyStr(failed)}`, {
      remedy: `rebuild the image with \`lcr setup --rebuild --profiles ${profile}\``,
    });
  }

  const summary = Object.entries(versions).map(([engine, version]) => `${engine} ${pyStr(version)}`);

  log(`${profile}: ${tag} -> ${summary.join(', ')}`);

  return {
    image: tag,
    image_id: imageId(tag),
    role: config.profiles[profile].role,
    versions: /** @type {EnvProfile['versions']} */ (versions),
  };
}

/**
 * The engine versions a profile's image reports (`engine-runner.cjs --versions`).
 *
 * @param {string} profile
 * @returns {Promise<Record<string, unknown>>}
 */
export async function engineVersions(profile) {
  const result = await runBrowsers(profile, ['node', '/opt/lcr/oracle/engine-runner.cjs', '--versions'], {
    mounts: [{ host: join(SKILL_DIR, 'oracle'), container: '/opt/lcr/oracle', mode: 'ro' }],
    check: false,
    timeoutMs: VERSIONS_TIMEOUT_MS,
  });
  const lastLine = pySplitlines(pyStrip(result.stdout)).at(-1);

  try {
    if (lastLine === undefined) {
      throw new SyntaxError('no output');
    }

    return /** @type {Record<string, unknown>} */ (loads(lastLine));
  } catch (error) {
    const output = Array.from(`${result.stdout}${result.stderr}`).slice(-VERSIONS_ERROR_TAIL_CHARS).join('');

    throw new LcrError(`could not read engine versions for ${profile}:\n${output}`, { cause: error });
  }
}

/**
 * The Rust channel of the Lightning CSS clone's rust-toolchain.toml (default `stable`).
 *
 * @returns {string}
 */
function rustChannel() {
  return toolchainChannel(repoDir());
}

// ---------------------------------------------------------------------------------------------
// setup --update

const NPM_LATEST_URL = 'https://registry.npmjs.org/playwright/latest';
const MANIFEST_URL = 'https://mcr.microsoft.com/v2/playwright/manifests/';
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');
const REGISTRY_TIMEOUT_MS = 30_000;
const REGISTRY_REMEDY = 'check the network, then run `lcr setup --update` again';
const HTTP_NOT_FOUND = 404;
const ENGINES = /** @type {const} */ (['chromium', 'firefox', 'webkit']);

/**
 * @typedef {object} UpdateHooks Injection points for tests.
 * @property {() => Promise<string>} [newestRelease]
 * @property {(image: string) => Promise<boolean>} [imagePublished]
 * @property {() => Promise<number>} [selftest] The selftest over the default profiles; resolves to its
 *   exit status.
 */

/**
 * Move the latest profile to the newest Playwright release if its selftest passes there.
 * Resolves to the pin in effect afterwards.
 *
 * @param {UpdateHooks} [hooks]
 * @returns {Promise<PlaywrightPin>}
 */
export async function updateLatest({
  newestRelease = newestPlaywrightRelease,
  imagePublished = playwrightImagePublished,
  selftest = defaultSelftest,
} = {}) {
  const current = playwrightPin('latest');
  const version = await newestRelease();

  if (version === current.version) {
    log(`latest: Playwright ${version} is the newest release; nothing to update`);

    return current;
  }

  const candidate = candidatePin(current, version);

  if (!(await imagePublished(candidate.image))) {
    throw new LcrError(`${candidate.image} is not published yet`, {
      remedy: 'try `lcr setup --update` later',
    });
  }

  log(`latest: trying Playwright ${version} (pinned: ${current.version})`);

  using _pin = overridePin('latest', candidate);

  const config = /** @type {EnginesConfig} */ (loadConfig('engines.json'));
  /** @type {Record<string, EnvProfile>} */
  const entries = {};

  // The selftest's expectations compare the reference with the legacy engines, so it runs on
  // every default profile; only the latest one is on the candidate release.
  for (const profile of defaultProfiles()) {
    entries[profile] = await setupProfile(profile, config, false);
  }

  const status = await withProvisionalEnv(entries, selftest);

  if (status !== 0) {
    throw new LcrError(`the selftest failed on Playwright ${version}; latest stays on ${current.version}`, {
      remedy: `inspect it with \`lcr selftest\` after pinning ${candidate.image} by hand`,
    });
  }

  writePin('latest', candidate.image);
  writeExpectedVersions('latest', entries.latest.versions);
  log(`latest: pinned ${candidate.image} in compose.yaml`);

  return candidate;
}

/**
 * Run `action` with env.json recording these profile entries (the oracle reads images and engine
 * versions from env.json). When the action resolves to anything but 0, env.json is put back as it
 * was; otherwise the entries stay.
 *
 * @param {Record<string, EnvProfile>} entries
 * @param {() => Promise<number>} action
 * @returns {Promise<number>}
 */
export async function withProvisionalEnv(entries, action) {
  const envPath = join(cacheDir(), 'env.json');
  const before = existsSync(envPath) ? readFileSync(envPath) : null;
  const env = /** @type {EnvFile} */ (readJson(envPath, {}) || {});
  let status = 1;

  env.profiles = { ...env.profiles, ...entries };
  writeJson(envPath, env);

  try {
    status = await action();
  } finally {
    if (status !== 0 && before === null) {
      removeFile(envPath);
    } else if (status !== 0) {
      writeAtomic(envPath, (tmp) => writeFileSync(tmp, /** @type {Buffer} */ (before)));
    }
  }

  return status;
}

/**
 * The same distro as the current pin, on another release.
 *
 * @param {PlaywrightPin} current
 * @param {string} version
 * @returns {PlaywrightPin}
 */
export function candidatePin(current, version) {
  const suffix = current.distro ? `-${current.distro}` : '';

  return /** @type {PlaywrightPin} */ (
    parsePlaywrightImage(`mcr.microsoft.com/playwright:v${version}${suffix}`)
  );
}

/**
 * The newest Playwright release on the npm registry.
 *
 * @returns {Promise<string>}
 */
async function newestPlaywrightRelease() {
  const response = await fetchChecked(NPM_LATEST_URL, {
    timeoutMs: REGISTRY_TIMEOUT_MS,
    remedy: REGISTRY_REMEDY,
  });
  const { version } = /** @type {{ version: string }} */ (await response.json());

  return version;
}

/**
 * Whether the Playwright image exists on mcr.microsoft.com (anonymous manifest lookup).
 *
 * @param {string} image
 * @returns {Promise<boolean>}
 */
async function playwrightImagePublished(image) {
  const tag = image.slice(image.lastIndexOf(':') + 1);
  const response = await fetchChecked(`${MANIFEST_URL}${tag}`, {
    method: 'HEAD',
    headers: { Accept: MANIFEST_ACCEPT },
    allow: [HTTP_NOT_FOUND],
    timeoutMs: REGISTRY_TIMEOUT_MS,
    remedy: REGISTRY_REMEDY,
  });

  return response.ok;
}

/**
 * The oracle's known-answer cases in every default profile (`lcr selftest`).
 *
 * @returns {Promise<number>}
 */
async function defaultSelftest() {
  const { selftest } = await import('../oracle-driver/selftest.js');

  return selftest({ profiles: null });
}

/**
 * Record the engine versions a profile now runs as its `expected` versions in engines.json.
 *
 * @param {string} profile
 * @param {Record<string, unknown>} versions
 * @returns {void}
 */
function writeExpectedVersions(profile, versions) {
  const path = join(CONFIG_DIR, 'engines.json');
  const config = /** @type {EnginesConfig} */ (loadConfig('engines.json'));
  const expected = config.profiles[profile].expected;

  for (const engine of ENGINES) {
    if (typeof versions[engine] === 'string') {
      expected[engine] = /** @type {string} */ (versions[engine]);
    }
  }

  // engines.json is kept in json.dumps(indent=2) layout: insertion order, ASCII escapes.
  writeAtomic(path, (tmp) => writeFileSync(tmp, `${dumps(config, { indent: 2 })}\n`));
}
