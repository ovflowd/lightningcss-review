import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pythonGolden } from '../../../test/helpers/index.js';
import { sha256, stableId } from '../ids.js';
import { loads } from '../pyjson.js';

test('stableId equals py-final stable_id on the golden parts', () => {
  for (const { parts, id } of pythonGolden().stable_id) {
    assert.equal(stableId(.../** @type {unknown[]} */ (loads(parts))), id, parts);
  }
});

test('sha256 hashes the UTF-8 bytes of a string', () => {
  assert.equal(sha256('é'), sha256(Buffer.from('é', 'utf8')));
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});
