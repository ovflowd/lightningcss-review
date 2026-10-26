import assert from 'node:assert/strict';
import { test } from 'node:test';

import { asPythonJson, buildGolden } from '../../../test/fixtures/build/golden.js';
import { addedLinesByFile, changedLines, parseHunks } from '../diff.js';

test('hunks give changed ranges and added/removed counts', () => {
  const patch =
    'diff --git a/src/x.rs b/src/x.rs\n--- a/src/x.rs\n+++ b/src/x.rs\n@@ -3,2 +3,3 @@ impl Foo {\n   fn a() {\n-    1\n+    2\n+    3\n';
  const hunks = /** @type {import('../diff.js').FileHunks} */ (parseHunks(patch).get('src/x.rs'));

  assert.deepEqual(hunks.head, [[3, 5]]);
  assert.deepEqual([hunks.added, hunks.removed], [2, 1]);
});

test('changed lines skip context lines and header lines that look like content', () => {
  const patch =
    'diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -10,4 +10,5 @@\n ctx\n--- removed dashes\n+added\n+added2\n ctx\n ctx\n';

  assert.deepEqual(changedLines(patch).get('src/lib.rs'), {
    head: [[11, 12]],
    base: [[11, 11]],
  });
});

test('patch parsing equals py-final (new/deleted files, zero counts, form feeds, U+2028)', () => {
  const golden = buildGolden().patch;

  assert.equal(asPythonJson(parseHunks(golden.text)), asPythonJson(golden.hunks));
  assert.equal(asPythonJson(changedLines(golden.text)), asPythonJson(golden.changed));
  assert.equal(asPythonJson(addedLinesByFile(golden.text)), asPythonJson(golden.added));
  assert.equal(asPythonJson(addedLinesByFile(golden.text, { sign: '-' })), asPythonJson(golden.removed));
});
