import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { tempDir, withEnv, writeFiles } from '../../../test/helpers/index.js';
import {
  MUTATIONS,
  engineTargets,
  joinItems,
  mutate,
  mutationCases,
  mutationDom,
  propOf,
  splitDecls,
  splitTop,
} from '../mutations.js';

/** @import { CorpusCase } from '../../types.js' */

const CSS =
  '.a { margin: 0; margin-top: 5px; color: red !important }\n.b::before { content: "x;y}" }\n@media (min-width: 1px) { .c { color: blue } }\n';

/**
 * A minimal sheet parent case.
 *
 * @param {string} id
 * @param {Record<string, unknown>} request
 * @param {Record<string, unknown>} [extra]
 * @returns {CorpusCase}
 */
function parent(id, request, extra = {}) {
  return /** @type {CorpusCase} */ ({
    id,
    source: 'probe',
    request: { kind: 'sheet', ...request },
    ...extra,
  });
}

describe('splitting (py-final MutationsTest)', () => {
  test('strings are respected', () => {
    const items = splitTop(CSS);

    assert.ok(items);
    assert.deepEqual(
      items.map((item) => item.kind),
      ['rule', 'rule', 'at-block'],
    );
    assert.deepEqual(splitDecls(/** @type {string} */ (items[1].body)), ['content: "x;y}"']);
  });

  test('unsplittable sheets give null', () => {
    for (const css of ['.a { color: red', '.a{}}', '/* open', '.a{} trailing']) {
      assert.equal(splitTop(css), null, css);
    }

    assert.deepEqual(splitTop('  /* c */  '), []);
  });

  test('statements, comments and nested blocks', () => {
    assert.deepEqual(splitTop('@import "a;b";\n/* x */ .a { b: c }'), [
      { kind: 'at-stmt', prelude: '@import "a;b"', body: null },
      { kind: 'rule', prelude: '.a', body: ' b: c ' },
    ]);
    assert.equal(splitDecls('a: b; .x { c: d }'), null, 'nested rules are not flat');
    assert.equal(splitDecls('a: b; junk'), null, 'every item needs a colon');
    assert.deepEqual(splitDecls('a: url(x;y); /* c; */ b: [;]'), ['a: url(x;y)', 'b: [;]']);
  });

  test('joinItems writes one item per line', () => {
    assert.equal(
      joinItems([
        { kind: 'at-stmt', prelude: '@layer a', body: null },
        { kind: 'rule', prelude: '.a', body: '  b: c  ' },
      ]),
      '@layer a;\n.a { b: c }\n',
    );
  });

  test('propOf splits off !important in any case', () => {
    assert.deepEqual(propOf(' color : red ! IMPORTANT '), ['color', 'red', true]);
    // Python's re.IGNORECASE also folds the dotless i.
    assert.deepEqual(propOf(`a: b !${String.fromCodePoint(0x131)}mportant`), ['a', 'b', true]);
    assert.deepEqual(propOf('a: b'), ['a', 'b', false]);
  });
});

