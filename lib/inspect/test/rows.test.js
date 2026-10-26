/**
 * The inspect helpers: JSONL lookups, engine abbreviations and the Python dict idioms (no
 * py-final counterpart; these pin the edge cases the views rely on).
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { tempDir, writeFiles } from '../../../test/helpers/index.js';
import { abbreviateEngines, findRows } from '../rows.js';

/** A non-ASCII id (written unescaped by the serializer, as the prefilter expects). */
const ACCENTED = `p-${String.fromCodePoint(0xe9)}/1`;

describe('findRows', () => {
  test('matches the value exactly, not as a substring or in another key', () => {
    using dir = tempDir();
    const path = join(dir.path, 'rows.jsonl');

    writeFiles(dir.path, {
      'rows.jsonl': [
        { id: 't-1', note: 'x' },
        { id: 't-10' },
        { id: 'z', note: '"id": "t-1"' },
        { id: ACCENTED },
      ],
    });
    assert.deepEqual(findRows(path, 'id', 't-1'), [{ id: 't-1', note: 'x' }]);
    assert.deepEqual(findRows(path, 'id', ACCENTED), [{ id: ACCENTED }]);
    assert.deepEqual(findRows(join(dir.path, 'missing.jsonl'), 'id', 't-1'), []);
  });
});

describe('helpers', () => {
  test('engine abbreviations', () => {
    assert.equal(abbreviateEngines(['chromium', 'webkit']), 'CW');
    assert.equal(abbreviateEngines(['servo']), 'servo');
    assert.equal(abbreviateEngines([]), '-');
  });
});
