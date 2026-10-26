/**
 * prepare-jobs: oracle cases (written by `lcr oracle`) -> engine jobs.
 *
 * Stage: oracle, analysis image (css-tree available).
 *
 *   node prepare-jobs.mjs --cases cases.jsonl --out jobs.jsonl [--meta jobs.meta.jsonl]
 *   node prepare-jobs.mjs --legacy --jobs jobs.jsonl --results results-latest.jsonl
 *                         --out legacy-jobs.jsonl [--ids <case>,<case>…]
 *
 * Reference mode writes the jobs of every case (lib/jobs.mjs) and one meta row per case (DOM
 * coverage, rewrites, or the error that kept the case from becoming a job; `--meta` defaults to
 * `<out>.meta`). Legacy mode writes, in job-id order, the sheet jobs of the given cases (all when
 * `--ids` is empty) narrowed to what the reference engines saw the input touch. Without `--out`
 * nothing is written; a missing input file reads as empty. Exit status 2 on a usage error.
 */
import { parseOptions } from './lib/cli.mjs';
import { caseIdOf, legacyJob, propertyJob, sheetJob, touchedByJob } from './lib/jobs.mjs';
import { jsonlWriter, readJsonl } from './lib/jsonl.mjs';

/** @import { OracleCase, Job } from './lib/types.mjs' */
/** @import { TouchedSubset } from './lib/jobs.mjs' */

const USAGE =
  'usage: prepare-jobs.mjs --cases FILE --out FILE [--meta FILE]\n' +
  '       prepare-jobs.mjs --legacy --jobs FILE --results FILE --out FILE [--ids ID,ID...]';

const options = parseOptions(
  {
    cases: { type: 'string' },
    out: { type: 'string' },
    meta: { type: 'string' },
    legacy: { type: 'boolean', default: false },
    jobs: { type: 'string' },
    results: { type: 'string' },
    ids: { type: 'string', default: '' },
  },
  USAGE,
);

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return String(error && /** @type {Error} */ (error).message ? /** @type {Error} */ (error).message : error);
}

/**
 * Reference jobs and their meta rows.
 *
 * @param {string} out
 * @returns {Promise<void>}
 */
async function writeReferenceJobs(out) {
  const jobsOut = jsonlWriter(out);
  const metaOut = jsonlWriter(options.meta ?? `${out}.meta`);

  for await (const row of readJsonl(options.cases)) {
    const oracleCase = /** @type {OracleCase} */ (row);
    let built;

    try {
      built = oracleCase.kind === 'property' ? propertyJob(oracleCase) : sheetJob(oracleCase);
    } catch (error) {
      // One case the synthesizer cannot handle must not cost the run its other cases.
      metaOut.write({ id: oracleCase.id, error: errorMessage(error) });
      continue;
    }

    built.jobs.forEach((job) => jobsOut.write(job));
    metaOut.write(built.meta);
  }

  await Promise.all([jobsOut.end(), metaOut.end()]);
}

/**
 * Legacy jobs for the requested cases.
 *
 * @param {string} out
 * @returns {Promise<void>}
 */
async function writeLegacyJobs(out) {
  /** @type {Map<string, Job>} */
  const jobs = new Map();

  for await (const row of readJsonl(options.jobs)) {
    jobs.set(/** @type {Job} */ (row).id, /** @type {Job} */ (row));
  }

  const wanted = new Set(options.ids.split(',').filter(Boolean));
  const touched = await touchedByJob(readJsonl(options.results));
  const writer = jsonlWriter(out);

  for (const id of [...touched.keys()].toSorted()) {
    if (wanted.size && !wanted.has(caseIdOf(id))) {
      continue;
    }

    const job = jobs.get(id);

    if (!job || job.kind !== 'sheet') {
      continue;
    }

    writer.write(legacyJob(job, /** @type {TouchedSubset} */ (touched.get(id))));
  }

  await writer.end();
}

if (options.out) {
  await (options.legacy ? writeLegacyJobs(options.out) : writeReferenceJobs(options.out));
}
