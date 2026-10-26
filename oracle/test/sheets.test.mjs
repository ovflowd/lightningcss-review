import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { rewriteStates, undefinedCustomProperties } from '../lib/sheets.mjs';

describe('rewriteStates', () => {
  test('touches selectors only, never media features', () => {
    assert.equal(
      rewriteStates('@media (hover:hover){.x:hover{color:red}}').css,
      '@media (hover:hover){.x[data-lcr-hover]{color:red}}',
    );
  });

  test('rewrites inside nested rules and counts every occurrence', () => {
    assert.deepEqual(rewriteStates('.p{.c:hover{color:red}}'), {
      css: '.p{.c[data-lcr-hover]{color:red}}',
      rewrites: 1,
    });
    assert.deepEqual(rewriteStates('a:FOCUS,b:visited{}'), {
      css: 'a[data-lcr-focus],b[data-lcr-visited]{}',
      rewrites: 2,
    });
  });

  test('functional pseudo-classes and other pseudo-classes stay', () => {
    assert.deepEqual(rewriteStates('.a:not(.b):first-child{}'), {
      css: '.a:not(.b):first-child{}',
      rewrites: 0,
    });
    // A state name used as a function is not the user-action pseudo-class.
    assert.deepEqual(rewriteStates('.a:hover(x){}'), { css: '.a:hover(x){}', rewrites: 0 });
    assert.deepEqual(rewriteStates('.a:is(:hover){}'), { css: '.a:is([data-lcr-hover]){}', rewrites: 1 });
  });

  test('the rest of the text is untouched, byte for byte', () => {
    const css = '/* c */ .a:hover  >  .b { color : red }\n';

    assert.equal(rewriteStates(css).css, '/* c */ .a[data-lcr-hover]  >  .b { color : red }\n');
  });
});

describe('undefinedCustomProperties', () => {
  test('custom properties referenced but never defined get a stand-in typed by their consumer', () => {
    assert.deepEqual(undefinedCustomProperties('.a{margin:var(--x);color:var(--c);padding:var(--y, 1px)}'), [
      ['--c', 'rgb(1, 2, 3)'],
      ['--x', '5px'],
    ]);
  });

  test('definitions anywhere in the sheet, and @property, count as defined', () => {
    assert.deepEqual(undefinedCustomProperties(':root{--x:1px}.a{margin:var(--x)}'), []);
    assert.deepEqual(undefinedCustomProperties('@property --p{syntax:"*"}.a{margin:var(--p)}'), []);
  });

  test('the first consumer decides the stand-in type', () => {
    assert.deepEqual(undefinedCustomProperties('.a{border-color:var(--z)}.b{width:var(--z)}'), [
      ['--z', 'rgb(1, 2, 3)'],
    ]);
  });

  test('a fallback-less use after a fallback use still needs a definition', () => {
    assert.deepEqual(undefinedCustomProperties('.a{width:var(--z, 1px)}.b{height:var(--z)}'), [
      ['--z', '5px'],
    ]);
  });

  test('non-ASCII names are custom properties too', () => {
    const name = `--${String.fromCharCode(0xe9)}t${String.fromCharCode(0xe9)}`;

    assert.deepEqual(undefinedCustomProperties(`.a{width:var(${name})}`), [[name, '5px']]);
  });
});
