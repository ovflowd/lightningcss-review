// node --test oracle/test/  (inside the analysis image: node_modules resolve from /opt/lcr)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareValues, tokenize } from '../normalize.mjs';
import { synthesize, rewriteStates, validityProbe } from '../dom.mjs';
import { summarize, sheetVerdict, compactSelector } from '../verdict.mjs';
import { sheetJob } from '../prepare-jobs.mjs';
import { readAll, jsonlWriter } from '../jsonl.mjs';

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

test('pseudo-elements: prefixed aliases, one-colon CSS 2 forms and nested rules are read', () => {
  assert.deepEqual(synthesize(['.a::-moz-placeholder{color:red}']).pseudos, ['::placeholder']);
  assert.deepEqual(synthesize(['.a::-webkit-input-placeholder{color:red}.b::-moz-selection{color:red}']).pseudos, ['::placeholder', '::selection']);
  assert.deepEqual(synthesize(['.a:before{color:red}.b:first-line{color:red}']).pseudos, ['::before', '::first-line']);
  assert.match(synthesize(['.a:after{color:red}']).html, /<div class="a">x<\/div>/);
  assert.deepEqual(synthesize(['.lcr-n{.a::before{color:red}}']).pseudos, ['::before']);
  assert.match(synthesize(['[a="b" s]:after{color:red}']).html, /<div a="b">x<\/div>/);
});

test('nested rules css-tree leaves as raw text are re-parsed in place', () => {
  const r = synthesize(['.lcr-n{.a .b{color:red} div::after{color:red} color:blue}']);
  assert.match(r.html, /<div class="lcr-n"><div class="a"><div class="b">x<\/div><\/div><\/div>/);
  assert.deepEqual(r.pseudos, ['::after']);
  assert.equal(rewriteStates('.p{.c:hover{color:red}}').css, '.p{.c[data-lcr-hover]{color:red}}');
  assert.deepEqual(validityProbe('.p{.c{color:red} margin:1px}').decls, [['color', 'red', false], ['margin', '1px', false]]);
  assert.deepEqual(validityProbe('.p{> .c{color:red}}').selectors, ['.p']);
});

test('keyframe selectors are neither synthesized nor probed as selectors', () => {
  const css = '@keyframes k{0%{color:red}from{color:blue}}';
  assert.equal(synthesize([css]).generic, true);
  assert.deepEqual(validityProbe(css).selectors, []);
});

test('conditional preludes are probed up to their block (css-tree drops the final paren)', () => {
  assert.deepEqual(validityProbe('@supports (a:b) and ((-webkit-c:d)){.x{color:red}}').preludes, [['supports', '(a:b) and ((-webkit-c:d))']]);
  assert.deepEqual(validityProbe('@media (min-width:1px) and (max-width:2px){.x{color:red}}').preludes, [['media', '(min-width:1px) and (max-width:2px)']]);
});

test(':dir(rtl) and RTL :lang() synthesize elements that match both forms', () => {
  const html = synthesize([':dir(rtl){color:red}', ':lang(ae, ar, he){color:red}', ':lang(en){color:red}']).html;
  assert.match(html, /<div dir="rtl" lang="ar">x<\/div>/);
  assert.match(html, /<div lang="ae" dir="rtl">x<\/div>/);
  assert.match(html, /<div lang="en">x<\/div>/);
});

// One engine entry: statuses per side plus what the summary reads.
const e = (base, head, extra = {}) => ({ touched: 3, inputSig: '//', variants: { base: { status: base, sig: base }, head: { status: head, sig: head } }, ...extra });
const err = () => ({ error: 'boom', variants: { base: { status: 'error' }, head: { status: 'error' } } });

test('an errored engine never makes a case different or verified', () => {
  assert.equal(summarize({ chromium: err(), firefox: err() }).transition, 'errored');
  assert.equal(summarize({ chromium: e('equivalent', 'equivalent'), firefox: err() }).transition, 'errored');
  assert.equal(summarize({ chromium: e('different', 'equivalent'), firefox: err() }).transition, 'errored');
  const s = summarize({ chromium: e('equivalent', 'different'), firefox: err() });
  assert.equal(s.transition, 'regressed');
  assert.deepEqual(s.errored, ['firefox']);
  assert.deepEqual(s.engines.firefox, { base: 'error', head: 'error' });
});

