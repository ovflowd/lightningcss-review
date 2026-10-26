import assert from 'node:assert/strict';
import { test } from 'node:test';

import { asPythonJson, buildGolden } from '../../../test/fixtures/build/golden.js';
import { riskFlags } from '../risk.js';

test('risk flags match the golden flags, in order, with sorted paths', () => {
  for (const [files, hunks, expected] of buildGolden().risk_flags) {
    const flags = riskFlags(new Map(Object.entries(files)), new Map(Object.entries(hunks)));

    assert.equal(asPythonJson(flags), asPythonJson(expected));
  }
});

test('source changes without test changes are flagged; with src/lib.rs they are not', () => {
  const ids = (/** @type {Record<string, object>} */ files) =>
    riskFlags(new Map(Object.entries(files)), new Map()).map((flag) => flag.id);

  assert.deepEqual(ids({ 'src/values/angle.rs': {} }), ['no-tests']);
  assert.deepEqual(ids({ 'src/values/angle.rs': {}, 'src/lib.rs': {} }), []);
  assert.deepEqual(ids({ 'src/values/color.rs': {}, 'src/lib.rs': {} }), ['core-file']);
});