describe('mutate (py-final MutationsTest)', () => {
  test('each mutation is deterministic', () => {
    for (const mutation of MUTATIONS) {
      if (!mutation.startsWith('retarget')) {
        assert.equal(mutate(CSS, mutation), mutate(CSS, mutation), mutation);
      }
    }
  });

  test('reverse and wrap', () => {
    assert.ok(
      mutate(CSS, 'reverse-decls')?.includes('.a { color: red !important; margin-top: 5px; margin: 0 }'),
    );
    assert.equal(mutate("@import 'a.css';\n.a{color:red}", 'wrap-media'), null);
  });

  test('unparseable input is skipped', () => {
    assert.equal(mutate('.a { color: red', 'important'), null);
  });

  test('every text mutation on a small sheet', () => {
    const css = '.a { color: red; --x: 1 }';

    assert.equal(mutate(css, 'important'), '.a { color: red !important; --x: 1 !important }\n');
    assert.equal(mutate(css, 'var-before'), '.a { color: var(--lcr-unset, red); color: red; --x: 1 }\n');
    assert.equal(mutate(css, 'var-after'), '.a { color: red; color: var(--lcr-unset, red); --x: 1 }\n');
    assert.equal(mutate(css, 'upper-props'), '.a { COLOR: red; --x: 1 }\n');
    assert.equal(mutate(css, 'wrap-layer'), '@layer lcr {\n.a { color: red; --x: 1 }\n}\n');
    assert.equal(mutate(css, 'nest'), '.lcr-n { .a { color: red; --x: 1 } }\n');
    assert.equal(
      mutate(css, 'duplicate-nonadjacent'),
      '.a { color: red; --x: 1 }\n.lcr-sep { color: inherit }\n.a { color: red; --x: 1 }\n',
    );
    assert.equal(mutate(css, 'retarget-modern'), null);
  });

  test('nest leaves root and nested rules alone', () => {
    assert.equal(mutate(':root { --a: 1 }\n& .b { c: d }', 'nest'), ':root { --a: 1 }\n& .b { c: d }\n');
    assert.equal(mutate('@media x { .a { b: c } }', 'nest'), null, 'no top-level rule');
  });

  test('prefixed-sibling adds -webkit- copies of prefixed properties only', () => {
    assert.equal(
      mutate('.a { user-select: none; color: red }', 'prefixed-sibling'),
      '.a { -webkit-user-select: none; user-select: none; color: red }\n',
    );
    assert.equal(mutate('.a { color: red }', 'prefixed-sibling'), null);
  });

  test('top-only statements block wrapping, case-insensitively', () => {
    for (const css of ['@IMPORT "a";.b{c:d}', '@layer x;.b{c:d}', '@namespace svg url(x);.b{c:d}']) {
      assert.equal(mutate(css, 'wrap-supports'), null, css);
    }

    assert.ok(mutate('@layers x;.b{c:d}', 'wrap-supports'), 'a longer name is another at-rule');
  });
});

describe('value-prefixed-sibling (py-final ValuePrefixedSiblingTest)', () => {
  const run = (/** @type {string} */ css) => mutate(css, 'value-prefixed-sibling');

  test('prefixed values go before the unprefixed one', () => {
    assert.equal(
      run('.a { display: flex }'),
      '.a { display: -webkit-box; display: -ms-flexbox; display: flex }\n',
    );
    assert.equal(
      run('.a { display: inline-flex }'),
      '.a { display: -webkit-inline-box; display: -ms-inline-flexbox; display: inline-flex }\n',
    );
    assert.equal(
      run('.a { position: sticky !important; top: 0 }'),
      '.a { position: -webkit-sticky !important; position: sticky !important; top: 0 }\n',
    );
  });

  test('lone prefixed values get the unprefixed one after', () => {
    assert.equal(
      run('.a { display: -webkit-box; display: -ms-flexbox }'),
      '.a { display: -webkit-box; display: -ms-flexbox; display: flex }\n',
    );
    assert.equal(
      run('.a { position: -webkit-sticky }'),
      '.a { position: -webkit-sticky; position: sticky }\n',
    );
  });

  test('no change is null', () => {
    assert.equal(run('.a { display: -webkit-box; display: -ms-flexbox; display: flex }'), null);
    assert.equal(run('.a { display: block; color: red }'), null);
    assert.equal(run('.a { display: flex'), null);
  });

  test('registered as a mutation', () => {
    const ids = mutationCases([parent('p-a/x', { css: '.a { display: flex }' })]).map((c) => c.id);

    assert.ok(ids.includes('m-p-a/x-value-prefixed-sibling'));
    assert.ok(!ids.includes('m-p-a/x-prefixed-sibling'));
  });
});