test('input that touches nothing in every engine is input-rejected, never regressed', () => {
  const inert = (base, head) => ({ ...e(base, head), touched: 0, inputSig: '0//', inputRejected: true });
  assert.equal(summarize({ chromium: inert('no-coverage', 'different'), firefox: inert('no-coverage', 'different') }).transition, 'input-rejected');
  assert.equal(summarize({ chromium: inert('no-coverage', 'no-coverage') }).transition, 'unverified');
  // Valid input that only sets initial values is not rejected: head changing something is a regression.
  const initial = { ...e('no-coverage', 'different'), touched: 0, inputRejected: false };
  assert.equal(summarize({ chromium: initial, firefox: initial }).transition, 'regressed');
  // An engine where the input is inert is left out; the others still judge the case.
  const s = summarize({ chromium: e('equivalent', 'equivalent'), firefox: inert('no-coverage', 'different') });
  assert.equal(s.transition, 'both-equivalent');
  assert.deepEqual(s.inert, ['firefox']);
});

test('base fine everywhere and head wrong in one engine is regressed, not divergent', () => {
  const s = summarize({ chromium: e('equivalent', 'equivalent'), firefox: e('equivalent', 'different', { inputSig: '0//' }), webkit: e('equivalent', 'equivalent') });
  assert.equal(s.transition, 'regressed');
  assert.equal(s.divergent, false);
  assert.deepEqual(s.enginesHead, { ok: ['chromium', 'webkit'], bad: ['firefox'], divergent: true });
});

test('divergent needs a same-side split and engines that read the input differently', () => {
  const split = { chromium: e('equivalent', 'different'), firefox: e('different', 'different') };
  assert.equal(summarize(split).divergent, false);
  assert.equal(summarize(split).transition, 'still-different');
  const dependent = { chromium: e('equivalent', 'different'), firefox: e('different', 'different', { inputSig: '1//' }) };
  assert.equal(summarize(dependent).divergent, true);
});

test('head adding differences on top of base is worsened', () => {
  const s = (baseOnly, headOnly) => summarize({ chromium: e('different', 'different', { overlap: { baseOnly, headOnly } }) }).transition;
  assert.equal(s(0, 2), 'worsened');
  assert.equal(s(0, 0), 'still-different');
  assert.equal(s(1, 2), 'still-different');
});

test('introduced: base cannot run the request, head is judged against the input', () => {
  const noBase = (head) => ({ touched: 2, inputSig: '//', variants: { base: { status: 'unknown', reason: 'no-output' }, head: { status: head, sig: '' } } });
  assert.equal(summarize({ chromium: noBase('different') }, { introduced: true }).transition, 'introduced');
  assert.equal(summarize({ chromium: noBase('different') }, { introduced: true }).head, 'different');
  assert.equal(summarize({ chromium: noBase('equivalent') }, { introduced: true }).transition, 'introduced');
  assert.equal(summarize({ chromium: noBase('equivalent') }).transition, 'unverified');
  assert.equal(summarize({ chromium: noBase('equivalent'), firefox: err() }, { introduced: true }).transition, 'errored');
});

test('lowering drops differences base and head share exactly (engine version spread)', () => {
  const touched = { 'div#0': { 'font-family': '"Times New Roman"', color: 'rgb(255, 0, 0)' } };
  const values = (color) => ({ 'div#0': { 'font-family': 'Times New Roman', color } });
  const result = { variants: { input: { info: {} }, base: { info: {}, values: values('rgb(0, 0, 255)') }, head: { info: {}, values: values('rgb(255, 0, 0)') } } };
  const v = sheetVerdict('chromium', { probe: {} }, result, 'lowering', touched);
  assert.equal(v.shared, 1);
  assert.equal(v.variants.base.status, 'different');
  assert.equal(v.variants.head.status, 'equivalent');
  assert.equal(summarize({ chromium: v }).transition, 'fixed');
  // A defect both sides share, with nothing else differing, stays visible.
  const same = { variants: { input: { info: {} }, base: { info: {}, values: values('rgb(0, 0, 255)') }, head: { info: {}, values: values('rgb(0, 0, 255)') } } };
  const w = sheetVerdict('chromium', { probe: {} }, same, 'lowering', touched);
  assert.equal(w.shared, 0);
  assert.equal(summarize({ chromium: w }).transition, 'still-different');
  assert.equal(summarize({ chromium: w }).neutral, true);
});

