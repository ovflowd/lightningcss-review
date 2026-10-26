// node --test oracle/test/  (inside the analysis image: node_modules resolve from /opt/lcr)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareValues, tokenize } from '../normalize.mjs';
import { synthesize, rewriteStates, validityProbe } from '../dom.mjs';

test('numbers and colors within tolerance are noise; real changes are different', () => {
  assert.equal(compareValues('width', '100.0004px', '100px').level, 'noise');
  assert.equal(compareValues('width', '100.5px', '100px').level, 'different');
  assert.equal(compareValues('width', '10px', '10em').level, 'different');
  assert.equal(compareValues('color', 'oklch(0.7 0.1 200)', 'oklch(0.700001 0.1 200)').level, 'noise');
  assert.equal(compareValues('color', 'rgb(255, 0, 0)', 'rgb(0, 0, 255)').level, 'different');
});

test('a `none` component replaced by a number is a semantic change', () => {
  assert.equal(compareValues('color', 'oklch(0.7 0.1 none)', 'oklch(0.7 0.1 0)').level, 'different');
});

test('legacy/modern switch is visible in gradients only', () => {
  assert.equal(compareValues('color', 'oklch(0.7 0.1 200)', 'rgb(52, 178, 188)').level, 'near');
  assert.equal(
    compareValues('background-image', 'linear-gradient(oklch(0.7 0.1 200), rgb(255, 0, 0))', 'linear-gradient(rgb(52, 178, 188), rgb(255, 0, 0))').level,
    'different',
  );
});

test('lowering mode gamut-maps the reference and tolerates 8-bit quantization', () => {
  assert.notEqual(compareValues('color', 'color(display-p3 1 0 0)', 'rgb(255, 0, 0)', 'lowering').level, 'different');
});

test('tokenizer recognizes functions, hex and named colors', () => {
  const kinds = tokenize('0px 0px 4px rgba(0, 0, 0, 0.5), inset 1px 2px #fff, red').map((t) => t.t);
  assert.deepEqual(kinds.filter((k) => k === 'color').length, 3);
});

test('DOM synthesis resolves nesting, combinators and :root', () => {
  const r = synthesize([':root.dark .card > .title + .sub { color: red } .a { & .b:hover { color: blue } }']);
  assert.equal(r.rootAttrs.class, 'dark');
  assert.match(r.html, /<div class="card"><div class="title"><\/div><div class="sub">x<\/div><\/div>/);
  assert.match(r.html, /<div class="a"><div class="b" data-lcr-hover="">x<\/div><\/div>/);
  assert.equal(r.generic, false);
});

test('state rewrite touches selectors only, never media features', () => {
  const r = rewriteStates('@media (hover:hover){.x:hover{color:red}}');
  assert.equal(r.css, '@media (hover:hover){.x[data-lcr-hover]{color:red}}');
});

test('validity probes use the exact source text', () => {
  const p = validityProbe('.a{margin:1px  2px!important}');
  assert.deepEqual(p.decls, [['margin', '1px  2px', true]]);
});
