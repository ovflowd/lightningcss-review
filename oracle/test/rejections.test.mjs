import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { compactSelector, foreignPrefix, sideRejections, squash } from '../lib/rejections.mjs';

/** @import { ValidityProbe, ProbeDecl } from '../lib/types.mjs' */

/**
 * @param {Partial<ValidityProbe>} fields
 * @returns {ValidityProbe}
 */
const probe = (fields) => ({ decls: [], selectors: [], preludes: [], parsed: true, ...fields });

describe('sideRejections', () => {
  test('a longhand whose value the input carried in a rejected shorthand is marked carrierRejected', () => {
    const probes = {
      input: probe({ decls: [['animation', 'a 1s scroll(nearest)', false]] }),
      head: probe({
        decls: /** @type {ProbeDecl[]} */ ([
          ['animation', 'a 1s', false],
          ['animation-timeline', 'scroll( nearest )', false],
          ['animation-delay', '2s', false],
        ]),
      }),
    };
    const rejected = sideRejections(
      probes,
      'head',
      { decls: [true, false, false] },
      { decls: [false] },
      'firefox',
    );

    assert.equal(rejected.decls.find((d) => d.prop === 'animation-timeline')?.carrierRejected, true);
    assert.equal(rejected.decls.find((d) => d.prop === 'animation-delay')?.carrierRejected, undefined);
  });

  test('custom properties, foreign prefixes and parts the input already had rejected are not reported', () => {
    const decls = /** @type {ProbeDecl[]} */ ([
      ['--x', '{', false],
      ['-moz-appearance', 'none', false],
      ['color', 'rde', false],
      ['width', 'bogus', false],
    ]);
    const probes = { input: probe({ decls: [['color', 'rde', false]] }), base: probe({ decls }) };
    const rejected = sideRejections(
      probes,
      'base',
      { decls: [false, false, false, false] },
      { decls: [false] },
      'chromium',
    );

    assert.deepEqual(rejected.decls, [
      { prop: 'width', value: 'bogus', important: false, fallbackSurvives: false, inInput: false },
    ]);
  });

  test('a rejected member of a fallback chain is soft when another declaration survives', () => {
    const probes = {
      head: probe({
        decls: /** @type {ProbeDecl[]} */ ([
          ['display', 'flex', false],
          ['display', 'grid-lanes', false],
        ]),
      }),
    };
    const rejected = sideRejections(probes, 'head', { decls: [true, false] }, {}, 'webkit');

    assert.equal(rejected.decls[0].fallbackSurvives, true);
  });

  test('selectors and preludes the output alone makes the engine reject', () => {
    const probes = {
      input: probe({ selectors: [':is(.a)'], preludes: [['media', '(width >= 1px)']] }),
      head: probe({
        selectors: [':is(.a)', '.b:lang(ae, ar, arc, bcc, he)', '.c::-moz-selection'],
        preludes: [
          ['media', '(width >= 1px)'],
          ['supports', 'selector(:has(a))'],
        ],
      }),
    };
    const rejected = sideRejections(
      probes,
      'head',
      { selectors: [false, false, false], preludes: [false, false] },
      { selectors: [false], preludes: [false] },
      'webkit',
    );

    assert.deepEqual(rejected.selectors, ['.b:lang(<5 languages>)']);
    assert.deepEqual(rejected.preludes, [['supports', 'selector(:has(a))']]);
  });
});

describe('helpers', () => {
  test('long :lang() lists are stored as a count', () => {
    assert.equal(compactSelector('.a:lang(ae, ar, arc, bcc, he)'), '.a:lang(<5 languages>)');
    assert.equal(compactSelector('.a:lang(en)'), '.a:lang(en)');
    assert.equal(compactSelector('.a:lang(ae, ar, arc, bcc)'), '.a:lang(ae, ar, arc, bcc)');
  });

  test('squash normalizes case and spacing around ( ) , /', () => {
    assert.equal(squash(' Scroll( Nearest ,  Y ) / 2 '), 'scroll(nearest,y)/2');
    assert.equal(squash(null), '');
  });

  test('foreign prefixes per engine', () => {
    assert.ok(foreignPrefix('chromium').test('-moz-x'));
    assert.ok(!foreignPrefix('chromium').test('-webkit-x'));
    assert.ok(foreignPrefix('firefox').test('-webkit-x'));
    assert.ok(!foreignPrefix('other').test('-moz-x'));
  });
});
