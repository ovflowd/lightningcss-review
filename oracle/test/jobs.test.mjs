import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { caseIdOf, legacyJob, propertyJob, sheetJob, touchedByJob } from '../lib/jobs.mjs';

/** @import { SheetCase, SheetJob } from '../lib/types.mjs' */

/**
 * @param {Partial<SheetCase> & { sheets: SheetCase['sheets'] }} fields
 * @returns {SheetCase}
 */
const sheetCase = (fields) => ({ id: 'c', kind: 'sheet', ...fields });

describe('sheetJob', () => {
  test('a dom: override still reads the pseudo-elements the sheets use', () => {
    const { jobs, meta } = sheetJob(
      sheetCase({
        id: 'p-x/y',
        sheets: {
          input: '.a::after{content:"x";color:red}',
          base: '.a:after{content:"x";color:red}',
          head: '.a:after{content:"x";color:#00f}',
        },
        dom: '<div class="a">x</div>',
      }),
    );
    const job = /** @type {SheetJob} */ (jobs[0]);

    assert.equal(job.html, '<div class="a">x</div>');
    assert.deepEqual(job.pseudos, ['::after']);
    assert.deepEqual(meta.dom, {
      selectors: 0,
      synthesized: 0,
      unsupported: 0,
      generic: false,
      override: true,
      focused: false,
    });
  });

  test('custom properties referenced but never defined get a stand-in in every sheet', () => {
    const { jobs, meta } = sheetJob(
      sheetCase({
        id: 't',
        sheets: {
          input: '.a{margin:var(--x);color:var(--c);padding:var(--y, 1px)}',
          base: '.a{margin:var(--x)}',
          head: '.a{margin:var(--x)}',
        },
      }),
    );
    const job = /** @type {SheetJob} */ (jobs[0]);

    assert.deepEqual(meta.injectedVars, ['--c', '--x']);

    for (const name of ['empty', 'input', 'base', 'head']) {
      assert.match(job.sheets[name], /:root\{--c:rgb\(1, 2, 3\);--x:5px\}$/);
    }

    const defined = sheetJob(
      sheetCase({ id: 'u', sheets: { input: ':root{--x:1px}.a{margin:var(--x)}', base: '', head: '' } }),
    );

    assert.equal(/** @type {SheetJob} */ (defined.jobs[0]).sheets.empty, '');
  });

  test('sides whose text is the input up to whitespace and comments are listed in sameAsInput', () => {
    const css = '.t { display: inline-flex; display: -ms-inline-flexbox; }\n';
    const { jobs } = sheetJob(
      sheetCase({
        id: 's',
        sheets: {
          input: css,
          base: '.t{display:-ms-inline-flexbox}',
          head: '.t{display:inline-flex;display:-ms-inline-flexbox}',
        },
      }),
    );

    assert.deepEqual(/** @type {SheetJob} */ (jobs[0]).sameAsInput, ['head']);
  });

  test('job layout: empty sheet first, sheets after state rewriting, probes per sheet, missing sides skipped', () => {
    const { jobs, meta } = sheetJob(
      sheetCase({
        sheets: { input: '.a:hover{color:red}', base: null, head: '.a:hover{color:red}' },
        visual: true,
      }),
    );

    assert.deepEqual(Object.keys(jobs[0]), [
      'id',
      'kind',
      'html',
      'rootAttrs',
      'pseudos',
      'sheets',
      'probe',
      'reference',
      'visual',
      'sameAsInput',
    ]);

    const job = /** @type {SheetJob} */ (jobs[0]);

    assert.deepEqual(job.sheets, {
      empty: '',
      input: '.a[data-lcr-hover]{color:red}',
      head: '.a[data-lcr-hover]{color:red}',
    });
    assert.deepEqual(Object.keys(job.probe), ['input', 'head']);
    assert.equal(job.visual, true);
    assert.equal(meta.rewrites, 2);
  });

  test('color-scheme dependent CSS adds a ~dark twin without screenshots', () => {
    const { jobs, meta } = sheetJob(
      sheetCase({
        id: 'd',
        sheets: { input: '.a{color:light-dark(red, blue)}', base: '', head: '' },
        visual: true,
      }),
    );

    assert.deepEqual(
      jobs.map((job) => [
        job.id,
        /** @type {SheetJob} */ (job).colorScheme,
        /** @type {SheetJob} */ (job).visual,
      ]),
      [
        ['d', undefined, true],
        ['d~dark', 'dark', false],
      ],
    );
    assert.equal(meta.dark, true);
  });

  test('domFrom synthesizes from the changed blocks only', () => {
    const { jobs, meta } = sheetJob(
      sheetCase({
        sheets: { input: '.a{color:red}.b{color:red}', base: '', head: '' },
        domFrom: '.b{color:red}',
      }),
    );

    assert.match(/** @type {SheetJob} */ (jobs[0]).html, /class="b"/);
    assert.doesNotMatch(/** @type {SheetJob} */ (jobs[0]).html, /class="a"/);
    assert.equal(meta.dom?.focused, true);
  });
});

describe('propertyJob', () => {
  test('passes a parsing case through, dropping what the engines do not need', () => {
    const { jobs, meta } = propertyJob({
      id: 'w-1',
      kind: 'property',
      property: 'color',
      value: 'red',
      wptKind: 'valid',
      outputs: { base: 'color:red', head: null },
      targets: null,
    });

    assert.deepEqual(
      JSON.stringify(jobs[0]),
      '{"id":"w-1","kind":"property","property":"color","value":"red","wptKind":"valid","outputs":{"base":"color:red","head":null}}',
    );
    assert.deepEqual(meta, { id: 'w-1' });
  });
});

describe('legacy jobs', () => {
  test('touchedByJob collects sorted properties and element keys per engine', async () => {
    const rows = [
      {
        id: 'a',
        engine: 'webkit',
        result: {
          variants: {
            input: { touched: { 'div#1': { width: '1px', color: 'red' }, 'div#0': { color: 'red' } } },
          },
        },
      },
      { id: 'a', engine: 'chromium', result: { variants: { input: {} } } },
      { id: 'b', engine: 'webkit', error: 'boom' },
    ];
    const touched = await touchedByJob(rows);

    assert.deepEqual([...touched.keys()], ['a']);
    assert.deepEqual(touched.get('a'), {
      props: { webkit: ['color', 'width'], chromium: [] },
      keys: { webkit: ['div#0', 'div#1'], chromium: [] },
    });
  });

  test('legacyJob narrows the job and turns screenshots off', () => {
    const { jobs } = sheetJob(
      sheetCase({ sheets: { input: '.a{color:red}', base: '', head: '' }, visual: true }),
    );
    const job = legacyJob(/** @type {SheetJob} */ (jobs[0]), {
      props: { webkit: ['color'] },
      keys: { webkit: ['div#0'] },
    });

    assert.equal(job.visual, false);
    assert.deepEqual(Object.keys(job).slice(-2), ['propsByEngine', 'keysByEngine']);
  });

  test('caseIdOf strips the dark suffix only at the end', () => {
    assert.equal(caseIdOf('p-a/b~dark'), 'p-a/b');
    assert.equal(caseIdOf('p-a~dark/b'), 'p-a~dark/b');
  });
});
