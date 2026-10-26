import assert from 'node:assert/strict';
import { test } from 'node:test';

import { asPythonJson, buildGolden } from '../../../test/fixtures/build/golden.js';
import { compatVariants, enclosingItems, testFnsInRanges } from '../rust-items.js';

test('the enclosing fn and impl of a changed range', () => {
  const text = 'struct Foo;\nimpl Handler for Foo {\n  fn a() {\n    2\n    3\n  }\n}\n';
  const [entry] = enclosingItems(text, [[4, 5]]);

  assert.equal(entry.item?.name, 'a');
  assert.equal(entry.impl?.type, 'Foo');
  assert.equal(entry.impl?.trait, 'Handler');
});

test('test functions whose bodies changed', () => {
  const text = ['  #[test]', '  fn test_a() {', '  }', '  #[test]', '  fn test_b() {', '    x', '  }'].join(
    '\n',
  );

  assert.deepEqual(testFnsInRanges(text, [[6, 6]]), ['test_b']);
});

const LIB = [
  '  #[test]',
  '  pub fn test_flex() {',
  '    a',
  '  }',
  '',
  '  fn helper() {',
  '    h',
  '  }',
  '',
  '  #[cfg(feature = "x")]',
  '  #[test]',
  '  pub(crate) fn test_margin() {',
  '    b',
  '  }',
].join('\n');

test('pub test fns count, helpers between tests belong to none, attributes start a span', () => {
  assert.deepEqual(testFnsInRanges(LIB, [[3, 3]]), ['test_flex']);
  assert.deepEqual(testFnsInRanges(LIB, [[5, 7]]), []);
  assert.deepEqual(testFnsInRanges(LIB, [[10, 10]]), ['test_margin']);
  assert.deepEqual(testFnsInRanges(LIB, [[13, 13]]), ['test_margin']);
});

test('compat variants: enum entries, match arms and multi-line arms', () => {
  const text = [
    'pub enum Feature {',
    '  AnyLink,',
    '  NewThing,',
    '}',
    'impl Feature {',
    '  pub fn is_compatible(&self, browsers: Browsers) -> bool {',
    '    match self {',
    '      Feature::AnyLink => {',
    '        if version < 5 {',
    '          return false;',
    '      }',
    '      Feature::A',
    '      | Feature::B => {',
    '        return false',
    '      }',
  ].join('\n');

  assert.deepEqual(compatVariants(text, [[3, 3]]), ['NewThing']);
  assert.deepEqual(compatVariants(text, [[9, 9]]), ['AnyLink']);
  assert.deepEqual(compatVariants(text, [[14, 14]]), ['A', 'B']);
});

test('the heuristics match the golden items on Unicode names, nested impls and long ranges', () => {
  const golden = buildGolden();

  for (const [text, ranges, expected] of golden.enclosing_items) {
    assert.equal(asPythonJson(enclosingItems(text, ranges)), asPythonJson(expected), JSON.stringify(ranges));
  }

  for (const [text, ranges, expected] of golden.compat_variants) {
    assert.deepEqual(compatVariants(text, ranges), expected, JSON.stringify(ranges));
  }

  for (const [text, ranges, expected] of golden.test_fns) {
    assert.deepEqual(testFnsInRanges(text, ranges), expected, JSON.stringify(ranges));
  }
});
