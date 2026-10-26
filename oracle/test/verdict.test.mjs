import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { summarize } from '../lib/summary.mjs';
import {
  ENGINE_TARGET,
  encode,
  engineEntry,
  layoutDerived,
  propertyVerdict,
  sheetVerdict,
} from '../lib/verdict.mjs';

/** @import { EngineResult, Job, SheetJob, PropertyResult } from '../lib/types.mjs' */

// Fixtures are partial raw results; the verdict functions only read what each test sets.
/** @type {(value: unknown) => any} */
const loose = (value) => value;

describe('sheetVerdict (lowering)', () => {
  test('drops differences base and head share exactly (engine version spread)', () => {
    const touched = { 'div#0': { 'font-family': '"Times New Roman"', color: 'rgb(255, 0, 0)' } };
    const values = (/** @type {string} */ color) => ({
      'div#0': { 'font-family': 'Times New Roman', color },
    });
    const result = loose({
      variants: {
        input: { info: {} },
        base: { info: {}, values: values('rgb(0, 0, 255)') },
        head: { info: {}, values: values('rgb(255, 0, 0)') },
      },
    });
    const verdict = sheetVerdict('chromium', { probe: {} }, result, 'lowering', touched);

    assert.equal(verdict.shared, 1);
    assert.equal(verdict.variants.base.status, 'different');
    assert.equal(verdict.variants.head.status, 'equivalent');
    assert.equal(summarize({ chromium: loose(verdict) }).transition, 'fixed');

    // A defect both sides share, with nothing else differing, stays visible.
    const same = loose({
      variants: {
        input: { info: {} },
        base: { info: {}, values: values('rgb(0, 0, 255)') },
        head: { info: {}, values: values('rgb(0, 0, 255)') },
      },
    });
    const shared = sheetVerdict('chromium', { probe: {} }, same, 'lowering', touched);

    assert.equal(shared.shared, 0);
    assert.equal(summarize({ chromium: loose(shared) }).transition, 'still-different');
    assert.equal(summarize({ chromium: loose(shared) }).neutral, true);
  });

  test('legacy lanes skip layout-derived used values the sheets do not declare', () => {
    const touched = {
      'div#0': { display: 'inline-flex', width: '7.03125px', 'transform-origin': '3.515625px 10.5px' },
    };
    const values = (/** @type {string} */ display) => ({
      'div#0': { display, width: '9px', 'transform-origin': '4.5px 9.5px' },
    });
    const variants = {
      input: { info: {} },
      base: { info: {}, values: values('block') },
      head: { info: {}, values: values('inline-flex') },
    };
    const probe = { input: { decls: [['display', 'inline-flex', false]], selectors: [], preludes: [] } };
    const job = loose({ probe });
    const verdict = sheetVerdict('webkit', job, loose({ variants }), 'lowering', touched);

    assert.deepEqual(
      verdict.variants.base.diffs?.map((d) => d.prop),
      ['display'],
    );
    assert.equal(verdict.variants.head.status, 'equivalent');

    // With the legacy engine's own input values, a layout change the output causes there still shows.
    const own = {
      ...variants,
      input: { info: {}, values: values('inline-flex') },
      head: {
        info: {},
        values: { 'div#0': { display: 'inline-flex', width: '9px', 'transform-origin': '1px 1px' } },
      },
    };
    const withOwn = sheetVerdict('webkit', job, loose({ variants: own }), 'lowering', touched);

    assert.deepEqual(
      withOwn.variants.head.diffs?.map((d) => [d.prop, d.ref, d.refFrom]),
      [['transform-origin', '4.5px 9.5px', 'engine-input']],
    );
    assert.equal(withOwn.variants.base.status, 'different');

    // An engine that reads the input differently (a rule it drops) gives no layout to compare with.
    const dropped = { 'div#0': { display: 'block', width: '800px', 'transform-origin': '400px 9.5px' } };
    const misread = {
      input: { info: {}, values: dropped },
      base: { info: {}, values: dropped },
      head: { info: {}, values: values('inline-flex') },
    };
    const misreading = sheetVerdict('webkit', job, loose({ variants: misread }), 'lowering', touched);

    assert.deepEqual(
      [misreading.variants.base.diffs?.map((d) => d.prop), misreading.variants.head.status],
      [['display'], 'equivalent'],
    );

    // Reference lanes still compare every property.
    const reference = sheetVerdict(
      'webkit',
      job,
      loose({
        variants: {
          input: { info: {}, touched },
          head: { info: {}, diff: [['div#0', 'width', '7.03125px', '9px']] },
        },
      }),
      'same-engine',
    );

    assert.equal(reference.variants.head.status, 'different');
  });

  test('properties the legacy engine does not know, and polyfill toggles, are skipped', () => {
    const touched = { 'div#0': { 'text-wrap': 'balance', '--lightningcss-light': 'initial', color: 'red' } };
    const variants = {
      input: { info: {} },
      head: { info: {}, values: { 'div#0': { 'text-wrap': '', '--lightningcss-light': ' ', color: 'red' } } },
    };
    const verdict = sheetVerdict('webkit', { probe: {} }, loose({ variants }), 'lowering', touched);

    assert.deepEqual([verdict.variants.head.status, verdict.variants.base.status], ['equivalent', 'unknown']);
  });
});

