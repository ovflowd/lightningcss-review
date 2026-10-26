/**
 * Run prepared oracle cases through the browser engines, in containers.
 *
 * Stage: oracle (also `lcr selftest` and `lcr baseline`). The steps, all under <out>:
 * 1. analysis image: prepare-jobs.mjs (DOM synthesis, state rewrite, validity probes) -> jobs.jsonl
 * 2. reference engines (latest Chromium, Firefox, WebKit): engine-runner.cjs -> results-latest.jsonl
 * 3. legacy engine profiles, only for cases with targets (lowering checks): legacy-jobs.jsonl ->
 *    results-<profile>.jsonl
 * 4. analysis image: compare.mjs -> verdicts.jsonl (fixed / regressed / both-equivalent / ...)
 *
 * Reads <cache>/env.json (what `lcr setup` built). Writes <out>/cases.jsonl, env.json and every
 * file the oracle scripts produce. The script names and flags are the oracle group's contract.
 *
 * Invariants: containers run without network, as the host user, with oracle/ mounted read-only;
 * a failing step stops the stage with the tail of its output.
 */
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';

import { MIB } from '../core/disk.js';
import { requireDocker } from '../core/docker.js';
import { LcrError } from '../core/errors.js';
import { iterLines, readJson, readJsonl, writeJsonl } from '../core/files.js';
import { log } from '../core/log.js';
import { cacheDir, SKILL_DIR } from '../core/paths.js';
import { pyGet } from '../core/py-value.js';
import { pySlice, pyStr, pyTruthy } from '../core/py.js';
import { compareCodePoints } from '../core/pyjson.js';
import { browsersTag, defaultProfiles, ensureBrowsers, runBrowsers } from '../setup/images.js';

/** @import { CaseVerdict, EngineVersions, EnvFile, JobMeta, OracleCase } from '../types.js' */

/** Where oracle/ is mounted in the containers. */
const ORACLE_MOUNT = '/opt/lcr/oracle';
/** Where the step's output directory is mounted. */
const RUN_MOUNT = '/run';
/** The profile with the reference engines; its image also runs the analysis scripts. */
const REFERENCE_PROFILE = 'latest';
/** One oracle step may take this long (large runs in three engines). */
const STEP_TIMEOUT_MS = 7200 * 1000;
/** Characters of a failed step's output kept in the error. */
const FAILURE_TAIL_CHARS = 3000;
const ENGINES = ['chromium', 'firefox', 'webkit'];
/** Fixed disk need of an oracle run plus a per-case allowance (screenshots, results). */
const DISK_BASE_BYTES = 200 * MIB;
const DISK_BYTES_PER_CASE = 512 * 2 ** 10;

/**
 * @typedef {object} EngineEnvironment
 * @property {EnvFile} env <cache>/env.json
 * @property {string} envPath
 * @property {string[]} wanted Profiles to run (the reference profile is always run).
 */

/**
 * @typedef {object} OracleResult
 * @property {Record<string, CaseVerdict[]>} verdicts Case id -> verdicts, in verdicts.jsonl order.
 * @property {Record<string, EngineVersions>} profiles Profiles that ran -> their engine versions.
 * @property {Record<string, JobMeta>} dom Job metadata by case id (jobs.meta.jsonl).
 */

/**
 * Docker, the engine images recorded by `lcr setup`, and the profiles to run.
 *
 * @param {string | null | undefined} profiles Comma-separated profiles; default engines.json's.
 * @returns {EngineEnvironment}
 */
export function engineEnvironment(profiles) {
  requireDocker();

  const envPath = join(cacheDir(), 'env.json');
  const env = /** @type {EnvFile | null} */ (readJson(envPath));

  if (!env || !pyTruthy(env) || !Object.hasOwn(pyGet(env, 'profiles', {}), REFERENCE_PROFILE)) {
    throw new LcrError('engines not set up', { remedy: 'run `lcr setup`' });
  }

  return { env, envPath, wanted: profiles ? profiles.split(',') : defaultProfiles() };
}

/**
 * Bytes an oracle run over `caseCount` cases may write.
 *
 * @param {number} caseCount
 * @returns {number}
 */
export function oracleDiskNeed(caseCount) {
  return DISK_BASE_BYTES + DISK_BYTES_PER_CASE * caseCount;
}

/**
 * Run the engine pipeline for prepared oracle cases in `out`.
 *
 * @param {string} out An empty directory.
 * @param {readonly OracleCase[]} cases
 * @param {EngineEnvironment} environment
 * @returns {Promise<OracleResult>}
 */
