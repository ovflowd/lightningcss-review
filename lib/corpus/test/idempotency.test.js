import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { tempDir } from '../../../test/helpers/index.js';
import { pyFloat } from '../../core/pyjson.js';
import { idempotency, idempotencyRequests, idempotencySplit, timeoutOption } from '../idempotency.js';
import { fakeAdapter } from './support.js';

/** @import { CorpusCase, AdapterResponse } from '../../types.js' */

// The stand-in adapters are host scripts: run them the way LCR_BUILD=host runs a real adapter,
// not in a sandbox container (unit tests use no Docker).
process.env.LCR_BUILD = 'host';

describe('idempotency', () => {
  test('the split is base-aware', () => {
    const head = {
      new: { stable: false, second: null },
      pre: { stable: false, second: null },
      fixed: { stable: true, second: null },
      'only-head': { stable: false, second: null },
    };
    const base = {
      new: { stable: true, second: null },
      pre: { stable: false, second: null },
      fixed: { stable: false, second: null },
    };

    assert.deepEqual(idempotencySplit(head, base), [['new', 'only-head'], ['pre']]);
  });

  test('a print-mode probe that expects idempotent is re-run', () => {
    const cases = /** @type {CorpusCase[]} */ (
      /** @type {unknown} */ ([
        { id: 'p', request: { kind: 'sheet', css: 'a', minify: false }, probe: { expect: ['idempotent'] } },
        { id: 'q', request: { kind: 'sheet', css: 'a', minify: false }, probe: { expect: [] } },
        { id: 'm', request: { kind: 'sheet', css: 'a', minify: true, css_modules: {} } },
        { id: 'n', request: { kind: 'sheet', css: 'a', minify: true, css_modules: null }, timeout: 5 },
        { id: 'v', request: { kind: 'value', value: 'a', minify: true } },
        { id: 'f', request: { kind: 'sheet', css: 'a', minify: true } },
      ])
    );
    const outs = /** @type {Record<string, AdapterResponse>} */ (
      Object.fromEntries(['p', 'q', 'm', 'n', 'v'].map((id) => [id, { id, ok: true, code: 'x' }]))
    );

    outs.f = { id: 'f', ok: false };

    const requests = idempotencyRequests(cases, outs);

    assert.deepEqual(
      requests.map((request) => request.id),
      ['p', 'n'],
    );
    assert.deepEqual(requests[1], {
      id: 'n',
      kind: 'sheet',
      css: 'x',
      minify: true,
      css_modules: null,
      _timeout: 5,
    });
  });

  test("the second pass runs through that side's adapter", async () => {
    using dir = tempDir();

    fakeAdapter(join(dir.path, 'bin'), 'head-adapter');

    const cases = /** @type {CorpusCase[]} */ (
      /** @type {unknown} */ ([
        { id: 'a', request: { kind: 'sheet', css: 'x', minify: true } },
        { id: 'b', request: { kind: 'sheet', css: 'y', minify: true } },
      ])
    );
    const outs = /** @type {Record<string, AdapterResponse>} */ ({
      a: { id: 'a', ok: true, code: '.a { b: c }' },
      b: { id: 'b', ok: true, code: '.a {  b: c }' },
    });

    assert.deepEqual(await idempotency(dir.path, cases, outs, 'head'), {
      a: { stable: true, second: '.a { b: c }' },
      b: { stable: false, second: '.a { b: c }' },
    });
    assert.deepEqual(await idempotency(dir.path, [], outs, 'head'), {});
  });

  test('a probe timeout reaches the client as a Python float', async () => {
    using dir = tempDir();

    fakeAdapter(join(dir.path, 'bin'), 'head-adapter');

    const timeout = pyFloat(1);
    const cases = /** @type {CorpusCase[]} */ (
      /** @type {unknown} */ ([{ id: 'slow', request: { kind: 'sheet', css: 'x', minify: true }, timeout }])
    );
    const outs = /** @type {Record<string, AdapterResponse>} */ ({
      slow: { id: 'slow', ok: true, code: '.hang-me {}' },
    });

    assert.equal(timeoutOption(cases[0])._timeout, timeout);
    // The timeout is a float, so `timeout: 1` times out as `1.0s`, never `1s`.
    assert.deepEqual(await idempotency(dir.path, cases, outs, 'head'), {
      slow: { stable: false, second: 'no response within 1.0s' },
    });
  });
});