describe('sheetVerdict (same engine)', () => {
  test('a side whose text is the input up to whitespace and comments is equivalent by definition', () => {
    const touched = { 'div#0': { display: 'inline-flex', color: 'rgb(255, 0, 0)' } };
    const diff = [['div#0', 'color', 'rgb(255, 0, 0)', 'rgb(0, 0, 255)']];
    const result = loose({
      variants: { input: { info: {}, touched }, base: { info: {}, diff }, head: { info: {}, diff } },
    });
    const verdict = sheetVerdict('webkit', { probe: {}, sameAsInput: ['head'] }, result, 'same-engine');

    assert.equal(verdict.variants.base.status, 'different');
    assert.deepEqual(
      [verdict.variants.head.status, verdict.variants.head.reason],
      ['equivalent', 'same-text-as-input'],
    );
    assert.equal(summarize({ webkit: loose(verdict) }).transition, 'fixed');

    // A legacy lane compares with the reference engine's reading: the same text can still lack lowering
    // there (an @layer or nested rule the old engine drops), so it is judged like any output.
    const values = { 'div#0': { display: 'block', color: 'rgb(255, 0, 0)' } };
    const lowering = loose({
      variants: { input: { info: {}, values }, base: { info: {}, values }, head: { info: {}, values } },
    });
    const legacy = sheetVerdict(
      'webkit',
      { probe: {}, sameAsInput: ['head'] },
      lowering,
      'lowering',
      touched,
    );

    assert.deepEqual(
      [legacy.variants.base.status, legacy.variants.head.status, legacy.variants.head.reason],
      ['different', 'different', undefined],
    );
    assert.equal(summarize({ webkit: loose(legacy) }).transition, 'still-different');
  });

  test('entry layout, worst diffs first, signature, input rejection signature', () => {
    const touched = { 'div#0': { color: 'red', width: '1px' } };
    const diff = [
      ['div#1', 'width', '1px', '1.0001px'],
      ['div#0', 'width', '1px', '5px'],
      ['div#0', 'color', 'rgb(255, 0, 0)', 'rgb(252, 0, 0)'],
      ['div#0', '--lightningcss-dark', ' ', 'initial'],
    ];
    const result = loose({
      variants: {
        input: { info: { decls: [true, false], selectors: [false] }, touched },
        base: { info: {}, diff: [] },
        head: { info: {}, diff },
      },
    });
    const verdict = sheetVerdict('chromium', { probe: {} }, result, 'same-engine');

    assert.deepEqual(Object.keys(verdict), ['touched', 'variants', 'overlap', 'inputSig', 'inputRejected']);
    assert.deepEqual([verdict.touched, verdict.inputSig, verdict.inputRejected], [2, '1/0/', true]);
    assert.deepEqual(verdict.overlap, { baseOnly: 0, headOnly: 1 });

    const head = verdict.variants.head;

    assert.deepEqual(Object.keys(head), [
      'status',
      'diffs',
      'diffCount',
      'levels',
      'sig',
      'rejected',
      'hardRejected',
    ]);
    assert.deepEqual(
      head.diffs?.map((d) => [d.key, d.prop, d.level]),
      [
        ['div#0', 'width', 'different'],
        ['div#0', 'color', 'near'],
        ['div#1', 'width', 'noise'],
      ],
    );
    assert.deepEqual(head.levels, { different: 1, near: 1, noise: 1 });
    assert.equal(head.sig, 'div#0|color|near|rgb(252, 0, 0)\ndiv#0|width|different|5px');
    assert.equal(verdict.variants.base.status, 'equivalent');
  });

  test('diffs of one level and property are ordered by element key', () => {
    const touched = { 'div#0': { width: '1px' } };
    const diff = [
      ['div#2', 'width', '1px', '9px'],
      ['div#10', 'width', '1px', '9px'],
      ['div#0', 'width', '1px', '9px'],
    ];
    const result = loose({ variants: { input: { info: {}, touched }, head: { info: {}, diff } } });
    const head = sheetVerdict('chromium', { probe: {} }, result, 'same-engine').variants.head;

    assert.deepEqual(
      head.diffs?.map((d) => d.key),
      ['div#0', 'div#10', 'div#2'],
    );
  });

  test('nothing touched and nothing different is no-coverage; a missing side is unknown', () => {
    const result = loose({ variants: { input: { info: {}, touched: {} }, base: { info: {}, diff: [] } } });
    const verdict = sheetVerdict('chromium', { probe: {} }, result, 'same-engine');

    assert.equal(verdict.variants.base.status, 'no-coverage');
    assert.deepEqual(verdict.variants.head, { status: 'unknown', reason: 'no-output' });
  });

  test('stored diffs and rejections are capped, counts are not', () => {
    const touched = { 'div#0': { color: 'red' } };
    const diff = Array.from({ length: 20 }, (_, i) => [`div#${i}`, 'width', '1px', '9px']);
    const decls = Array.from({ length: 20 }, (_, i) => [`x-${i}`, 'v', false]);
    const result = loose({
      variants: { input: { info: {}, touched }, head: { info: { decls: decls.map(() => false) }, diff } },
    });
    const head = sheetVerdict(
      'chromium',
      loose({ probe: { head: { decls, selectors: [], preludes: [] } } }),
      result,
      'same-engine',
    ).variants.head;

    assert.deepEqual(
      [head.diffs?.length, head.diffCount, head.rejected?.decls.length, head.hardRejected],
      [12, 20, 12, 20],
    );
  });
});