describe('mutationCases', () => {
  test('nest wraps the dom override (py-final MutationDomTest)', () => {
    const cases = new Map(
      mutationCases([
        parent(
          'p-color/x',
          { css: '.a { color: red }', minify: true },
          { probe: { area: 'color', dom: '<div class="a">x</div>' }, timeout: 30 },
        ),
      ]).map((c) => [/** @type {{ mutation: string }} */ (c).mutation, c]),
    );

    assert.equal(
      /** @type {{ dom?: string }} */ (cases.get('nest')).dom,
      '<div class="lcr-n"><div class="a">x</div></div>',
    );
    assert.ok(!('dom' in /** @type {object} */ (cases.get('important'))));
    assert.equal(cases.get('important')?.timeout, 30);
    assert.equal(mutationDom(null, 'nest'), null);
  });

  test('retargets need minify and differ from the parent targets', () => {
    using cache = tempDir();
    using _env = withEnv({ LCR_CACHE: cache.path });
    const request = {
      css: '.a{b:c}',
      minify: true,
      targets: null,
      include: 1,
      exclude: 2,
      printer_targets: null,
    };
    const cases = mutationCases([parent('t-x', request)]);
    const retargeted = cases.filter((c) =>
      /** @type {{ mutation: string }} */ (c).mutation.startsWith('retarget'),
    );

    assert.deepEqual(
      retargeted.map((c) => c.id),
      ['m-t-x-retarget-modern', 'm-t-x-retarget-legacy'],
    );
    assert.ok(retargeted.every((c) => !('include' in c.request) && !('printer_targets' in c.request)));
    assert.equal(/** @type {{ area: unknown }} */ (cases[0]).area, null, 'tuple parents have no area');
    assert.equal(
      mutationCases([parent('t-y', { ...request, minify: false })]).filter((c) => c.id.includes('retarget'))
        .length,
      0,
    );
  });

  test('CSS modules, other kinds and empty CSS are no parents; at most `limit` parents', () => {
    const cases = mutationCases(
      [
        parent('a', { css: '.a{b:c}', css_modules: {} }),
        parent('b', { css: '' }),
        /** @type {CorpusCase} */ ({ id: 'c', source: 'tuple', request: { kind: 'value', value: 'x' } }),
        parent('e', { css: '.a{b:c}', css_modules: null }),
        parent('d', { css: '.a{b:c}' }),
      ],
      1,
    );

    assert.deepEqual([...new Set(cases.map((c) => /** @type {{ parent: string }} */ (c).parent))], []);
    assert.deepEqual(
      [
        ...new Set(
          mutationCases(
            [parent('e', { css: '.a{b:c}', css_modules: null }), parent('d', { css: '.a{b:c}' })],
            1,
          ).map((c) => /** @type {{ parent: string }} */ (c).parent),
        ),
      ],
      ['d'],
      'parents are taken in id order; a null css_modules means off',
    );
  });

  test('engine retargets come from the legacy profiles of env.json', () => {
    using cache = tempDir();
    using _env = withEnv({ LCR_CACHE: cache.path });

    writeFiles(cache.path, {
      'env.json': {
        profiles: {
          'legacy-b': {
            role: 'legacy',
            versions: { chromium: '97.0.4692.20', firefox: '93.0', webkit: '15.4' },
          },
          'legacy-a': { role: 'legacy', versions: { firefox: 'nightly', webkit: '16' } },
          latest: { role: 'reference', versions: { chromium: '140.0' } },
          empty: { role: 'legacy', versions: { chromium: 'x' } },
        },
      },
    });

    assert.deepEqual(
      [...engineTargets()],
      [
        ['engine-legacy-a', { safari: 16 << 16 }],
        ['engine-legacy-b', { chrome: (97 << 16) | 255, firefox: 93 << 16, safari: (15 << 16) | (4 << 8) }],
      ],
    );

    const names = mutationCases([parent('p-x', { css: '.a{b:c}', minify: true })]).map(
      (c) => /** @type {{ mutation: string }} */ (c).mutation,
    );

    assert.deepEqual(names.slice(-2), ['engine-legacy-a', 'engine-legacy-b']);
  });
});
