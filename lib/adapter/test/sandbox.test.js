import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { fakeDocker } from '../../../test/helpers/fake-docker.js';
import { tempDir, withEnv, writeFiles } from '../../../test/helpers/index.js';
import { hostUser } from '../../core/docker.js';
import { pyFloat } from '../../core/pyjson.js';
import { AdapterProcess } from '../client.js';
import {
  adapterContainerCommand,
  CONTAINER_ADAPTER,
  containerLauncher,
  containerReturncode,
  sideAdapter,
} from '../sandbox.js';

// A stand-in adapter: answers every request with its CSS; `hang` never answers (and ignores the
// end of its input, as a busy adapter would); `abort` kills itself with SIGABRT.
const FAKE_ADAPTER = `#!/usr/bin/env node
process.on('SIGTERM', () => {});
const lines = require('node:readline').createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.css === 'hang') { lines.close(); setInterval(() => {}, 1000); return; }
  if (request.css === 'abort') { process.kill(process.pid, 'SIGABRT'); return; }
  process.stdout.write(JSON.stringify({ id: request.id, ok: true, code: request.css }) + '\\n');
});
`;

/**
 * @param {string} dir
 * @returns {string}
 */
function adapterBinary(dir) {
  const path = join(dir, 'head-adapter');

  writeFileSync(path, FAKE_ADAPTER);
  chmodSync(path, 0o755);

  return path;
}

/**
 * Whether a process still runs.
 *
 * @param {number} pid
 * @returns {boolean}
 */
