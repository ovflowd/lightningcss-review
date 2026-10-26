/**
 * `lcr selftest`'s report against the golden lines for a canned oracle result
 * (test/fixtures/driver/golden.json): status column, padded ids, Python reprs of the answers,
 * `True == 1`, dark-scheme and legacy keys, and the total line.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { driverGolden } from '../../../test/fixtures/driver/golden.js';
import { pySplitlines } from '../../core/py.js';
import { loads } from '../../core/pyjson.js';
import { selftestReport } from '../selftest.js';

describe('selftestReport', () => {
  test('prints the golden lines and counts the failures', () => {
    const { cases_jsonl: casesText, result, stdout, status } = driverGolden().selftest;
    const cases = pySplitlines(casesText).map(
      (line) => /** @type {{ id: string, expect: Record<string, any> }} */ (loads(line)),
    );
    const expected = new Map(cases.map((entry) => [entry.id, entry.expect]));
    const { lines, failures } = selftestReport(expected, result);

    assert.equal(`${lines.join('\n')}\n`, stdout);
    assert.equal(failures > 0 ? 1 : 0, status);
    assert.equal(failures, 2);
  });

  test('a case without verdicts fails on every expected key', () => {
    const { lines, failures } = selftestReport(new Map([['st-x', { latest: 'fixed' }]]), {
      verdicts: {},
      profiles: { latest: {} },
    });

    assert.equal(failures, 1);
    assert.deepEqual(lines, [
      `FAIL ${'st-x'.padEnd(32)} latest=None   expected {'latest': ('fixed', None)}`,
      '0/1 self-test cases pass (latest)',
    ]);
  });
});
