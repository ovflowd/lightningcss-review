import assert from 'node:assert/strict';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { mock, test } from 'node:test';

import { LcrError } from '../errors.js';
import { halfTheCpus, LineProcess, returncode, run, runSync, shellJoin, which } from '../proc.js';

test('run captures output and checks the exit status', async () => {
  const ok = await run(['sh', '-c', 'printf out; printf err >&2']);

  assert.deepEqual([ok.code, ok.stdout, ok.stderr], [0, 'out', 'err']);

  await assert.rejects(run(['sh', '-c', 'echo boom >&2; exit 3']), (error) => {
    assert.ok(error instanceof LcrError);
    assert.equal(error.message, "command failed (3): sh -c 'echo boom >&2; exit 3'\nboom");

    return true;
  });

  const unchecked = await run(['sh', '-c', 'exit 4'], { check: false });

  assert.equal(unchecked.code, 4);
  assert.equal(returncode(await run(['sh', '-c', 'kill -9 $$'], { check: false })), -9);
  await assert.rejects(run(['sh', '-c', 'kill -6 $$']), /command failed \(-6\)/);
});

test('run passes stdin, merges env and enforces timeouts', async () => {
  const echoed = await run(['sh', '-c', 'cat; printf "$LCR_TEST_VAR"'], {
    input: 'in-',
    env: { LCR_TEST_VAR: 'v' },
  });

  assert.equal(echoed.stdout, 'in-v');
  await assert.rejects(run(['sleep', '5'], { timeoutMs: 50 }), /timed out after 0.05s: sleep 5/);
});

test('missing commands are LcrErrors', async () => {
  await assert.rejects(run(['lcr-no-such-command']), /command not found: lcr-no-such-command/);
  assert.throws(() => runSync(['lcr-no-such-command']), /command not found/);
});

test('runSync mirrors run', () => {
  assert.equal(runSync(['sh', '-c', 'printf x']).stdout, 'x');
  assert.throws(() => runSync(['sh', '-c', 'exit 1']), LcrError);
  assert.equal(runSync(['sleep', '5'], { timeoutMs: 50, check: false }).timedOut, true);
});

test('shellJoin quotes like shlex.join and which searches PATH', () => {
  assert.equal(shellJoin(['git', '-C', '/a b', "it's", '']), `git -C '/a b' 'it'"'"'s' ''`);
  assert.ok(which('sh'));
  assert.equal(which('lcr-no-such-command'), null);
});

test('LineProcess answers line by line, times out and can be disposed', async () => {
  await using child = new LineProcess([
    'sh',
    '-c',
    'while read line; do [ "$line" = slow ] && sleep 5; echo "got $line"; done',
  ]);

  child.writeLine('a');
  assert.equal(await child.readLine(2000), 'got a');
  child.writeLine('slow');
  assert.equal(await child.readLine(50), 'timeout');
  assert.equal(await child.kill(), -9);
  assert.equal(await child.readLine(50), null);
  assert.equal(child.writeLine('late'), false);
});

test('halfTheCpus halves the CPU count within its bounds; an unknown count gives the minimum', (t) => {
  const [cpu] = os.cpus();

  /** @param {number} count */
  const withCpus = (count) => {
    const cpus = mock.method(os, 'cpus', () => Array.from({ length: count }, () => cpu));

    syncBuiltinESMExports();
    t.after(() => {
      cpus.mock.restore();
      syncBuiltinESMExports();
    });
  };

  withCpus(16);
  assert.equal(halfTheCpus({ min: 2 }), 8);
  assert.equal(halfTheCpus({ min: 1, max: 4 }), 4);

  withCpus(3);
  assert.equal(halfTheCpus({ min: 2 }), 2);
  assert.equal(halfTheCpus({ min: 1 }), 1);

  withCpus(0);
  assert.equal(halfTheCpus({ min: 1, max: 8 }), 1);
  assert.equal(halfTheCpus({ min: 2 }), 2);
});