function alive(pid) {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

describe('the adapter container', () => {
  test('runs the binary read-only in builder-sandbox, named, with stdin open', () => {
    const { argv, env, name } = adapterContainerCommand('1.96.0', '/run/bin/head-adapter');
    const run = argv.indexOf('run');

    assert.match(name, /^lcr-adapter-\d+-\d+-[0-9a-f]{8}$/);
    assert.notEqual(adapterContainerCommand('1.96.0', '/x').name, name);
    assert.deepEqual(argv.slice(run, run + 7), [
      'run',
      '--rm',
      '--no-deps',
      '-T',
      `--user=${hostUser()}`,
      '--interactive',
      `--name=${name}`,
    ]);
    assert.deepEqual(argv.slice(run + 7, run + 9), ['-v', `/run/bin/head-adapter:${CONTAINER_ADAPTER}:ro`]);
    assert.ok(argv.includes('RUST_BACKTRACE=0'));
    // Only the binary is mounted.
    assert.equal(argv.filter((arg) => arg === '-v').length, 1);

    const service = argv.indexOf('builder-sandbox');

    assert.deepEqual(argv.slice(service + 1, service + 3), ['sh', '-c']);
    assert.equal(argv.at(-1), CONTAINER_ADAPTER);
    // The binary's path reaches the script as $0, never inside the script text.
    assert.ok(!argv[service + 3].includes('/adapter'));
    assert.equal(env.LCR_RUST_CHANNEL, '1.96.0');
  });

  test('exit statuses map back to what a host process reports', () => {
    assert.equal(containerReturncode(134), -6);
    assert.equal(containerReturncode(139), -11);
    assert.equal(containerReturncode(137), -9);
    assert.equal(containerReturncode(192), -64);
    assert.equal(containerReturncode(193), 193);
    assert.equal(containerReturncode(128), 128);
    assert.equal(containerReturncode(3), 3);
    assert.equal(containerReturncode(0), 0);
    assert.equal(containerReturncode(-9), -9);
    assert.equal(containerReturncode(null), null);
  });

  test('a timeout kills the container by name, not only the compose client', async () => {
    using dir = tempDir();
    const docker = fakeDocker(dir.path);

    using _env = withEnv({ PATH: `${docker.bin}:${process.env.PATH}`, FAKE_DOCKER_STATE: docker.state });
    const adapter = new AdapterProcess(
      { binary: adapterBinary(dir.path), launcher: containerLauncher('1.96.0') },
      pyFloat(0.5),
    );

    try {
      assert.equal((await adapter.request({ id: 'a', css: 'fine' })).code, 'fine');

      const [first] = docker.calls().filter((call) => call.service === 'builder-sandbox');
      const pid = Number(readFileSync(join(docker.state, `${first.name}.pid`), 'utf8'));

      assert.deepEqual(await adapter.request({ id: 'b', css: 'hang' }), {
        id: 'b',
        ok: false,
        stage: 'timeout',
        error: 'no response within 0.5s',
      });
      assert.deepEqual(
        docker
          .calls()
          .filter((call) => call.argv[0] === 'kill')
          .map((call) => call.argv),
        [['kill', first.name]],
      );

      // SIGKILL is asynchronous; give the kernel a moment.
      for (let tries = 0; tries < 50 && alive(pid); tries++) {
        await sleep(20);
      }

      assert.equal(alive(pid), false, 'the hung adapter is gone');
      // The next request starts a new container with a new name.
      assert.equal((await adapter.request({ id: 'c', css: 'again' })).code, 'again');

      const names = docker.calls().filter((call) => call.service === 'builder-sandbox');

      assert.equal(names.length, 2);
      assert.notEqual(names[1].name, first.name);
    } finally {
      await adapter.close();
    }
  });

  test('an abort through tini reads as on the host, and the dead container is cleaned up', async () => {
    using dir = tempDir();
    const docker = fakeDocker(dir.path);

    using _env = withEnv({ PATH: `${docker.bin}:${process.env.PATH}`, FAKE_DOCKER_STATE: docker.state });
    const adapter = new AdapterProcess({
      binary: adapterBinary(dir.path),
      launcher: containerLauncher('stable'),
    });

    try {
      assert.deepEqual(await adapter.request({ id: 'a', css: 'abort' }), {
        id: 'a',
        ok: false,
        stage: 'crash',
        error: 'adapter exited (-6); stack overflow or abort',
      });
      assert.equal(docker.calls().filter((call) => call.argv[0] === 'kill').length, 1);
    } finally {
      await adapter.close();
    }
  });

  test('a container that cannot start fails the batch with the reason', async () => {
    using dir = tempDir();
    const docker = fakeDocker(dir.path);

    using _env = withEnv({ PATH: `${docker.bin}:${process.env.PATH}`, FAKE_DOCKER_STATE: docker.state });
    // Not executable: the container's check refuses it before printing the ready line.
    const binary = join(dir.path, 'not-executable');

    writeFileSync(binary, FAKE_ADAPTER);

    const adapter = new AdapterProcess({ binary, launcher: containerLauncher('stable') });

    await assert.rejects(adapter.request({ id: 'a', css: 'x' }), {
      name: 'LcrError',
      message: new RegExp(
        `^cannot run the adapter ${RegExp.escape(binary)} in builder-sandbox: no output; check Docker`,
      ),
    });
  });
});

describe('sideAdapter', () => {
  test('LCR_BUILD=host runs the adapter on the host; otherwise in the channel it was built with', async () => {
    using dir = tempDir();
    const docker = fakeDocker(dir.path);

    writeFiles(dir.path, {
      'run/build.json': { base: { toolchain: '1.90.0', image: 'lcr-builder:rust-1.90.0' } },
      'run/src/head/rust-toolchain.toml': '[toolchain]\nchannel = "1.96.0"\n',
    });

    {
      using _env = withEnv({ LCR_BUILD: 'host' });

      assert.equal((await sideAdapter(join(dir.path, 'run'), 'head')).launcher.where, 'on the host');
    }

    using _env = withEnv({
      LCR_BUILD: undefined,
      PATH: `${docker.bin}:${process.env.PATH}`,
      FAKE_DOCKER_STATE: docker.state,
    });
    const base = await sideAdapter(join(dir.path, 'run'), 'base');
    const head = await sideAdapter(join(dir.path, 'run'), 'head');

    assert.equal(base.binary, join(dir.path, 'run', 'bin', 'base-adapter'));
    assert.equal(base.launcher.where, 'in builder-sandbox (lcr-builder:rust-1.90.0)');
    assert.equal(head.launcher.where, 'in builder-sandbox (lcr-builder:rust-1.96.0)');
  });

  test('an adapter built on the host is not silently run elsewhere', async () => {
    using dir = tempDir();

    writeFiles(dir.path, { 'build.json': { head: { toolchain: 'stable', image: 'host' } } });

    using _env = withEnv({ LCR_BUILD: undefined });

    await assert.rejects(sideAdapter(dir.path, 'head'), {
      name: 'LcrError',
      message:
        'the head adapter was built on the host (LCR_BUILD=host); set LCR_BUILD=host for this run too, or rebuild it in the builder image with `lcr build`',
    });
  });
});
