import assert from 'node:assert/strict';
import { test } from 'node:test';

import { asPythonJson, buildGolden } from '../../../test/fixtures/build/golden.js';
import { changeAreas, classifyFiles, testAreaMap } from '../areas.js';

test('change areas: TokenList lines in library code also reach custom-properties', () => {
  const files = new Map([
    ['src/rules/function.rs', { added_lines: ['let t: TokenList = x;'], removed_lines: [] }],
    ['src/rules/style.rs', { added_lines: ['x'], removed_lines: [] }],
    ['src/lib.rs', { added_lines: ['TokenList'], removed_lines: [] }],
  ]);
  const areas = changeAreas(files);

  assert.deepEqual(areas.get('src/rules/function.rs'), ['at-rules-other', 'custom-properties']);
  assert.deepEqual(areas.get('src/rules/style.rs'), ['rule-merging', 'nesting', 'selectors']);
  assert.deepEqual(areas.get('src/lib.rs'), ['tests']);
});

test('change areas equal py-final', () => {
  const [files, expected] = buildGolden().change_areas;

  assert.equal(asPythonJson(changeAreas(new Map(Object.entries(files)))), asPythonJson(expected));
});

test('the first matching rule wins; `*` crosses directories', () => {
  const areas = classifyFiles(['src/lib.rs', 'nowhere/at/all.txt']);

  assert.deepEqual(areas.get('src/lib.rs'), ['tests']);
  assert.deepEqual(areas.get('nowhere/at/all.txt'), ['other']);
});

test('testAreaMap merges config/areas.json tests with config/testmap.json', () => {
  const map = testAreaMap();

  assert.ok(map.size > 0);

  for (const areas of map.values()) {
    assert.equal(new Set(areas).size, areas.length);
  }
});
