/**
 * Case and verdict helpers (py-final tests/test_report.py HelpersTest case_id, plus matching,
 * case references and engine judgment).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { verdict } from '../../../test/helpers/synthetic-run.js';
import {
  caseArea,
  caseId,
  caseRefs,
  engineStatuses,
  inTargets,
  judged,
  light,
  matches,
  sideEquivalent,
} from '../cases.js';

/** @import { VerdictRecord } from '../cases.js' */

describe('case helpers', () => {
  test('caseId strips annotations', () => {
    assert.equal(caseId('p-a/b~dark@legacy-2021 [head equivalent in x]'), 'p-a/b');
  });

  test('matches takes exact ids, fnmatch globs and source patterns', () => {
    assert.ok(matches('p-a/b', 'p-a/b', 'probe'));
    assert.ok(matches('p-a/*', 'p-a/b/c', 'probe'));
    assert.ok(matches('m-p-?/x', 'm-p-a/x', 'mutation'));
    assert.ok(matches('source:wpt', 'w-1', 'wpt'));
    assert.ok(!matches('source:wpt', 'source:wpt', 'probe'));
    assert.ok(!matches('', 'p-a', 'probe'));
    assert.ok(!matches(null, 'p-a', 'probe'));
    assert.ok(!matches('p-a', 'p-ab', 'probe'));
  });

  test('caseRefs finds ids, annotated tags and bare probe ids in order', () => {
    const known = new Set(['p-color/x', 't-1', 'm-p-color/x-wrap']);

    assert.deepEqual(caseRefs('see color/x, (t-1~dark) and `m-p-color/x-wrap`. t-1 again', known), [
      'p-color/x',
      't-1',
      'm-p-color/x-wrap',
    ]);
    assert.deepEqual(caseRefs(null, known), []);
  });

  test('caseArea follows the source', () => {
    const tests = new Map([['test_color', ['color', 'tests']]]);
    const properties = new Map([['user-select', 'ui-misc']]);

    assert.deepEqual(caseArea({ id: 'm', source: 'mutation', area: null }, tests, properties), ['tests']);
    assert.deepEqual(caseArea({ id: 't', source: 'tuple', test: 'tests::test_color' }, tests, properties), [
      'color',
      'tests',
    ]);
    assert.deepEqual(caseArea({ id: 't', source: 'tuple', test: 'tests::other' }, tests, properties), [
      'tests',
    ]);
    assert.deepEqual(
      caseArea(
        { id: 'w', source: 'wpt', wpt: { property: '-moz-user-select', file: '', value: '', kind: '' } },
        tests,
        properties,
      ),
      ['ui-misc'],
    );
    assert.deepEqual(
      caseArea(
        { id: 'w', source: 'wpt', wpt: { property: 'nope', file: '', value: '', kind: '' } },
        tests,
        properties,
      ),
      ['unknown'],
    );
    assert.deepEqual(caseArea({ id: 'r', source: 'realworld' }, tests, properties), ['realworld']);
  });

  test('engines judge only inside the targets and when not inert or errored', () => {
    const [entry] = /** @type {VerdictRecord[]} */ (
      verdict('p-x', {
        perEngine: { chromium: ['equivalent', 'different'], firefox: ['different', 'different'] },
        summary: { inert: ['webkit'] },
      })
    );

    assert.deepEqual([...engineStatuses(entry).keys()], ['chromium', 'firefox']);
    assert.ok(inTargets('chromium', { android: 1 }));
    assert.ok(!inTargets('webkit', { chrome: 1 }));
    assert.ok(inTargets('webkit', null));
    assert.deepEqual(
      [...judged(entry, { id: 'p-x', request: { targets: { chrome: 1 } } }).keys()],
      ['chromium'],
    );
    assert.equal(sideEquivalent(entry, { id: 'p-x', request: { targets: { chrome: 1 } } }, 'base'), true);
    assert.equal(sideEquivalent(entry, {}, 'head'), false);
    assert.equal(sideEquivalent(entry, { id: 'p-x', request: { targets: { safari: 1 } } }, 'head'), null);
  });

  test('engine statuses fall back to the engine entries of older verdicts', () => {
    const [raw] = verdict('p-x', { perEngine: { webkit: ['equivalent', 'different'] } });

    delete raw.summary.latest.engines;
    raw.latest.firefox.touched = 0;
    raw.latest.chromium.error = 'crashed';

    const entry = /** @type {VerdictRecord} */ (raw);

    assert.deepEqual(Object.fromEntries(engineStatuses(entry)), {
      webkit: { base: 'equivalent', head: 'different' },
    });
  });

  test('light picks the light-scheme verdict, else the first one', () => {
    const [lightVerdict] = /** @type {VerdictRecord[]} */ (verdict('p-a'));
    const dark = { ...lightVerdict, scheme: /** @type {const} */ ('dark') };

    assert.equal(light([dark, lightVerdict]), lightVerdict);
    assert.equal(light([dark]), dark);
    assert.equal(light([]), null);
    assert.equal(light(undefined), null);
  });
});