describe('propertyVerdict', () => {
  test('maps parsing outcomes to statuses; a baseline failure leaves only `different`', () => {
    /** @type {PropertyResult} */
    const result = {
      baseline: null,
      variants: { base: { status: 'pass' }, head: { status: 'valid-became-invalid' } },
    };

    assert.deepEqual(propertyVerdict(result), {
      baseline: null,
      variants: {
        base: { status: 'equivalent', detail: { status: 'pass' } },
        head: { status: 'different', detail: { status: 'valid-became-invalid' } },
      },
      inputSig: 'ok',
    });

    const failing = propertyVerdict({
      baseline: { status: 'baseline-failure' },
      variants: { base: { status: 'pass' }, head: { status: 'weird' } },
    });

    assert.deepEqual(
      [failing.variants?.base.status, failing.variants?.head.status, failing.inputSig],
      ['unknown', 'unknown', 'baseline-failure'],
    );
    assert.deepEqual(propertyVerdict({ baseline: null, variants: {} }).variants?.base, { status: 'unknown' });
  });
});

describe('engineEntry', () => {
  const job = /** @type {Job} */ (/** @type {SheetJob} */ (loose({ id: 'a', kind: 'sheet', probe: {} })));
  const row = (/** @type {Partial<EngineResult>} */ fields) =>
    /** @type {EngineResult} */ ({
      id: 'a',
      engine: 'webkit',
      version: '16.4',
      ms: 1,
      result: loose({ variants: { input: { info: {} } } }),
      ...fields,
    });
  const touched = { 'div#0': { color: 'red' } };

  test('an errored job is an error on both sides', () => {
    assert.deepEqual(engineEntry('reference', row({ error: 'boom' }), job, {}, null), {
      version: '16.4',
      error: 'boom',
      variants: { base: { status: 'error' }, head: { status: 'error' } },
    });
  });

  test('legacy lanes judge only engines inside the targets, at or above the target version', () => {
    const lowering = (/** @type {unknown} */ targets, /** @type {any} */ refTouched = touched) =>
      engineEntry('legacy', row({}), job, loose({ id: 'a', kind: 'sheet', sheets: {}, targets }), refTouched);

    assert.equal(lowering(null).skipped, 'engine-not-in-targets');
    assert.equal(lowering({ chrome: 1 }).skipped, 'engine-not-in-targets');
    assert.equal(lowering({ safari: encode('16.5') }).skipped, 'engine-older-than-targets');
    assert.equal(lowering({ safari: encode('16.4') }, loose(null)).skipped, 'no-reference');
    assert.equal(lowering({ safari: encode('16.4') }).skipped, undefined);
    assert.equal(lowering({ safari: encode('16.4') }).shared, 0);
  });

  test('the reference lane judges in the same engine; parsing jobs use the property verdict', () => {
    assert.ok('inputSig' in engineEntry('reference', row({}), job, {}, null));

    const property = /** @type {Job} */ (loose({ id: 'w', kind: 'property' }));

    assert.equal(
      engineEntry('reference', row({ result: loose({ baseline: null, variants: {} }) }), property, {}, null)
        .inputSig,
      'ok',
    );
  });
});