test('long :lang() lists are stored as a count', () => {
  assert.equal(compactSelector('.a:lang(ae, ar, arc, bcc, he)'), '.a:lang(<5 languages>)');
  assert.equal(compactSelector('.a:lang(en)'), '.a:lang(en)');
});

test('a dom: override still reads the pseudo-elements the sheets use', () => {
  const { jobs } = sheetJob({ id: 'p-x/y', sheets: { input: '.a::after{content:"x";color:red}', base: '.a:after{content:"x";color:red}', head: '.a:after{content:"x";color:#00f}' }, dom: '<div class="a">x</div>' });
  assert.equal(jobs[0].html, '<div class="a">x</div>');
  assert.deepEqual(jobs[0].pseudos, ['::after']);
});

test('custom properties referenced but never defined get a stand-in in every sheet', () => {
  const { jobs, meta } = sheetJob({ id: 't', sheets: { input: '.a{margin:var(--x);color:var(--c);padding:var(--y, 1px)}', base: '.a{margin:var(--x)}', head: '.a{margin:var(--x)}' } });
  assert.deepEqual(meta.injectedVars, ['--c', '--x']);
  for (const name of ['empty', 'input', 'base', 'head']) assert.match(jobs[0].sheets[name], /:root\{--c:rgb\(1, 2, 3\);--x:5px\}$/);
  const defined = sheetJob({ id: 'u', sheets: { input: ':root{--x:1px}.a{margin:var(--x)}', base: '', head: '' } });
  assert.equal(defined.jobs[0].sheets.empty, '');
});

test('JSONL streams round-trip, gzip included', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcr-jsonl-'));
  try {
    for (const name of ['r.jsonl', 'r.jsonl.gz']) {
      const file = path.join(dir, name);
      const w = jsonlWriter(file);
      for (let i = 0; i < 3; i++) w.write({ i, s: 'x'.repeat(1000) });
      await w.end();
      assert.deepEqual((await readAll(file)).map((r) => r.i), [0, 1, 2]);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('engines computing the input differently on the disputed property make the case divergent', () => {
  const diff = (ref) => [{ key: 'div#0', prop: 'color', ref, val: 'rgb(28, 84, 112)', level: 'different' }];
  const run = (c, f, opts = {}) => {
    const bucket = {
      chromium: { touched: 1, inputSig: '//', variants: { base: { status: 'different', diffs: diff(c) }, head: { status: 'equivalent', diffs: [] } } },
      firefox: { touched: 1, inputSig: '//', variants: { base: { status: 'equivalent', diffs: [] }, head: { status: 'different', diffs: diff(f) } } },
    };
    return summarize(bucket, { touched: { chromium: { 'div#0': { color: c } }, firefox: { 'div#0': { color: f } } }, ...opts });
  };
  assert.equal(run('color(srgb 0.11 0.33 0.44)', 'color(srgb 0.055 0.165 0.22)').divergent, true);
  assert.equal(run('color(srgb 0.11 0.33 0.44)', 'color(srgb 0.11 0.33 0.44)').divergent, false);
  assert.equal(run('color(srgb 0.11 0.33 0.44)', 'color(srgb 0.055 0.165 0.22)').transition, 'still-different');
});

test('a longhand whose value the input carried in a rejected shorthand is marked carrierRejected', () => {
  const probe = {
    input: { decls: [['animation', 'a 1s scroll(nearest)', false]], selectors: [], preludes: [] },
    base: { decls: [['animation', 'a 1s scroll(nearest)', false]], selectors: [], preludes: [] },
    head: { decls: [['animation', 'a 1s'], ['animation-timeline', 'scroll( nearest )'], ['animation-delay', '2s']], selectors: [], preludes: [] },
  };
  const info = (decls) => ({ decls });
  const result = { variants: { input: { info: info([false]), touched: {} }, base: { info: info([false]) }, head: { info: info([true, false, false]) } } };
  const v = sheetVerdict('firefox', { probe }, result, 'same-engine');
  const decls = v.variants.head.rejected.decls;
  assert.equal(decls.find((d) => d.prop === 'animation-timeline').carrierRejected, true);
  assert.equal(decls.find((d) => d.prop === 'animation-delay').carrierRejected, undefined);
  assert.equal(v.variants.head.hardRejected, 2);
});
