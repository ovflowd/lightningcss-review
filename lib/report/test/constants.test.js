/**
 * The evidence patterns (py-final tests/test_report.py ClassificationTest.test_issue_ref_*).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ISSUE_REF, SPEC_CITE } from '../constants.js';

describe('evidence patterns', () => {
  test('an issue reference needs a tag or a URL', () => {
    for (const text of [
      'open-issue#710',
      'known: fixed-by#1283',
      'fixed-by#0a1b2c3',
      'see https://github.com/parcel-bundler/lightningcss/issues/710',
      'github.com/parcel-bundler/lightningcss/pull/12',
    ]) {
      assert.ok(ISSUE_REF.test(text), text);
    }

    for (const text of [
      '#710',
      'base too, #710',
      'issue #7',
      'open-issue#',
      'reopen-issue#7',
      'fixed-by#xyz',
      'lib.rs#L12',
      'https://github.com/other/repo/issues/7',
    ]) {
      assert.ok(!ISSUE_REF.test(text), text);
    }
  });

  test('a spec citation is a spec or WPT URL with a path', () => {
    assert.ok(SPEC_CITE.test('see https://drafts.csswg.org/css-color-4/#x'));
    assert.ok(SPEC_CITE.test('http://wpt.fyi/results/css'));
    assert.ok(!SPEC_CITE.test('https://drafts.csswg.org/'));
    assert.ok(!SPEC_CITE.test('https://example.com/css-color-4/#x'));
  });
});
