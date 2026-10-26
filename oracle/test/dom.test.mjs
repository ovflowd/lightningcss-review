import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { collectPseudos, synthesize } from '../lib/dom.mjs';

describe('synthesize', () => {
  test('resolves nesting, combinators and :root', () => {
    const dom = synthesize([
      ':root.dark .card > .title + .sub { color: red } .a { & .b:hover { color: blue } }',
    ]);

    assert.equal(dom.rootAttrs.class, 'dark');
    assert.match(dom.html, /<div class="card"><div class="title"><\/div><div class="sub">x<\/div><\/div>/);
    assert.match(dom.html, /<div class="a"><div class="b" data-lcr-hover="">x<\/div><\/div>/);
    assert.equal(dom.generic, false);
  });

  test('pseudo-elements: prefixed aliases, one-colon CSS 2 forms and nested rules are read', () => {
    assert.deepEqual(synthesize(['.a::-moz-placeholder{color:red}']).pseudos, ['::placeholder']);
    assert.deepEqual(
      synthesize(['.a::-webkit-input-placeholder{color:red}.b::-moz-selection{color:red}']).pseudos,
      ['::placeholder', '::selection'],
    );
    assert.deepEqual(synthesize(['.a:before{color:red}.b:first-line{color:red}']).pseudos, [
      '::before',
      '::first-line',
    ]);
    assert.match(synthesize(['.a:after{color:red}']).html, /<div class="a">x<\/div>/);
    assert.deepEqual(synthesize(['.lcr-n{.a::before{color:red}}']).pseudos, ['::before']);
    assert.match(synthesize(['[a="b" s]:after{color:red}']).html, /<div a="b">x<\/div>/);
  });

  test('nested rules css-tree leaves as raw text are re-parsed in place', () => {
    const dom = synthesize(['.lcr-n{.a .b{color:red} div::after{color:red} color:blue}']);

    assert.match(dom.html, /<div class="lcr-n"><div class="a"><div class="b">x<\/div><\/div><\/div>/);
    assert.deepEqual(dom.pseudos, ['::after']);
  });

  test('keyframe selectors are not synthesized: the generic DOM is used', () => {
    const dom = synthesize(['@keyframes k{0%{color:red}from{color:blue}}']);

    assert.equal(dom.generic, true);
    assert.match(dom.html, /^<div class="lcr-generic">/);
    assert.equal(dom.synthesized, 0);
  });

  test(':dir(rtl) and RTL :lang() synthesize elements that match both forms', () => {
    const { html } = synthesize([
      ':dir(rtl){color:red}',
      ':lang(ae, ar, he){color:red}',
      ':lang(en){color:red}',
    ]);

    assert.match(html, /<div dir="rtl" lang="ar">x<\/div>/);
    assert.match(html, /<div lang="ae" dir="rtl">x<\/div>/);
    assert.match(html, /<div lang="en">x<\/div>/);
  });

  test('elements the HTML parser only keeps in a parent get one', () => {
    assert.match(synthesize(['li.x{color:red}']).html, /<ul><li class="x">x<\/li><\/ul>/);
    assert.match(synthesize(['td{color:red}']).html, /<table><tbody><tr><td>x<\/td><\/tr><\/tbody><\/table>/);
    assert.match(synthesize(['option{color:red}']).html, /<select><option>x<\/option><\/select>/);
    assert.match(synthesize(['input.x{color:red}']).html, /<input class="x">/);
  });

  test(':nth-child() adds spacers before the element, :nth-last-child() after it', () => {
    assert.match(
      synthesize(['.a:nth-child(3){color:red}']).html,
      /<span><\/span><span><\/span><div class="a">x<\/div>/,
    );
    assert.match(synthesize(['p:nth-of-type(2n){color:red}']).html, /<p><\/p><p>x<\/p>/);
    assert.match(
      synthesize(['.a:nth-last-child(2){color:red}']).html,
      /<div class="a">x<\/div><span><\/span>/,
    );
  });

  test('sibling combinators from the top element wrap both in a container', () => {
    assert.match(
      synthesize(['.a ~ .b{color:red}']).html,
      /<div class="lcr-case"><div><div class="a"><\/div><div class="b">x<\/div><\/div><\/div>/,
    );
  });

  test(':has() adds one matching child or sibling per selector of its list', () => {
    const { html } = synthesize(['.a:has(> .b, + .c){color:red}']);

    assert.match(html, /<div class="a"><div class="b"><\/div>x<\/div><div class="c"><\/div>/);
    assert.match(
      synthesize(['.a:has(~ .c){color:red}']).html,
      /<div class="a">x<\/div><div class="c"><\/div>/,
    );
  });

  test(':empty elements get no text', () => {
    assert.match(synthesize(['.a:empty{color:red}']).html, /<div class="a"><\/div>/);
  });

  test('a selector repeated in the sheets is synthesized once', () => {
    const dom = synthesize(['.a{color:red}', '.a{color:blue}']);

    assert.deepEqual([dom.selectors, dom.synthesized], [2, 1]);
    assert.equal(dom.html, '<div class="lcr-case"><div class="a">x</div></div>');
  });

  test('body steps are skipped and counted unsupported; html/:root attributes go on the root', () => {
    const dom = synthesize(['html[lang=fr] body .a{color:red}']);

    assert.deepEqual(dom.rootAttrs, { lang: 'fr' });
    assert.match(dom.html, /<div class="lcr-case"><div class="a">x<\/div><\/div>/);
    assert.equal(dom.unsupported, 1);
  });

  test('duplicate selectors count but synthesize once; the cap bounds the fragments', () => {
    const dom = synthesize(['.a{color:red}.a{color:blue}.b{color:red}'], { maxSelectors: 1 });

    assert.equal(dom.selectors, 3);
    assert.equal(dom.synthesized, 1);
  });

  test('unparseable sheets are skipped', () => {
    assert.equal(synthesize([]).generic, true);
  });
});

describe('collectPseudos', () => {
  test('collects readable pseudo-elements of every sheet, sorted', () => {
    assert.deepEqual(collectPseudos(['.a::after{}', '.b::before{} .c::-webkit-scrollbar{}']), [
      '::after',
      '::before',
    ]);
  });
});
