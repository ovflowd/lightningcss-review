import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { tempDir } from '../../../test/helpers/index.js';
import { pyFloat } from '../../core/pyjson.js';
import { AdapterProcess, runRequests } from '../client.js';
import { hostAdapter } from '../sandbox.js';

// A stand-in for the JSONL adapter, in Node: echoes the CSS as the
// output. `hang` leaves a grandchild holding stdout open for a while (so the killed process's EOF
// arrives late) and never answers; `sleep:<s>` answers after <s> seconds; `abort` kills itself
// with SIGABRT; `garbage` answers with a line that is not JSON; `exit:<n>` exits with status n;
// `noeol` writes a non-JSON line without a line break and exits.
const FAKE_ADAPTER = `#!/usr/bin/env node
const { spawn } = require('child_process');
const queue = [];
let busy = false;
let buffer = '';
// Split on \\n only, as the Rust adapter does: requests may hold a raw U+2028.
process.stdin.setEncoding('utf8').on('data', (chunk) => {
  const lines = (buffer + chunk).split('\\n');
  buffer = lines.pop();
  queue.push(...lines);
  pump();
});
function pump() {
  if (busy || queue.length === 0) return;
  busy = true;
  const req = JSON.parse(queue.shift());
  const css = req.css || '';
  const answer = () => {
    process.stdout.write(JSON.stringify({ id: req.id, ok: true, code: css.replace('  ', ' '), seen: Object.keys(req) }) + '\\n');
    busy = false;
    pump();
  };
  if (css === 'hang') { spawn('sleep', ['1.5'], { stdio: ['ignore', 'inherit', 'ignore'] }); return; }
  if (css === 'abort') { process.kill(process.pid, 'SIGABRT'); return; }
  if (css === 'garbage') { process.stdout.write('not json\\n'); busy = false; pump(); return; }
  if (css === 'noeol') { process.stdout.write('not json', () => process.exit(0)); return; }
  if (css.startsWith('exit:')) { process.exit(Number(css.slice(5))); }
  if (css.startsWith('sleep:')) { setTimeout(answer, Number(css.slice(6)) * 1000); return; }
  answer();
}
`;

/**
 * A `sheet` request.
 *
 * @param {string} id
 * @param {string} css
 * @param {number} [timeout] `_timeout` in seconds.
 * @returns {import('../client.js').IdentifiedRequest}
 */
function sheet(id, css, timeout) {
  return timeout === undefined ? { id, kind: 'sheet', css } : { id, kind: 'sheet', css, _timeout: timeout };
}

/**
 * The stand-in, run on the host.
 *
 * @param {string} dir
 * @returns {import('../sandbox.js').Adapter}
 */
function fakeAdapter(dir) {
  const path = join(dir, 'adapter');

  writeFileSync(path, FAKE_ADAPTER);
  chmodSync(path, 0o755);

  return hostAdapter(path);
}

describe('AdapterProcess', () => {
  test('a restart after a timeout does not hang on the old process', async () => {
    using dir = tempDir();
    const adapter = new AdapterProcess(fakeAdapter(dir.path), pyFloat(0.5));

    try {
      assert.equal((await adapter.request({ id: '1', css: 'hang' })).stage, 'timeout');
      assert.equal((await adapter.request({ id: '2', css: 'a' })).ok, true);
      // The killed adapter's grandchild closes its stdout now; it must not reach the new process.
      await sleep(2000);

      const started = Date.now();

      assert.equal((await adapter.request({ id: '3', css: 'b' })).ok, true);
      assert.ok(Date.now() - started < 2000);
      assert.equal(adapter.restarts, 1);
    } finally {
      await adapter.close();
    }
  });

  test('crashes, aborts and protocol errors become error responses with fixed wording', async () => {
    using dir = tempDir();
    const adapter = new AdapterProcess(fakeAdapter(dir.path));

    try {
      assert.deepEqual(await adapter.request({ id: 'a', css: 'abort' }), {
        id: 'a',
        ok: false,
        stage: 'crash',
        error: 'adapter exited (-6); stack overflow or abort',
      });
      assert.equal(
        (await adapter.request({ id: 'b', css: 'exit:3' })).error,
        'adapter exited (3); stack overflow or abort',
      );
      assert.deepEqual(await adapter.request({ id: 'c', css: 'garbage' }), {
        id: 'c',
        ok: false,
        stage: 'protocol',
        error: 'not json\n',
      });
      assert.equal((await adapter.request({ id: 'd', css: 'fine' })).code, 'fine');
      assert.equal(adapter.restarts, 3);
    } finally {
      await adapter.close();
    }
  });

  test('host-side keys are not sent', async () => {
    using dir = tempDir();
    const adapter = new AdapterProcess(fakeAdapter(dir.path));

    try {
      const response = await adapter.request({ id: 'x', css: 'a', _timeout: pyFloat(5), minify: true });

      assert.deepEqual(response.seen, ['id', 'css', 'minify']);
    } finally {
      await adapter.close();
    }
  });
});

