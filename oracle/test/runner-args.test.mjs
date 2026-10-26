import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { hasFlag, option, parseRunnerArgs } from '../runner/args.cjs';

describe('runner args', () => {
  test('options take the next argument; a trailing option falls back', () => {
    assert.equal(option(['--jobs', 'j.jsonl'], '--jobs'), 'j.jsonl');
    assert.equal(option(['--jobs'], '--jobs', 'x'), 'x');
    assert.equal(option([], '--jobs', null), null);
    assert.equal(hasFlag(['--a', '--versions'], '--versions'), true);
  });

  test('parseRunnerArgs: defaults, engine list, unknown options ignored', () => {
    assert.deepEqual(parseRunnerArgs(['--jobs', 'j', '--out', 'o', '--profile', 'latest']), {
      versions: false,
      jobs: 'j',
      out: 'o',
      screenshots: null,
      engines: ['chromium', 'firefox', 'webkit'],
    });
    assert.deepEqual(parseRunnerArgs(['--versions', '--engines', 'webkit,,firefox', '--screenshots', '/s']), {
      versions: true,
      jobs: null,
      out: null,
      screenshots: '/s',
      engines: ['webkit', 'firefox'],
    });
  });
});
