import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildGolden } from '../../../test/fixtures/build/golden.js';
import { driftSignature, newDrift } from '../js-lane.js';

test('the same drift on both sides is not new, even when lines moved', () => {
  const encode = (/** @type {string} */ text) => Buffer.from(text);
  const signature = driftSignature(encode('a\nb\nc\n'), encode('a\nB\nc\n'));
  const moved = driftSignature(encode('x\na\nb\nc\n'), encode('x\na\nB\nc\n'));

  assert.equal(signature, moved);
  assert.deepEqual(
    newDrift(
      { 'node/ast.d.ts': signature, 'src/compat.rs': 'h' },
      { 'node/ast.d.ts': moved, 'node/flags.js': 'x' },
    ),
    ['src/compat.rs'],
  );
});

test('drift signatures are stable on invalid UTF-8, BOM, CRLF and `---` content lines', () => {
  for (const [before, after, expected] of buildGolden().drift_signature) {
    assert.equal(driftSignature(Buffer.from(before), Buffer.from(after)), expected);
  }

  for (const [head, base, expected] of buildGolden().new_drift) {
    assert.deepEqual(newDrift(head, base), expected);
  }
});
