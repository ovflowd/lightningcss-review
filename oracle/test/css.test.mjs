import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { canonicalText, isKeyframes, parseSheet } from '../lib/css.mjs';

describe('parseSheet', () => {
  test('parses nested rules without a leading & as rules, not declarations', () => {
    const ast = /** @type {import('css-tree').CssNode} */ (parseSheet('.p{.c{color:red} margin:1px}'));
    const rule = ast.children?.first;
    const kinds = rule?.block?.children?.toArray().map((node) => node.type);

    assert.deepEqual(kinds, ['Rule', 'Declaration']);
  });

  test('custom property values containing braces stay declarations', () => {
    const ast = /** @type {import('css-tree').CssNode} */ (parseSheet('.p{--x:{a:b};color:red}'));
    const kinds = ast.children?.first?.block?.children?.toArray().map((node) => node.type);

    assert.deepEqual(kinds, ['Declaration', 'Declaration']);
  });

  test('records source offsets', () => {
    const ast = /** @type {import('css-tree').CssNode} */ (parseSheet('.a{color:red}'));

    assert.deepEqual([ast.children?.first?.loc?.start.offset, ast.children?.first?.loc?.end.offset], [0, 13]);
  });
});

describe('canonicalText', () => {
  test('equal for sheets differing in whitespace, comments and final semicolons only', () => {
    const css = '.t { display: inline-flex; display: -ms-inline-flexbox; }\n';

    assert.equal(
      canonicalText(css),
      canonicalText('/* x */.t{display:inline-flex;display:-ms-inline-flexbox}'),
    );
    assert.notEqual(canonicalText(css), canonicalText('.t{display:-ms-inline-flexbox;display:inline-flex}'));
  });

  test('null for anything but a string', () => {
    assert.equal(canonicalText(null), null);
    assert.equal(canonicalText(undefined), null);
  });
});

describe('isKeyframes', () => {
  test('matches @keyframes and prefixed forms', () => {
    const at = (/** @type {string} */ css) =>
      /** @type {import('css-tree').CssNode} */ (parseSheet(css)).children?.first;

    assert.equal(isKeyframes(/** @type {any} */ (at('@keyframes k{}'))), true);
    assert.equal(isKeyframes(/** @type {any} */ (at('@-webkit-keyframes k{}'))), true);
    assert.equal(isKeyframes(/** @type {any} */ (at('@media print{}'))), false);
  });
});
