import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { tempDir } from '../../test/helpers/index.js';
import { errorText, jobsForEngine, printVersions, runEngine } from '../runner/engines.cjs';
import { SKELETON } from '../runner/page/document.cjs';
import { pageProperty } from '../runner/page/property.cjs';
import { pageSnapshot } from '../runner/page/snapshot.cjs';
import { clearStyle, showVariant } from '../runner/page/visual.cjs';
import { shotFile } from '../runner/shots.cjs';

// The browsers are faked: these tests cover the job loop, not the in-page functions (those run
// in real engines in the oracle parity checks).
/** @type {(value: unknown) => any} */
const loose = (value) => value;

/**
 * A fake Playwright whose pages answer `evaluate` through `behave` and log every call.
 *
 * @param {(fn: (...args: any[]) => unknown, arg: unknown, page: number) => unknown} behave
 * @returns {{ playwright: any, calls: string[] }}
 */
function fakePlaywright(behave) {
  /** @type {string[]} */
  const calls = [];
  let pages = 0;
  const newPage = async () => {
    const page = ++pages;

    return {
      setContent: async (/** @type {string} */ html) => calls.push(`setContent:${page}:${html === SKELETON}`),
      evaluate: async (/** @type {(...args: any[]) => unknown} */ fn, /** @type {unknown} */ arg) => {
        calls.push(`evaluate:${page}:${fn.name || 'anonymous'}`);

        return behave(fn, arg, page);
      },
      emulateMedia: async (/** @type {{ colorScheme: string }} */ media) =>
        calls.push(`emulateMedia:${media.colorScheme}`),
      $: async () => ({ screenshot: async () => Buffer.from('png') }),
      close: async () => calls.push(`close:${page}`),
    };
  };
  const browserType = {
    launch: async () => ({
      version: () => '1.2.3',
      newContext: async () => ({ newPage }),
      close: async () => calls.push('browser.close'),
    }),
  };

  return { playwright: { chromium: browserType, webkit: browserType }, calls };
}

/** @returns {{ rows: any[], write: (row: unknown) => void, end: () => Promise<void> }} */
function collector() {
  /** @type {any[]} */
  const rows = [];

  return { rows, write: (row) => rows.push(row), end: async () => {} };
}

describe('jobsForEngine', () => {
  test('filters by `engines` and narrows lowering jobs to the engine', () => {
    const jobs = loose([
      { id: 'a', kind: 'sheet', engines: ['webkit'] },
      {
        id: 'b',
        kind: 'sheet',
        propsByEngine: { chromium: ['color'] },
        keysByEngine: { chromium: ['div#0'] },
      },
      { id: 'c', kind: 'sheet', propsByEngine: {} },
    ]);
    const chromium = jobsForEngine(jobs, 'chromium');

    assert.deepEqual(
      chromium.map((job) => job.id),
      ['b', 'c'],
    );
    assert.deepEqual([loose(chromium[0]).props, loose(chromium[0]).keys], [['color'], ['div#0']]);
    assert.deepEqual([loose(chromium[1]).props, loose(chromium[1]).keys], [[], null]);
    assert.equal(jobsForEngine(jobs, 'webkit')[0], jobs[0]);
  });
});

