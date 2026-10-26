/**
 * `lcr selftest`: the oracle's known-answer cases through every engine profile.
 *
 * Stage: setup check (also run by `lcr setup --update` before a new Playwright pin is kept).
 * Reads oracle/test/selftest.jsonl: oracle cases, each with an `expect` map of what the pipeline
 * must report (`latest`, `divergent`, `rejectedHead`, a legacy profile's transition; `~dark` for
 * the dark-scheme verdict). Writes <cache>/selftest/ (the oracle files of the run) and prints one
 * line per case and a total.
 *
 * Exit status: 0 when every case gets exactly the expected answers, 1 otherwise.
 */
import { join } from 'node:path';

import { readJsonl } from '../core/files.js';
import { print } from '../core/log.js';
import { cacheDir, SKILL_DIR } from '../core/paths.js';
import { pyEquals, pyGet } from '../core/py-value.js';
import { pyFormat, pyRepr, pyStr, pyTruthy } from '../core/py.js';
import { freshDirectory } from './oracle.js';
import { engineEnvironment, runOracle } from './pipeline.js';

/** @import { CaseVerdict, OracleCase } from '../types.js' */
/** @import { OracleResult } from './pipeline.js' */

/** Width of the case-id column. */
const ID_WIDTH = 32;
const DARK_SUFFIX = '~dark';

/** @typedef {string | boolean | null} Answer What a known-answer case expects for one key. */

/**
 * Run the self-test cases and print the results.
 *
 * @param {{ profiles?: string | null }} [options]
 * @returns {Promise<number>} The exit status.
 */
export async function selftest({ profiles = null } = {}) {
  const environment = engineEnvironment(profiles);
  const cases = /** @type {(OracleCase & { expect?: Record<string, Answer> })[]} */ (
    readJsonl(join(SKILL_DIR, 'oracle', 'test', 'selftest.jsonl'))
  );
  /** @type {Map<string, Record<string, Answer>>} */
  const expected = new Map();

  for (const entry of cases) {
    expected.set(entry.id, /** @type {Record<string, Answer>} */ (entry.expect));
    delete entry.expect;
  }

  const out = freshDirectory(join(cacheDir(), 'selftest'));
  const result = await runOracle(out, cases, environment);
  const { lines, failures } = selftestReport(expected, result);

  for (const line of lines) {
    print(line);
  }

  return failures ? 1 : 0;
}

/**
 * The self-test's output lines (one per case, then the total) and how many cases failed.
 *
 * @param {Map<string, Record<string, Answer>>} expected Case id -> its `expect` map, in file order.
 * @param {Pick<OracleResult, 'verdicts' | 'profiles'>} result What the pipeline reported.
 * @returns {{ lines: string[], failures: number }}
 */
export function selftestReport(expected, result) {
  const lines = [];
  let failures = 0;

  for (const [id, expect] of expected) {
    const got = answers(pyGet(result.verdicts, id, []));
    const wrong = Object.entries(expect).filter(([key, want]) => !pyEquals(got.get(key) ?? null, want));
    const shown = Object.keys(expect)
      .map((key) => `${key}=${pyStr(got.get(key) ?? null)}`)
      .join(', ');
    const status = wrong.length > 0 ? 'FAIL' : 'ok  ';
    const detail = wrong.length > 0 ? `   expected ${mismatchRepr(wrong, got)}` : '';

    failures += wrong.length > 0 ? 1 : 0;
    lines.push(`${status} ${pyFormat(id, String(ID_WIDTH))} ${shown}${detail}`);
  }

  const ran = Object.keys(result.profiles).join(', ');

  lines.push(`${expected.size - failures}/${expected.size} self-test cases pass (${ran})`);

  return { lines, failures };
}

/**
 * What the pipeline reported for a case, keyed like the `expect` maps.
 *
 * @param {readonly CaseVerdict[]} verdicts
 * @returns {Map<string, Answer>}
 */
function answers(verdicts) {
  /** @type {Map<string, Answer>} */
  const got = new Map();

  for (const verdict of verdicts) {
    const suffix = pyGet(verdict, 'scheme', null) === 'dark' ? DARK_SUFFIX : '';
    const latest = verdict.summary.latest;

    got.set(`latest${suffix}`, latest.transition);
    got.set(`divergent${suffix}`, pyTruthy(pyGet(latest, 'divergent', null)));
    got.set(`rejectedHead${suffix}`, latest.rejectedHead > latest.rejectedBase);

    for (const [profile, summary] of Object.entries(pyGet(verdict.summary, 'legacy', {}))) {
      got.set(`${profile}${suffix}`, summary.transition);
    }
  }

  return got;
}

/**
 * The mismatches as a Python dict of (expected, got) tuples, the format the selftest has always
 * printed:
 * `{'latest': ('fixed', 'regressed')}`.
 *
 * @param {[string, unknown][]} wrong
 * @param {Map<string, Answer>} got
 * @returns {string}
 */
function mismatchRepr(wrong, got) {
  const items = wrong.map(
    ([key, want]) => `${pyRepr(key)}: (${pyRepr(want)}, ${pyRepr(got.get(key) ?? null)})`,
  );

  return `{${items.join(', ')}}`;
}
