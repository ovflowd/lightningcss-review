import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { summarize, transition } from '../lib/summary.mjs';

// Engine entries as verdict.mjs builds them, reduced to what the summary reads.
/** @type {(value: unknown) => any} */
const loose = (value) => value;

/**
 * One engine entry: statuses per side plus what the summary reads.
 *
 * @param {string} base
 * @param {string} head
 * @param {object} [extra]
 * @returns {any}
 */
const entry = (base, head, extra = {}) =>
  loose({
    touched: 3,
    inputSig: '//',
    variants: { base: { status: base, sig: base }, head: { status: head, sig: head } },
    ...extra,
  });
const errored = () =>
  loose({ error: 'boom', variants: { base: { status: 'error' }, head: { status: 'error' } } });
/**
 * @param {string} base
 * @param {string} head
 * @returns {any}
 */
const inert = (base, head) => ({ ...entry(base, head), touched: 0, inputSig: '0//', inputRejected: true });

describe('summarize', () => {
  test('an errored engine never makes a case different or verified', () => {
    assert.equal(summarize({ chromium: errored(), firefox: errored() }).transition, 'errored');
    assert.equal(
      summarize({ chromium: entry('equivalent', 'equivalent'), firefox: errored() }).transition,
      'errored',
    );
    assert.equal(
      summarize({ chromium: entry('different', 'equivalent'), firefox: errored() }).transition,
      'errored',
    );

    const summary = summarize({ chromium: entry('equivalent', 'different'), firefox: errored() });

    assert.equal(summary.transition, 'regressed');
    assert.deepEqual(summary.errored, ['firefox']);
    assert.deepEqual(summary.engines.firefox, { base: 'error', head: 'error' });
  });

  test('input that touches nothing in every engine is input-rejected, never regressed', () => {
    assert.equal(
      summarize({ chromium: inert('no-coverage', 'different'), firefox: inert('no-coverage', 'different') })
        .transition,
      'input-rejected',
    );
    assert.equal(summarize({ chromium: inert('no-coverage', 'no-coverage') }).transition, 'unverified');

    // Valid input that only sets initial values is not rejected: head changing something is a regression.
    const initial = { ...entry('no-coverage', 'different'), touched: 0, inputRejected: false };

    assert.equal(summarize({ chromium: initial, firefox: initial }).transition, 'regressed');

    // An engine where all three sheets are inert is left out; the others still judge the case.
    const summary = summarize({
      chromium: entry('equivalent', 'equivalent'),
      firefox: inert('no-coverage', 'no-coverage'),
    });

    assert.equal(summary.transition, 'both-equivalent');
    assert.deepEqual(summary.inert, ['firefox']);
    assert.deepEqual(summary.inertLive, []);
  });

  test('an output that applies styles where the input is inert is different there', () => {
    const summary = summarize({
      chromium: inert('no-coverage', 'different'),
      firefox: entry('equivalent', 'equivalent'),
      webkit: inert('no-coverage', 'near'),
    });

    assert.equal(summary.transition, 'regressed');
    assert.equal(summary.head, 'different');
    assert.deepEqual(summary.inert, []);
    assert.deepEqual(summary.inertLive, ['chromium', 'webkit']);
    assert.deepEqual(summary.engines.chromium, {
      base: 'equivalent',
      head: 'different',
      reason: 'input-inert-output-live',
    });
    assert.deepEqual(summary.enginesHead.bad, ['chromium', 'webkit']);

    // Base live where the input is dead and head inert again: the PR fixes it.
    assert.equal(
      summarize({ chromium: inert('different', 'no-coverage'), firefox: entry('equivalent', 'equivalent') })
        .transition,
      'fixed',
    );
  });

  test('base fine everywhere and head wrong in one engine is regressed, not divergent', () => {
    const summary = summarize({
      chromium: entry('equivalent', 'equivalent'),
      firefox: entry('equivalent', 'different', { inputSig: '0//' }),
      webkit: entry('equivalent', 'equivalent'),
    });

    assert.equal(summary.transition, 'regressed');
    assert.equal(summary.divergent, false);
    assert.deepEqual(summary.enginesHead, { ok: ['chromium', 'webkit'], bad: ['firefox'], divergent: true });
  });

  test('divergent needs a same-side split and engines that read the input differently', () => {
    const split = { chromium: entry('equivalent', 'different'), firefox: entry('different', 'different') };

    assert.equal(summarize(split).divergent, false);
    assert.equal(summarize(split).transition, 'still-different');

    const dependent = {
      chromium: entry('equivalent', 'different'),
      firefox: entry('different', 'different', { inputSig: '1//' }),
    };

    assert.equal(summarize(dependent).divergent, true);
  });

  test('head adding differences on top of base is worsened', () => {
    /**
     * @param {number} baseOnly
     * @param {number} headOnly
     * @returns {any}
     */
    const outcome = (baseOnly, headOnly) =>
      summarize({ chromium: entry('different', 'different', { overlap: { baseOnly, headOnly } }) })
        .transition;

    assert.equal(outcome(0, 2), 'worsened');
    assert.equal(outcome(0, 0), 'still-different');
    assert.equal(outcome(1, 2), 'still-different');
  });

  test('introduced: base cannot run the request, head is judged against the input', () => {
    const noBase = (/** @type {string} */ head) =>
      loose({
        touched: 2,
        inputSig: '//',
        variants: { base: { status: 'unknown', reason: 'no-output' }, head: { status: head, sig: '' } },
      });

    assert.equal(summarize({ chromium: noBase('different') }, { introduced: true }).transition, 'introduced');
    assert.equal(summarize({ chromium: noBase('different') }, { introduced: true }).head, 'different');
    assert.equal(
      summarize({ chromium: noBase('equivalent') }, { introduced: true }).transition,
      'introduced',
    );
    assert.equal(summarize({ chromium: noBase('equivalent') }).transition, 'unverified');
    assert.equal(
      summarize({ chromium: noBase('equivalent'), firefox: errored() }, { introduced: true }).transition,
      'errored',
    );
    assert.equal(
      summarize({ chromium: noBase('different'), firefox: errored() }, { introduced: true }).transition,
      'introduced',
    );
  });

  test('engines computing the input differently on the disputed property make the case divergent', () => {
    const diff = (/** @type {string} */ ref) => [
      { key: 'div#0', prop: 'color', ref, val: 'rgb(28, 84, 112)', level: 'different' },
    ];
    /**
     * @param {string} chromiumInput
     * @param {string} firefoxInput
     * @returns {any}
     */
    const run = (chromiumInput, firefoxInput) => {
      const bucket = loose({
        chromium: {
          touched: 1,
          inputSig: '//',
          variants: {
            base: { status: 'different', diffs: diff(chromiumInput) },
            head: { status: 'equivalent', diffs: [] },
          },
        },
        firefox: {
          touched: 1,
          inputSig: '//',
          variants: {
            base: { status: 'equivalent', diffs: [] },
            head: { status: 'different', diffs: diff(firefoxInput) },
          },
        },
      });

      return summarize(bucket, {
        touched: {
          chromium: { 'div#0': { color: chromiumInput } },
          firefox: { 'div#0': { color: firefoxInput } },
        },
      });
    };

    assert.equal(run('color(srgb 0.11 0.33 0.44)', 'color(srgb 0.055 0.165 0.22)').divergent, true);
    assert.equal(run('color(srgb 0.11 0.33 0.44)', 'color(srgb 0.11 0.33 0.44)').divergent, false);
    assert.equal(
      run('color(srgb 0.11 0.33 0.44)', 'color(srgb 0.055 0.165 0.22)').transition,
      'still-different',
    );
  });

  test('summary layout: rejections, visual checks, skipped engines and no engines', () => {
    const bucket = {
      chromium: entry('equivalent', 'different', {
        visual: { base: 'pixel-identical', head: 'pixel-different' },
      }),
      webkit: loose({ ...entry('equivalent', 'equivalent'), visualError: 'timeout' }),
      firefox: loose({
        version: '1',
        skipped: 'engine-not-in-targets',
        visual: { base: 'pixel-different', head: null },
      }),
    };

    bucket.chromium.variants.head.hardRejected = 2;

    const summary = summarize(bucket);

    assert.deepEqual(Object.keys(summary), [
      'base',
      'head',
      'transition',
      'rejectedBase',
      'rejectedHead',
      'visualBase',
      'visualHead',
      'visualErrors',
      'enginesBase',
      'enginesHead',
      'engines',
      'errored',
      'inert',
      'inertLive',
      'inputDependent',
      'divergent',
      'neutral',
    ]);
    assert.deepEqual([summary.rejectedBase, summary.rejectedHead], [0, 2]);
    // Visual flags read every entry, judged or not.
    assert.deepEqual(
      [summary.visualBase, summary.visualHead, summary.visualErrors],
      [true, true, ['webkit']],
    );
    assert.deepEqual(Object.keys(summary.engines), ['chromium', 'webkit']);
    assert.deepEqual(
      [summarize({}).transition, summarize({}).base, summarize({}).neutral],
      ['unverified', 'unknown', false],
    );
  });
});

describe('transition', () => {
  test('every outcome', () => {
    assert.equal(transition('unknown', 'equivalent'), 'unverified');
    assert.equal(transition('no-coverage', 'no-coverage'), 'unverified');
    assert.equal(transition('equivalent', 'near'), 'near-introduced');
    assert.equal(transition('near', 'near'), 'both-equivalent');
    assert.equal(transition('no-coverage', 'equivalent'), 'both-equivalent');
    assert.equal(transition('different', 'near'), 'fixed');
    assert.equal(transition('near', 'different'), 'regressed');
    assert.equal(transition('different', 'different'), 'still-different');
    assert.equal(transition('equivalent', 'unknown', [], { introduced: true }), 'unverified');
  });
});