describe('runEngine', () => {
  test('one row per job with result, id, engine, version and timing, in that order', async () => {
    const { playwright, calls } = fakePlaywright((fn) => ({ from: fn.name }));
    const out = collector();
    const jobs = loose([
      { id: 's', kind: 'sheet', sheets: { input: '' } },
      { id: 'p', kind: 'property' },
      { id: 'd', kind: 'sheet', sheets: {}, colorScheme: 'dark' },
    ]);

    await runEngine(playwright, 'chromium', jobs, out, null);

    assert.deepEqual(
      out.rows.map((row) => Object.keys(row)),
      [
        ['result', 'id', 'engine', 'version', 'ms'],
        ['result', 'id', 'engine', 'version', 'ms'],
        ['result', 'id', 'engine', 'version', 'ms'],
      ],
    );
    assert.deepEqual(
      out.rows.map((row) => [row.result.from, row.id, row.engine, row.version]),
      [
        ['pageSnapshot', 's', 'chromium', '1.2.3'],
        ['pageProperty', 'p', 'chromium', '1.2.3'],
        ['pageSnapshot', 'd', 'chromium', '1.2.3'],
      ],
    );
    assert.deepEqual(calls.slice(-4), [
      'emulateMedia:dark',
      'evaluate:1:pageSnapshot',
      'emulateMedia:light',
      'browser.close',
    ]);
  });

  test('a failing job records its error and gets a fresh page; the next job runs there', async () => {
    const { playwright, calls } = fakePlaywright((fn, _arg, page) => {
      if (page === 1) {
        throw new Error('Target crashed\nline 2\nline 3\nline 4');
      }

      return { ok: fn.name };
    });
    const out = collector();

    await runEngine(
      playwright,
      'webkit',
      loose([
        { id: 'a', kind: 'sheet', sheets: {} },
        { id: 'b', kind: 'sheet', sheets: {} },
      ]),
      out,
      null,
    );

    assert.deepEqual(out.rows[0].error, 'Target crashed line 2 line 3');
    assert.deepEqual(Object.keys(out.rows[0]), ['error', 'id', 'engine', 'version', 'ms']);
    assert.deepEqual(out.rows[1].result, { ok: 'pageSnapshot' });
    assert.ok(calls.includes('close:1') && calls.includes('setContent:2:true'));
  });

  test('visual jobs screenshot every non-empty variant; a screenshot failure keeps the styles', async () => {
    using dir = tempDir();
    const { playwright, calls } = fakePlaywright((fn) =>
      fn === pageSnapshot ? { styles: true } : undefined,
    );
    const out = collector();
    const job = loose({
      id: 'p-a/b',
      kind: 'sheet',
      html: '<div></div>',
      visual: true,
      sheets: { empty: '', input: 'i', head: 'h' },
    });

    await runEngine(playwright, 'chromium', [job], out, dir.path);

    const hash = createHash('sha256').update('png').digest('hex').slice(0, 16);

    assert.deepEqual(out.rows[0].shots, { input: hash, head: hash });
    assert.deepEqual(Object.keys(out.rows[0]), ['result', 'shots', 'id', 'engine', 'version', 'ms']);
    assert.equal(readFileSync(shotFile(dir.path, 'p-a/b', 'chromium', 'head'), 'utf8'), 'png');
    assert.deepEqual(
      calls.filter((call) => call.startsWith('evaluate')),
      [
        'evaluate:1:pageSnapshot',
        'evaluate:1:showVariant',
        'evaluate:1:showVariant',
        'evaluate:1:clearStyle',
      ],
    );

    const failing = fakePlaywright((fn) => {
      if (fn === showVariant) {
        throw new Error('screenshot timeout\nmore');
      }

      return { styles: true };
    });
    const failed = collector();

    await runEngine(failing.playwright, 'chromium', [job], failed, dir.path);

    assert.deepEqual(
      [failed.rows[0].result, failed.rows[0].visualError, failed.rows[0].shots],
      [{ styles: true }, 'screenshot timeout', undefined],
    );
  });

  test('without a screenshots directory no screenshots are taken', async () => {
    const { playwright, calls } = fakePlaywright(() => ({}));

    await runEngine(
      playwright,
      'chromium',
      loose([{ id: 'v', kind: 'sheet', visual: true, sheets: { input: '' } }]),
      collector(),
      null,
    );

    assert.ok(!calls.some((call) => call.includes('showVariant') || call.includes('clearStyle')));
  });
});

describe('printVersions', () => {
  test('prints one JSON line; an engine that fails to launch reports its first error line', async (t) => {
    const { playwright } = fakePlaywright(() => null);
    const writes = t.mock.method(process.stdout, 'write', () => true);

    playwright.firefox = { launch: async () => Promise.reject(new Error('no browser\ndetails')) };
    await printVersions(playwright, ['chromium', 'firefox']);

    const printed = JSON.parse(String(writes.mock.calls[0].arguments[0]));

    writes.mock.restore();
    assert.deepEqual(Object.keys(printed), ['playwright', 'node', 'chromium', 'firefox']);
    assert.deepEqual(
      [printed.chromium, printed.firefox, printed.node],
      ['1.2.3', 'ERROR: no browser', process.version],
    );
  });
});

describe('page functions', () => {
  test('are self-contained functions Playwright can serialize', () => {
    for (const fn of [pageSnapshot, pageProperty, showVariant, clearStyle]) {
      assert.equal(typeof fn, 'function');
      // Serialized with toString() and evaluated in the page: it must parse on its own.
      assert.doesNotThrow(() => new Function(`return (${fn.toString()})`));
    }
  });

  test('errorText keeps the first lines of a message', () => {
    assert.equal(errorText(new Error('a\nb\nc'), 2), 'a b');
    assert.equal(errorText('plain', 1), 'plain');
  });
});
