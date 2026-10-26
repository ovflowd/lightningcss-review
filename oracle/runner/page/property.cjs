/// <reference lib="dom" />
/**
 * In-page CSSOM check of one property value (WPT parsing tests).
 *
 * Stage: oracle (engine runner). Adapted from the browser oracle in parcel-bundler/lightningcss#1328
 * (wpt/browser.mjs, Devon Govett, MPL-2.0). `pageProperty` is passed to `page.evaluate`, which
 * serializes it with `toString()`: it must be self-contained and run in the oldest engines we
 * drive (Chromium 97, Firefox 93, WebKit 15.4).
 *
 * The engine first parses the WPT input itself (`baseline`): when it does not handle the input as
 * WPT expects, its opinion of the outputs cannot be trusted. Each output is then judged against
 * the input:
 * - invalid input: the output must stay invalid, and must leave a valid fallback before it intact;
 * - valid input: the output must stay valid, reset the same longhands (shorthand reset probe), and
 *   specify the same values; when the specified values differ only in spelling the computed
 *   values of a fixed context decide (`contextual-match` versus `computed-difference`).
 */
'use strict';

/** @import { PropertyJob, PropertyResult } from '../../lib/types.mjs' */

/* eslint-disable max-lines-per-function -- serialized into the page with toString(): its helpers must be nested */
/**
 * Judge every output of a parsing job.
 *
 * @param {PropertyJob} job
 * @returns {PropertyResult}
 */
