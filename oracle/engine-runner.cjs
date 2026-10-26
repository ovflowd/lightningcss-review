/**
 * Engine runner: runs prepared oracle jobs in the browsers of one engine profile.
 *
 * Stage: oracle. Runs inside every browsers image, including the legacy ones that ship Node 14
 * and 16, so this file and oracle/runner/ are CommonJS with ES2020 syntax only.
 *
 *   node engine-runner.cjs --jobs jobs.jsonl --out results.jsonl [--engines chromium,firefox,webkit]
 *                          [--screenshots DIR]
 *   node engine-runner.cjs --versions [--engines …]
 *
 * Reads a jobs file (`.gz` allowed) and writes one result row per job and engine (see
 * runner/engines.cjs). `--versions` prints the Playwright, Node and browser versions as one JSON
 * line instead. Exit status 2 on any failure outside a single job.
 */
'use strict';

const fs = require('fs');

const playwright = require('playwright');

const { parseRunnerArgs } = require('./runner/args.cjs');
const { jobsForEngine, printVersions, runEngine } = require('./runner/engines.cjs');
const { openRowWriter, readRows } = require('./runner/jsonl.cjs');

/** @import { Job } from './lib/types.mjs' */

/**
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function main(argv) {
  const options = parseRunnerArgs(argv);

  if (options.versions) {
    return printVersions(playwright, options.engines);
  }

  if (!options.jobs || !options.out) {
    throw new Error('usage: engine-runner.cjs --jobs FILE --out FILE');
  }

  /** @type {Job[]} */
  const jobs = [];

  for await (const job of readRows(options.jobs)) {
    jobs.push(/** @type {Job} */ (job));
  }

  if (options.screenshots) {
    fs.mkdirSync(options.screenshots, { recursive: true });
  }

  const out = openRowWriter(options.out);

  for (const engine of options.engines) {
    const subset = jobsForEngine(jobs, engine);

    if (subset.length) {
      await runEngine(playwright, engine, subset, out, options.screenshots);
    }
  }

  await out.end();
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error) + '\n');
  process.exit(2);
});