export async function runOracle(out, cases, { env, envPath, wanted }) {
  writeJsonl(join(out, 'cases.jsonl'), cases);
  copyFileSync(envPath, join(out, 'env.json'));
  await ensureBrowsers(REFERENCE_PROFILE);

  const node = (/** @type {string} */ profile, /** @type {string[]} */ args) => runNode(profile, out, args);
  const script = (/** @type {string} */ name) => `${ORACLE_MOUNT}/${name}`;

  log(`oracle: preparing ${cases.length} cases`);
  await node(REFERENCE_PROFILE, [
    script('prepare-jobs.mjs'),
    ...['--cases', '/run/cases.jsonl', '--out', '/run/jobs.jsonl', '--meta', '/run/jobs.meta.jsonl'],
  ]);
  log(
    `oracle: ${countLines(join(out, 'jobs.jsonl'))} jobs in reference engines ` +
      `(${engineVersions(env, REFERENCE_PROFILE)})`,
  );
  await node(REFERENCE_PROFILE, [
    script('engine-runner.cjs'),
    ...['--jobs', '/run/jobs.jsonl', '--out', '/run/results-latest.jsonl', '--screenshots', '/run/shots'],
  ]);

  /** @type {Record<string, EngineVersions>} */
  const profiles = { [REFERENCE_PROFILE]: env.profiles[REFERENCE_PROFILE].versions };
  const resultArgs = ['--results', `${REFERENCE_PROFILE}=/run/results-latest.jsonl`];

  resultArgs.push(...(await runLegacyProfiles(out, cases, { env, wanted, profiles })));
  await node(REFERENCE_PROFILE, [
    script('compare.mjs'),
    ...['--cases', '/run/cases.jsonl', '--jobs', '/run/jobs.jsonl', '--env', '/run/env.json'],
    ...['--out', '/run/verdicts.jsonl', '--shots', '/run/shots', ...resultArgs],
  ]);

  const rows = /** @type {CaseVerdict[]} */ (readJsonl(join(out, 'verdicts.jsonl')));
  const meta = /** @type {JobMeta[]} */ (readJsonl(join(out, 'jobs.meta.jsonl')));

  return {
    verdicts: /** @type {Record<string, CaseVerdict[]>} */ ({
      ...Object.groupBy(rows, (verdict) => verdict.case),
    }),
    profiles,
    dom: Object.fromEntries(meta.map((row) => [row.id, row])),
  };
}

/**
 * The lowering checks: the cases with targets, in every wanted legacy profile that is set up.
 * Records each profile that ran in `profiles`; returns compare.mjs's `--results` arguments.
 *
 * @param {string} out
 * @param {readonly OracleCase[]} cases
 * @param {{ env: EnvFile, wanted: string[], profiles: Record<string, EngineVersions> }} options
 * @returns {Promise<string[]>}
 */
async function runLegacyProfiles(out, cases, { env, wanted, profiles }) {
  const targeted = cases
    .filter((entry) => entry.kind === 'sheet' && pyTruthy(entry.targets))
    .map((entry) => entry.id)
    .sort(compareCodePoints);

  if (targeted.length === 0) {
    return [];
  }

  await runNode(REFERENCE_PROFILE, out, [
    `${ORACLE_MOUNT}/prepare-jobs.mjs`,
    ...['--legacy', '--jobs', '/run/jobs.jsonl', '--results', '/run/results-latest.jsonl'],
    ...['--out', '/run/legacy-jobs.jsonl', '--ids', targeted.join(',')],
  ]);

  const resultArgs = [];

  for (const profile of wanted) {
    if (profile === REFERENCE_PROFILE) {
      continue;
    }

    if (!Object.hasOwn(env.profiles, profile)) {
      log(`oracle: profile ${profile} not set up; skipping (run \`lcr setup --profiles ${profile}\`)`);
      continue;
    }

    log(`oracle: ${targeted.length} lowering cases in ${profile} (${engineVersions(env, profile)})`);
    await runNode(profile, out, [
      `${ORACLE_MOUNT}/engine-runner.cjs`,
      ...['--jobs', '/run/legacy-jobs.jsonl', '--out', `/run/results-${profile}.jsonl`],
    ]);
    resultArgs.push('--results', `${profile}=/run/results-${profile}.jsonl`);
    profiles[profile] = env.profiles[profile].versions;
  }

  return resultArgs;
}

/**
 * Lines in a text file (one job per line).
 *
 * @param {string} path
 * @returns {number}
 */
function countLines(path) {
  let count = 0;

  for (const _line of iterLines(path)) {
    count++;
  }

  return count;
}

/**
 * `chromium, firefox, webkit` versions of a profile (`?` for an unknown one).
 *
 * @param {EnvFile} env
 * @param {string} profile
 * @returns {string}
 */
function engineVersions(env, profile) {
  const versions = env.profiles[profile].versions;

  return ENGINES.map((engine) => pyStr(pyGet(versions, engine, '?'))).join(', ');
}

/**
 * Run one oracle script with Node in a profile's browser image.
 *
 * @param {string} profile
 * @param {string} out Mounted at /run.
 * @param {readonly string[]} args The script path and its arguments.
 * @returns {Promise<void>}
 */
async function runNode(profile, out, args) {
  const result = await runBrowsers(profile, ['node', ...args], {
    mounts: [
      { host: join(SKILL_DIR, 'oracle'), container: ORACLE_MOUNT, mode: 'ro' },
      { host: out, container: RUN_MOUNT, mode: 'rw' },
    ],
    check: false,
    timeoutMs: STEP_TIMEOUT_MS,
  });
  const image = browsersTag(profile);

  if (result.timedOut) {
    throw new LcrError(`${args[0]} timed out after ${STEP_TIMEOUT_MS / 1000}s in ${image}`);
  }

  if (result.code !== 0) {
    throw new LcrError(`${args[0]} failed in ${image}:`, {
      detail: pySlice(result.stdout + result.stderr, -FAILURE_TAIL_CHARS),
    });
  }
}