function pageProperty(job) {
  const property = job.property;
  const original = document.createElement('div').style;

  original.setProperty(property, job.value);

  const read = original.getPropertyValue(property);
  /** @type {PropertyResult} */
  const out = { baseline: null, variants: {} };

  /**
   * @param {string} actual
   * @param {string | string[] | undefined} expected
   * @returns {boolean}
   */
  function matchesExpected(actual, expected) {
    return Array.isArray(expected) ? expected.indexOf(actual) >= 0 : actual === expected;
  }

  if (job.wptKind === 'invalid') {
    if (read !== '') {
      out.baseline = { status: 'baseline-failure', actual: read };
    }
  } else if (!read) {
    out.baseline = { status: 'baseline-unsupported', actual: '' };
  } else if (job.wptKind === 'valid' && job.expected !== undefined && !matchesExpected(read, job.expected)) {
    out.baseline = { status: 'baseline-failure', actual: read, expected: job.expected };
  }

  /** @returns {CSSStyleDeclaration} */
  function freshStyle() {
    return document.createElement('div').style;
  }

  /**
   * Invalid input: a valid output is a bug; otherwise the output must not disturb a valid
   * declaration before it (the fallback a browser would keep).
   *
   * @param {string} output
   * @returns {{ status: string } & Record<string, unknown>}
   */
  function judgeInvalidInput(output) {
    const transformed = freshStyle();

    transformed.cssText = output;

    if (transformed.length) {
      return { status: 'invalid-became-valid', code: transformed.cssText };
    }

    const withFallback = freshStyle();

    withFallback.setProperty(property, 'initial');

    if (!withFallback.length) {
      return { status: 'baseline-unsupported-property' };
    }

    const fallback = withFallback.cssText;

    withFallback.setProperty(property, job.value);

    const transformedWithFallback = freshStyle();

    transformedWithFallback.cssText = fallback + ';' + output;

    return withFallback.cssText === transformedWithFallback.cssText
      ? { status: 'pass' }
      : {
          status: 'fallback-changed',
          original: withFallback.cssText,
          transformed: transformedWithFallback.cssText,
        };
  }

  /**
   * Longhands of a shorthand input, preseeded to `inherit`, must be reset by the output as they
   * are by the input.
   *
   * @param {string} output
   * @returns {string[]} Longhands the output leaves at `inherit`.
   */
  function longhandsNotReset(output) {
    const longhands = Array.prototype.slice.call(original);

    if (longhands.length <= 1) {
      return [];
    }

    const seededOriginal = freshStyle();
    const seededTransformed = freshStyle();

    longhands.forEach((name) => {
      seededOriginal.setProperty(name, 'inherit');
    });

    const before = seededOriginal.cssText;

    seededOriginal.setProperty(property, job.value);
    seededTransformed.cssText = before + ';' + output;

    return longhands.filter(
      (name) =>
        seededOriginal.getPropertyValue(name) !== 'inherit' &&
        seededTransformed.getPropertyValue(name) === 'inherit',
    );
  }

  /**
   * Specified values of the input and the output, for every property either sets.
   *
   * @param {CSSStyleDeclaration} transformed
   * @returns {{ property: string, original: string, transformed: string }[]} The differing ones.
   */
  function specifiedDifferences(transformed) {
    /** @type {Record<string, number>} */
    const names = {};

    Array.prototype.forEach.call(original, (name) => {
      names[name] = 1;
    });
    Array.prototype.forEach.call(transformed, (name) => {
      names[name] = 1;
    });
    names[property] = 1;

    return Object.keys(names)
      .map((name) => ({
        property: name,
        original: original.getPropertyValue(name),
        transformed: transformed.getPropertyValue(name),
      }))
      .filter((entry) => entry.original !== entry.transformed);
  }

  /**
   * Computed values of the differing properties in a fixed context (800x600, 16px serif, black).
   *
   * @param {CSSStyleDeclaration} transformed
   * @param {{ property: string }[]} differences
   * @returns {{ property: string, original: string, transformed: string }[]}
   */
  function computedValues(transformed, differences) {
    const root = /** @type {HTMLElement} */ (document.getElementById('lcr-root'));

    /**
     * @param {string} cssText
     * @returns {{ container: HTMLDivElement, element: HTMLDivElement }}
     */
    const mount = (cssText) => {
      const container = document.createElement('div');

      container.style.cssText = 'width:800px;height:600px;font:16px serif;color:black';

      const element = document.createElement('div');

      element.style.cssText = cssText;
      container.appendChild(element);
      root.appendChild(container);

      return { container, element };
    };
    const a = mount(original.cssText);
    const b = mount(transformed.cssText);
    const styleA = getComputedStyle(a.element);
    const styleB = getComputedStyle(b.element);
    const computed = differences.map((difference) => ({
      property: difference.property,
      original: styleA.getPropertyValue(difference.property),
      transformed: styleB.getPropertyValue(difference.property),
    }));

    a.container.remove();
    b.container.remove();

    return computed;
  }

  /**
   * Valid input: the output must stay valid and specify (or at least compute) the same values.
   *
   * @param {string} output
   * @returns {{ status: string } & Record<string, unknown>}
   */
  function judgeValidInput(output) {
    const transformed = freshStyle();

    transformed.cssText = output;

    if (!read) {
      return { status: transformed.length ? 'unsupported-input' : 'both-unsupported' };
    }

    if (!transformed.length) {
      return { status: 'valid-became-invalid' };
    }

    const differences = specifiedDifferences(transformed);
    const missing = longhandsNotReset(output);

    if (missing.length) {
      return { status: 'shorthand-reset-changed', properties: missing };
    }

    if (!differences.length) {
      return { status: 'pass' };
    }

    // Values that depend on the document (urls, variables, env()) cannot be compared here.
    if (/(?:url\(|var\(|env\()/i.test(output)) {
      return { status: 'context-required', differences };
    }

    const computed = computedValues(transformed, differences);
    const differs = computed.filter((entry) => entry.original !== entry.transformed);

    return differs.length
      ? { status: 'computed-difference', differences, computed }
      : { status: 'contextual-match', differences };
  }

  Object.keys(job.outputs).forEach((name) => {
    const output = job.outputs[name];

    if (output === null) {
      out.variants[name] = { status: 'no-output' };
    } else if (job.wptKind === 'invalid') {
      out.variants[name] = judgeInvalidInput(output);
    } else {
      out.variants[name] = judgeValidInput(output);
    }
  });

  return out;
}
/* eslint-enable max-lines-per-function */

module.exports = { pageProperty };
