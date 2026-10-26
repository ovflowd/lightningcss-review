/**
 * Verdict bookkeeping: matching verdicts to case ids and merging them, errored cases failing the
 * stage, transition counts, screenshot failures and the log lines.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { captureOutput } from '../../../test/helpers/index.js';
import { LcrError } from '../../core/errors.js';
import {
  checkErrors,
  erroredCases,
  logProblems,
  logTransitions,
  matchIds,
  mergeVerdicts,
  transitionCounts,
  visualErrors,
} from '../verdicts.js';

/**
 * @param {string} transition
 * @param {object} [extra] More `summary` fields.
 * @returns {any[]}
 */
const verdictsWith = (transition, extra = {}) => [{ summary: { latest: { transition }, ...extra } }];

describe('re-runs', () => {
  test('match ids and merge', () => {
    const ids = ['p-a/x', 'm-p-a/x-nest', 't-1'];

    assert.deepEqual(matchIds('m-p-a/x-*, t-1', ids), ['m-p-a/x-nest', 't-1']);

    const summary = /** @type {any} */ ({
      verdicts: { 't-1': ['old'], 't-2': ['keep'] },
      dom: { 't-1': 1 },
      profiles: { latest: {} },
      stats: { selected: 2 },
    });
    const merged = mergeVerdicts(
      summary,
      /** @type {any} */ ({
        verdicts: { 't-1': ['new'], 't-9': ['ignored'] },
        dom: { 't-1': 2 },
        profiles: { 'legacy-2023': {} },
      }),
      ['t-1'],
    );

    assert.deepEqual(merged.verdicts, { 't-1': ['new'], 't-2': ['keep'] });
    assert.deepEqual(merged.dom, { 't-1': 2 });
    assert.deepEqual(Object.keys(merged.profiles ?? {}).sort(), ['latest', 'legacy-2023']);
    assert.deepEqual(merged.stats, { selected: 2, reruns: ['t-1'] });
  });

  test('earlier re-runs are kept in stats.reruns', () => {
    const merged = mergeVerdicts(/** @type {any} */ ({ stats: { reruns: ['t-9'] } }), { verdicts: {} }, [
      't-1',
    ]);

    assert.deepEqual(merged.stats?.reruns, ['t-1', 't-9']);
    assert.deepEqual(merged.dom, {});
  });

  test('an empty pattern list matches nothing', () => {
    assert.deepEqual(matchIds(' , ', ['t-1']), []);
  });
});

describe('errors', () => {
  test('errored cases fail the stage on probes or above 5%', () => {
    /** @type {Record<string, any[]>} */
    const many = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`t-${index}`, verdictsWith('both-equivalent')]),
    );

    checkErrors({ ...many, 't-x': verdictsWith('errored') });
    assert.throws(() => checkErrors({ ...many, 'p-a/x': verdictsWith('errored') }), LcrError);
    assert.throws(() => checkErrors({ ...many, 'm-p-a/x-nest': verdictsWith('errored') }), {
      message: /\(1 probe case\(s\)\), e\.g\. m-p-a\/x-nest;/,
    });

    const wpt = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`w-${index}`, verdictsWith('errored')]),
    );

    assert.throws(() => checkErrors({ ...many, ...wpt }), {
      message:
        'oracle: 10/110 case(s) errored in an engine (0 probe case(s)), e.g. w-0, w-1, w-2, w-3, w-4; ' +
        'inspect with `lcr show`, then `lcr oracle <run> --rerun <ids>`',
    });
  });

  test('transition counts, errored cases and screenshot failures are sorted', async () => {
    const verdicts = {
      'b-1': verdictsWith('errored'),
      'a-1': verdictsWith('fixed', { legacy: { 'legacy-2023': { visualErrors: ['webkit'] } } }),
      'c-1': verdictsWith('both-equivalent'),
    };

    assert.deepEqual(Object.entries(transitionCounts(verdicts)), [
      ['both-equivalent', 1],
      ['errored', 1],
      ['fixed', 1],
    ]);
    assert.deepEqual(erroredCases(verdicts), ['b-1']);
    assert.deepEqual(visualErrors(verdicts), ['a-1']);

    const { stderr } = await captureOutput(() => {
      logTransitions('oracle:', verdicts);
      logProblems(verdicts);
    });

    assert.equal(
      stderr,
      [
        "[lcr] oracle: transitions {'both-equivalent': 1, 'errored': 1, 'fixed': 1}",
        '[lcr] oracle: 1 case(s) errored in an engine: b-1',
        '[lcr] oracle: 1 case(s) without a screenshot comparison (screenshot failed): a-1',
        '',
      ].join('\n'),
    );
  });

  test('long id lists end with an ellipsis', async () => {
    const verdicts = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [`t-${index}`, verdictsWith('errored')]),
    );
    const { stderr } = await captureOutput(() => logProblems(verdicts));

    assert.ok(stderr.endsWith(`t-6, t-7${String.fromCodePoint(0x2026)}\n`));
  });
});