describe('helpers', () => {
  test('encode follows Lightning CSS: major << 16 | minor << 8 | patch', () => {
    assert.equal(encode('16.4'), (16 << 16) | (4 << 8));
    assert.equal(encode('110.0.5481.38'), (110 << 16) | (5481 & 0xffff));
    assert.equal(encode('80.0b8'), 80 << 16);
    assert.deepEqual(ENGINE_TARGET, { chromium: 'chrome', firefox: 'firefox', webkit: 'safari' });
  });

  test('layoutDerived: sizes, origins and px line heights unless the sheets declare them', () => {
    const none = new Set(['display']);

    assert.equal(layoutDerived('width', '7.03125px', '9px', none), true);
    assert.equal(layoutDerived('inline-size', '7px', '9px', none), true);
    assert.equal(layoutDerived('transform-origin', '3.5px 10.5px', '4.5px 9.5px', none), true);
    assert.equal(layoutDerived('-webkit-perspective-origin', '1px 1px', '2px 2px', none), true);
    assert.equal(layoutDerived('line-height', '19px', '21px', none), true);
    assert.equal(layoutDerived('line-height', 'normal', '21px', none), false);
    assert.equal(layoutDerived('display', 'block', 'flex', none), false);
    assert.equal(layoutDerived('width', '7px', '9px', new Set(['inline-size'])), false);
    assert.equal(layoutDerived('line-height', '19px', '21px', new Set(['font'])), false);
    assert.equal(
      layoutDerived('transform-origin', '1px 1px', '2px 2px', new Set(['transform-origin'])),
      false,
    );
  });
});