describe('runRequests', () => {
  test('a request timeout overrides the default, with Python number formatting', async () => {
    using dir = tempDir();
    const out = await runRequests(
      fakeAdapter(dir.path),
      [sheet('slow', 'sleep:1', 3), sheet('short', 'sleep:1', 0.3)],
      { workers: 1, timeout: pyFloat(10) },
    );

    assert.equal(out.slow.ok, true);
    assert.equal(out.slow.code, 'sleep:1');
    assert.equal(out.short.stage, 'timeout');
    assert.equal(out.short.error, 'no response within 0.3s');
  });

  test('the default timeout prints as a float', async () => {
    using dir = tempDir();
    const adapter = new AdapterProcess(fakeAdapter(dir.path), pyFloat(0.2));

    try {
      assert.equal((await adapter.request({ id: 'h', css: 'hang' })).error, 'no response within 0.2s');
    } finally {
      await adapter.close();
    }

    assert.equal(String(new AdapterProcess(hostAdapter('x')).timeout), '10.0');
  });

  test('results are sorted by id and independent of the number of workers', async () => {
    using dir = tempDir();
    const binary = fakeAdapter(dir.path);
    const requests = ['t-b', 'p-a', 't-a', 'm-c', 'r-z', 'w-q'].map((id) => sheet(id, id));
    const one = await runRequests(binary, requests, { workers: 1 });
    const four = await runRequests(binary, requests, { workers: 4 });

    assert.deepEqual(Object.keys(one), ['m-c', 'p-a', 'r-z', 't-a', 't-b', 'w-q']);
    assert.deepEqual(four, one);
    assert.equal(one['t-a'].id, 't-a');
  });

  test('an adapter that cannot be executed fails the batch at once', async () => {
    using dir = tempDir();
    const binary = join(dir.path, 'adapter');
    const started = Date.now();

    writeFileSync(binary, FAKE_ADAPTER);
    await assert.rejects(
      runRequests(hostAdapter(binary), [sheet('a', 'a'), sheet('b', 'b')], { workers: 1 }),
      {
        name: 'LcrError',
        message: new RegExp(
          `^cannot run the adapter ${RegExp.escape(binary)} on the host: .*EACCES.*; rebuild it`,
        ),
      },
    );
    // Not one crash row per request, each waiting for an exit status that never comes.
    assert.ok(Date.now() - started < 1000);
  });

  test('a missing adapter is an LcrError naming the fix', async () => {
    await assert.rejects(runRequests(hostAdapter('/nonexistent/adapter'), []), {
      name: 'LcrError',
      message: 'adapter binary missing: /nonexistent/adapter (run `lcr build` first)',
    });
  });

  test('large batches log progress every 5000 responses', async (t) => {
    using dir = tempDir();
    const requests = Array.from({ length: 5000 }, (_, index) => sheet(`t-${index}`, 'a'));
    // Only stderr: the test runner reports through stdout.
    const write = t.mock.method(process.stderr, 'write', () => true);

    await runRequests(fakeAdapter(dir.path), requests, { workers: 2, label: 'x/base' });
    write.mock.restore();

    assert.deepEqual(
      write.mock.calls.map((call) => call.arguments[0]),
      ['[lcr] x/base 5000/5000\n'],
    );
  });
});

describe('line protocol', () => {
  // serde_json writes U+2028 and U+2029 raw inside strings, and responses are split on universal
  // newlines only (\n, \r\n, \r), so neither may split a response.
  const LINE_SEPARATOR = String.fromCodePoint(0x2028);
  const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);

  test('a response holding U+2028 or U+2029 is one line', async () => {
    using dir = tempDir();
    const css = `a${LINE_SEPARATOR}b${PARAGRAPH_SEPARATOR}c`;
    const out = await runRequests(fakeAdapter(dir.path), [sheet('t-1', css), sheet('t-2', 'x')], {
      workers: 1,
    });

    assert.equal(out['t-1'].code, css);
    assert.equal(out['t-2'].code, 'x');
  });

  test('a final line without a line break is stored without one', async () => {
    using dir = tempDir();
    const out = await runRequests(fakeAdapter(dir.path), [sheet('t-1', 'noeol')], { workers: 1 });

    assert.equal(out['t-1'].error, 'not json');
  });
});
