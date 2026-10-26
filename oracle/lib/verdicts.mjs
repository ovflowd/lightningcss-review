/**
 * Raw engine results of every profile -> one verdict row per job (oracle/verdicts.jsonl).
 *
 * Stage: oracle (analysis image, compare.mjs). Reads the cases, jobs, env.json profile roles and
 * the results-<profile>.jsonl files; writes rows in job-id order, each with the per-engine entries
 * of the reference profile (`latest`) and of each legacy profile, and their summaries.
 *
 * Invariants: rows are sorted by job id and engines by name inside each profile, so the output
 * never depends on the order the runner wrote results in; the reference profile is processed
 * first because lowering verdicts need its input `touched`.
 */
import { caseIdOf, DARK_SUFFIX } from './jobs.mjs';
import { readJsonl } from './jsonl.mjs';
import { judgeShots } from './shots.mjs';
import { summarize } from './summary.mjs';
import { engineEntry } from './verdict.mjs';

/** @import { CaseVerdict, EngineBucket, EngineResult, Job, OracleCase, StyleMap } from './types.mjs' */

/**
 * @typedef {object} ResultProfile
 * @property {string} name
 * @property {string} file
 * @property {string} role `reference` or `legacy`.
 */

/**
 * @typedef {object} Buckets The entries of one job, by profile and engine.
 * @property {EngineBucket} latest
 * @property {Record<string, EngineBucket>} legacy
 */

/**
 * @typedef {object} CollectedResults
 * @property {Map<string, Buckets>} buckets Job id -> entries.
 * @property {Map<string, StyleMap | null>} refTouched `<job id>|<engine>` -> the reference input's touched values.
 */

/**
 * The result files given as `<profile>=<file>`, with their roles (env.json, else `latest` is the
 * reference), the reference first.
 *
 * @param {string[]} specs
 * @param {{ profiles?: Record<string, { role?: string }> }} env
 * @returns {ResultProfile[]}
 */
export function resultProfiles(specs, env) {
  return specs
    .map((spec) => {
      const [name, file] = spec.split('=');
      const role =
        (env.profiles && env.profiles[name] && env.profiles[name].role) ||
        (name === 'latest' ? 'reference' : 'legacy');

      return { name, file, role };
    })
    .toSorted((a, b) => (a.role === 'reference' ? 0 : 1) - (b.role === 'reference' ? 0 : 1));
}

/**
 * Turn every result row into an engine entry, filed under its job, profile and engine.
 *
 * @param {ResultProfile[]} profiles Reference first.
 * @param {Map<string, Job>} jobs
 * @param {Map<string, OracleCase>} cases
 * @param {string | null} shotsDir
 * @returns {Promise<CollectedResults>}
 */
export async function collectResults(profiles, jobs, cases, shotsDir) {
  /** @type {Map<string, Buckets>} */
  const buckets = new Map();
  /** @type {Map<string, StyleMap | null>} */
  const refTouched = new Map();

  for (const profile of profiles) {
    for await (const line of readJsonl(profile.file)) {
      const row = /** @type {EngineResult} */ (line);
      const job = jobs.get(row.id);

      if (!job) {
        continue;
      }

      const oracleCase = cases.get(caseIdOf(row.id)) || {};
      const key = `${row.id}|${row.engine}`;

      if (profile.role === 'reference') {
        const input = row.result && row.result.variants ? row.result.variants.input : undefined;

        refTouched.set(key, (input ? input.touched : null) || null);
      }

      const entry = engineEntry(profile.role, row, job, oracleCase, refTouched.get(key));

      if (row.shots) {
        entry.visual = judgeShots(row.shots, shotsDir, row.id, row.engine);
      }

      if (row.visualError) {
        entry.visualError = row.visualError;
      }

      if (!buckets.has(row.id)) {
        buckets.set(row.id, { latest: {}, legacy: {} });
      }

      const byProfile = /** @type {Buckets} */ (buckets.get(row.id));
      const bucket =
        profile.role === 'reference'
          ? byProfile.latest
          : (byProfile.legacy[profile.name] = byProfile.legacy[profile.name] || {});

      bucket[row.engine] = entry;
    }
  }

  return { buckets, refTouched };
}

/**
 * @template T
 * @param {Record<string, T>} object
 * @returns {Record<string, T>} The same entries, keys in sorted order.
 */
function sortKeys(object) {
  return Object.fromEntries(
    Object.keys(object)
      .toSorted()
      .map((key) => [key, object[key]]),
  );
}

/**
 * The verdict row of one job.
 *
 * @param {string} id Job id.
 * @param {Job} job
 * @param {OracleCase | Record<string, never>} oracleCase `{}` when unknown.
 * @param {ResultProfile[]} profiles
 * @param {CollectedResults} results
 * @returns {CaseVerdict}
 */
export function verdictRow(id, job, oracleCase, profiles, { buckets, refTouched }) {
  const byProfile = buckets.get(id) || { latest: {}, legacy: {} };
  /** @type {Record<string, EngineBucket>} */
  const legacy = {};

  for (const profile of profiles) {
    if (byProfile.legacy[profile.name]) {
      legacy[profile.name] = sortKeys(byProfile.legacy[profile.name]);
    }
  }

  const latest = sortKeys(byProfile.latest);
  /** @type {CaseVerdict} */
  const verdict = {
    id,
    case: caseIdOf(id),
    kind: job.kind,
    scheme: id.endsWith(DARK_SUFFIX) ? 'dark' : 'light',
    latest,
    legacy,
  };
  // `introduced`: base cannot run the request (a flag or option the PR adds), so head is judged
  // against the input alone.
  const options = { introduced: Boolean('introduced' in oracleCase && oracleCase.introduced) };
  const touched = Object.fromEntries(
    Object.keys(latest).map((engine) => [engine, refTouched.get(`${id}|${engine}`)]),
  );

  verdict.summary = { latest: summarize(latest, { ...options, touched }), legacy: {} };

  for (const [name, bucket] of Object.entries(legacy)) {
    verdict.summary.legacy[name] = summarize(bucket, options);
  }

  return verdict;
}
