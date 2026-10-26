import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pythonGolden } from '../../../test/helpers/index.js';
import { SequenceMatcher, unifiedDiff } from '../difflib.js';

test('unifiedDiff equals difflib.unified_diff on the golden inputs, autojunk included', () => {
  for (const { a, b, n, diff } of pythonGolden().unified_diff) {
    assert.deepEqual(unifiedDiff(a, b, { fromfile: 'base', tofile: 'head', context: n, lineterm: '' }), diff);
  }
});

test('opcodes describe how to turn a into b', () => {
  const matcher = new SequenceMatcher(['a', 'b', 'c'], ['a', 'x', 'c', 'd']);

  assert.deepEqual(matcher.getOpcodes(), [
    ['equal', 0, 1, 0, 1],
    ['replace', 1, 2, 1, 2],
    ['equal', 2, 3, 2, 3],
    ['insert', 3, 3, 3, 4],
  ]);
});
