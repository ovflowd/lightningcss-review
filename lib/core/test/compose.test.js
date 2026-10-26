import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COMPOSE_FILE, composeArgv, composeRunArgv, withoutComposeNewline } from '../compose.js';
import { hostUser } from '../docker.js';
import { SKILL_DIR } from '../paths.js';

test('every compose call uses the fixed project, directory and file', () => {
  assert.deepEqual(composeArgv(['build', 'builder']), [
    'docker',
    'compose',
    '--project-name',
    'lcr',
    '--project-directory',
    SKILL_DIR,
    '--file',
    COMPOSE_FILE,
    'build',
    'builder',
  ]);
});

test('run passes per-run mounts, the sorted default environment and the host user, quietly', () => {
  const argv = composeRunArgv('browsers-latest', ['node', 'x.mjs'], {
    mounts: [{ host: '/tmp/run', container: '/run', mode: 'rw' }],
    env: { A: '1' },
    workdir: '/run',
  });

  assert.equal(argv[2], '--progress=quiet');
  assert.deepEqual(argv.slice(9), [
    'run',
    '--rm',
    '--no-deps',
    '-T',
    `--user=${hostUser()}`,
    '-v',
    '/tmp/run:/run:rw',
    '-e',
    'A=1',
    '-e',
    'HOME=/tmp',
    '-e',
    'LANG=C.UTF-8',
    '-e',
    'TZ=UTC',
    '-w',
    '/run',
    'browsers-latest',
    'node',
    'x.mjs',
  ]);
});

test("the newline compose adds to stderr on a failed run is not the container's output", () => {
  const result = { argv: [], signal: null, timedOut: false, stdout: 'out\n' };

  assert.equal(withoutComposeNewline({ ...result, code: 3, stderr: 'err\n\n' }).stderr, 'err\n');
  assert.equal(withoutComposeNewline({ ...result, code: 137, stderr: '\n' }).stderr, '');
  assert.equal(withoutComposeNewline({ ...result, code: 0, stderr: 'err\n' }).stderr, 'err\n');
  assert.equal(withoutComposeNewline({ ...result, code: 3, stderr: 'err' }).stderr, 'err');
});
