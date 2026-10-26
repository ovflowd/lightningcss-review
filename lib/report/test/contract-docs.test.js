/**
 * The analysis.json contract as the agent-facing docs describe it: every transition,
 * classification and key the report evaluates is documented, and the docs state the verdict rules
 * the report implements.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { REPO_ROOT } from '../../../test/helpers/index.js';
import { pySplit } from '../../core/py.js';
import { CLASSIFICATIONS } from '../constants.js';
import { ARROW } from '../glyphs.js';

const TRANSITIONS = [
  'errored',
  'input-rejected',
  'introduced',
  'both-equivalent',
  'near-introduced',
  'fixed',
  'regressed',
  'worsened',
  'still-different',
  'unverified',
];

/**
 * @param {string} relative
 * @returns {string}
 */
function read(relative) {
  return readFileSync(join(REPO_ROOT, relative), 'utf8');
}

/**
 * The text with every run of whitespace collapsed to one space, so a phrase still matches when the
 * docs wrap it across lines.
 *
 * @param {string} relative
 * @returns {string}
 */
function flat(relative) {
  return pySplit(read(relative)).join(' ');
}

describe('contract docs', () => {
  test('the oracle reference documents every transition', () => {
    const text = read('references/oracle.md');

    for (const transition of TRANSITIONS) {
      assert.ok(text.includes(`\`${transition}\``), transition);
    }

    assert.ok(text.includes('engines: {engine: {base, head}}'));
  });

  test('SKILL.md names the transitions, classifications and keys', () => {
    const text = read('SKILL.md');

    for (const transition of ['errored', 'input-rejected', 'worsened', 'introduced']) {
      assert.ok(text.includes(`\`${transition}\``), transition);
    }

    for (const classification of CLASSIFICATIONS) {
      assert.ok(text.includes(`\`${classification}\``), classification);
    }

    for (const key of ['FAIL_PRE_EXISTING', 'effective_severity', 'finding: F<n>', 'repro: #N', '--rerun']) {
      assert.ok(text.includes(key), key);
    }
  });

  test('a decision needed is never described as a verdict floor', () => {
    for (const file of ['SKILL.md', 'docs/harness.md']) {
      assert.doesNotMatch(flat(file), /caps? the verdict/i, file);
    }

    assert.ok(
      flat('SKILL.md').includes('Never UNSAFE: MAJOR if the oracle shows head worse than base, else a NOTE'),
    );
  });

  test('O9 judges engines against the spec', () => {
    const skill = flat('SKILL.md');

    assert.ok(skill.includes('an engine that lags the spec'));
    assert.ok(skill.includes('REGRESSION needs base to match the spec in an engine where head does not'));
    assert.ok(!skill.includes('base matched in every engine'));
    assert.ok(skill.includes(`base wrong wherever head is ${ARROW} PRE_EXISTING`));
    assert.ok(skill.includes('`references/spec/<cluster>.md`'));
  });

  test('the thread step reads issue comments and searches related issues', () => {
    const skill = flat('SKILL.md');

    assert.ok(skill.includes('maintainer comments on each linked issue, closed too'));
    assert.ok(skill.includes('`gh search issues`'));
    assert.ok(skill.includes('standing maintainer policy'));
  });

  test('the probe format documents the newer keys', () => {
    const text = read('references/probe-format.md');

    for (const key of ['`repro`', '`timeout`', '`open-bug`']) {
      assert.ok(text.includes(key), key);
    }

    assert.ok(!text.includes('i.e. `lower` with\n`targets: none`'));
  });

  test('the probe template lists the known values and repro', () => {
    const text = read('templates/probe.css.tmpl');

    assert.ok(text.includes('open-bug'));
    assert.match(text, /^repro: /m);
  });
});
