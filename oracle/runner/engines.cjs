/**
 * Runs prepared jobs in the browsers of one engine profile (one Playwright image).
 *
 * Stage: oracle (engine runner, Node 14/16/24). Reads jobs.jsonl or legacy-jobs.jsonl and writes
 * one raw result row per job and engine (results-<profile>.jsonl) plus, for visual jobs, one PNG
 * per variant. All interpretation happens later in compare.mjs; this module only drives the
 * browsers, through the small Playwright surface that every release since 1.16 has: `launch`,
 * `newContext`, `newPage`, `setContent`, `evaluate`, `emulateMedia` and `screenshot`.
 *
 * Invariants:
 * - One row per (job, engine), in job order, engines in `--engines` order.
 * - A failing job never takes the rest down: its row carries `error` and the page is replaced.
 * - A failing screenshot loses only the visual check (`visualError`), never the computed styles.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { SKELETON, CONTEXT_OPTIONS } = require('./page/document.cjs');
const { pageProperty } = require('./page/property.cjs');
const { pageSnapshot } = require('./page/snapshot.cjs');
const { clearStyle, showVariant } = require('./page/visual.cjs');
const { shotFile } = require('./shots.cjs');

/** @import { Job, SheetJob, EngineResult } from '../lib/types.mjs' */
/** @import { Page, BrowserContext } from 'playwright' */
/** @import { RowWriter } from './jsonl.cjs' */

/** @typedef {Record<string, import('playwright').BrowserType>} Playwright Engine name -> browser type. */

/** Screenshot hashes are shortened like case ids. */
const SHOT_HASH_LENGTH = 16;
/** Playwright's manifest (a variable, so type checking does not try to resolve it). */
const PLAYWRIGHT_MANIFEST = 'playwright/package.json';
/** Lines of an error message kept in a result row (Playwright appends long call logs). */
const ERROR_LINES = 3;

/**
 * First line(s) of an error's message.
 *
 * @param {unknown} error
 * @param {number} lines
 * @returns {string}
 */
function errorText(error, lines) {
  const message =
    error && /** @type {Error} */ (error).message ? /** @type {Error} */ (error).message : error;

  return String(message).split('\n').slice(0, lines).join(' ');
}

/**
 * The Playwright package version, read without assuming how the image laid out node_modules.
 *
 * @returns {string}
 */
function playwrightVersion() {
  try {
    return require(PLAYWRIGHT_MANIFEST).version;
  } catch {
    try {
      return require(path.join(require.resolve('playwright'), '..', 'package.json')).version;
    } catch {
      return 'unknown';
    }
  }
}

/**
 * Print `{playwright, node, <engine>: <version>}` as one JSON line (`lcr setup` records it).
 *
 * @param {Playwright} playwright
 * @param {string[]} engines
 * @returns {Promise<void>}
 */
async function printVersions(playwright, engines) {
  /** @type {Record<string, string>} */
  const versions = { playwright: playwrightVersion(), node: process.version };

  for (const name of engines) {
    try {
      const browser = await playwright[name].launch();

      versions[name] = browser.version();
      await browser.close();
    } catch (error) {
      versions[name] = 'ERROR: ' + errorText(error, 1);
    }
  }

  process.stdout.write(JSON.stringify(versions) + '\n');
}

/**
 * The jobs one engine runs. Lowering jobs read only the properties and elements the reference
 * engine of the same family saw the input touch (`propsByEngine`, `keysByEngine`).
 *
 * @param {Job[]} jobs
 * @param {string} engine
 * @returns {Job[]}
 */
function jobsForEngine(jobs, engine) {
  return jobs
    .filter((job) => !job.engines || job.engines.indexOf(engine) >= 0)
    .map((job) => {
      if (!('propsByEngine' in job) || !job.propsByEngine) {
        return job;
      }

      const keys = (job.keysByEngine && job.keysByEngine[engine]) || null;

      return Object.assign({}, job, { props: job.propsByEngine[engine] || [], keys });
    });
}

/**
 * Screenshot every non-empty variant of a visual job: `{variant: hash}`, PNGs written to `dir`.
 *
 * @param {Page} page
 * @param {SheetJob} job
 * @param {string} engine
 * @param {string} dir
 * @returns {Promise<Record<string, string>>}
 */
async function screenshotVariants(page, job, engine, dir) {
  /** @type {Record<string, string>} */
  const shots = {};

  for (const variant of Object.keys(job.sheets)) {
    if (variant === 'empty') {
      continue;
    }

    await page.evaluate(showVariant, { html: job.html || '', css: job.sheets[variant] });

    const handle = await page.$('#lcr-root');
    const image = await /** @type {import('playwright').ElementHandle} */ (handle).screenshot();

    shots[variant] = crypto.createHash('sha256').update(image).digest('hex').slice(0, SHOT_HASH_LENGTH);
    fs.writeFileSync(shotFile(dir, job.id, engine, variant), image);
  }

  return shots;
}

/**
 * Run one sheet job: computed styles (in the job's color scheme), then screenshots if asked.
 *
 * @param {Page} page
 * @param {SheetJob} job
 * @param {string} engine
 * @param {string | null} shotsDir
 * @returns {Promise<Partial<EngineResult>>}
 */
async function runSheetJob(page, job, engine, shotsDir) {
  if (job.colorScheme) {
    await page.emulateMedia({ colorScheme: job.colorScheme });
  }

  /** @type {Partial<EngineResult>} */
  const record = { result: /** @type {EngineResult['result']} */ (await page.evaluate(pageSnapshot, job)) };

  if (job.visual && shotsDir) {
    try {
      record.shots = await screenshotVariants(page, job, engine, shotsDir);
    } catch (error) {
      record.visualError = errorText(error, 1);
    }

    await page.evaluate(clearStyle);
  }

  if (job.colorScheme) {
    await page.emulateMedia({ colorScheme: 'light' });
  }

  return record;
}

/**
 * A page showing the skeleton document.
 *
 * @param {BrowserContext} context
 * @returns {Promise<Page>}
 */
async function freshPage(context) {
  const page = await context.newPage();

  await page.setContent(SKELETON);

  return page;
}

/**
 * Run every job in one engine and write a row per job.
 *
 * @param {Playwright} playwright
 * @param {string} engine
 * @param {Job[]} jobs
 * @param {RowWriter} out
 * @param {string | null} shotsDir
 * @returns {Promise<void>}
 */
async function runEngine(playwright, engine, jobs, out, shotsDir) {
  const browser = await playwright[engine].launch();
  const version = browser.version();
  const context = await browser.newContext(CONTEXT_OPTIONS);
  let page = await freshPage(context);

  for (const job of jobs) {
    const started = Date.now();
    /** @type {Partial<EngineResult>} */
    let record;

    try {
      record =
        job.kind === 'property'
          ? { result: /** @type {EngineResult['result']} */ (await page.evaluate(pageProperty, job)) }
          : await runSheetJob(page, job, engine, shotsDir);
    } catch (error) {
      record = { error: errorText(error, ERROR_LINES) };

      // A crashed or wedged page is replaced so one bad case cannot poison the rest.
      try {
        await page.close();
      } catch {
        // The page is already gone.
      }

      page = await freshPage(context);
    }

    record.id = job.id;
    record.engine = engine;
    record.version = version;
    record.ms = Date.now() - started;
    out.write(record);
  }

  await browser.close();
}

module.exports = { printVersions, jobsForEngine, runEngine, errorText, playwrightVersion };
