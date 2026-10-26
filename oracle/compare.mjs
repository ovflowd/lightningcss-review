/**
 * compare: raw engine results -> per-case verdicts.
 *
 * Stage: oracle, analysis image (colorjs.io, pngjs available).
 *
 *   node compare.mjs --cases cases.jsonl --jobs jobs.jsonl --env env.json --out verdicts.jsonl
 *                    --results latest=results-latest.jsonl [--results legacy-2023=results-legacy-2023.jsonl …]
 *                    [--shots DIR]
 *
 * Result files are streamed (they can exceed V8's string limit); `.gz` files are read transparently.
 * Writes one verdict row per job (lib/verdicts.mjs), sorted by job id. A missing cases, jobs or
 * results file reads as empty; `--env` and `--out` are required. Exit status 2 on a usage error.
 */
import { readFileSync } from 'node:fs';

import { parseOptions } from './lib/cli.mjs';
import { caseIdOf } from './lib/jobs.mjs';
import { jsonlWriter, readJsonl } from './lib/jsonl.mjs';
import { collectResults, resultProfiles, verdictRow } from './lib/verdicts.mjs';

/** @import { Job, OracleCase } from './lib/types.mjs' */

const USAGE =
  'usage: compare.mjs --cases FILE --jobs FILE --env FILE --out FILE --results PROFILE=FILE... [--shots DIR]';

const options = parseOptions(
  {
    cases: { type: 'string' },
    jobs: { type: 'string' },
    env: { type: 'string' },
    out: { type: 'string' },
    results: { type: 'string', multiple: true, default: [] },
    shots: { type: 'string' },
  },
  USAGE,
);

/**
 * Rows of a JSONL file keyed by `id` (later rows win).
 *
 * @template {{ id: string }} T
 * @param {string | undefined} file
 * @returns {Promise<Map<string, T>>}
 */
async function byId(file) {
  /** @type {Map<string, T>} */
  const rows = new Map();

  for await (const row of readJsonl(file)) {
    rows.set(/** @type {T} */ (row).id, /** @type {T} */ (row));
  }

  return rows;
}

/** @type {Map<string, OracleCase>} */
const cases = await byId(options.cases);
/** @type {Map<string, Job>} */
const jobs = await byId(options.jobs);
const env = JSON.parse(readFileSync(/** @type {string} */ (options.env), 'utf8'));
const profiles = resultProfiles(options.results, env);
const results = await collectResults(profiles, jobs, cases, options.shots ?? null);
const out = jsonlWriter(/** @type {string} */ (options.out));

for (const id of [...jobs.keys()].toSorted()) {
  const job = /** @type {Job} */ (jobs.get(id));

  out.write(verdictRow(id, job, cases.get(caseIdOf(id)) || {}, profiles, results));
}

await out.end();
