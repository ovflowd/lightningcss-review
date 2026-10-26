/**
 * A stand-in for the `docker` CLI, for tests of the code that builds Docker command lines: it
 * records every call and plays just enough of Docker to drive the harness without a daemon.
 *
 * - `docker info`, `docker image inspect`: succeed (the daemon is up, every image exists).
 * - `docker compose … run … <service> <command…>`: records the call; for `builder-sandbox` it
 *   runs the command on the host, with each `-v host:container` path in the command mapped back
 *   to the host path and the `-e` variables set, stdin and stdout passed through, and exits as
 *   tini does (128 + n for a child killed by signal n). Like a real container, the command
 *   outlives a killed client: it is only stopped by `docker kill <name>`. Other services do
 *   nothing and exit with `FAKE_DOCKER_EXIT` (default 0), or hang with `FAKE_DOCKER_HANG` set.
 * - `docker kill <name>`: records the call and SIGKILLs that "container".
 *
 * Each call is one JSON line in the log: `{ argv, service, name, mounts, env, command }` (the
 * last five for `compose run` only).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPT = `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { constants } = require('node:os');

const STATE = process.env.FAKE_DOCKER_STATE;
const args = process.argv.slice(2);
const record = (entry) => appendFileSync(join(STATE, 'calls.jsonl'), JSON.stringify(entry) + '\\n');

if (args[0] === 'kill') {
  record({ argv: args });
  try {
    process.kill(Number(readFileSync(join(STATE, args[1] + '.pid'), 'utf8')), 'SIGKILL');
  } catch {
    process.exit(1);
  }
  process.exit(0);
}

if (args[0] !== 'compose') {
  record({ argv: args });
  process.stdout.write('29.0.0\\n');
  process.exit(0);
}

const run = args.indexOf('run');
const mounts = [];
const env = {};
let name = null;
let index = run + 1;

for (; index < args.length; index++) {
  const arg = args[index];

  if (arg === '-v') {
    const [host, container, mode] = args[++index].split(':');
    mounts.push({ host, container, mode });
  } else if (arg === '-e') {
    const [key, ...value] = args[++index].split('=');
    env[key] = value.join('=');
  } else if (arg === '-w') {
    index++;
  } else if (arg.startsWith('--name=')) {
    name = arg.slice('--name='.length);
  } else if (!arg.startsWith('-')) {
    break;
  }
}

const service = args[index];
const command = args.slice(index + 1);
record({ argv: args, service, name, mounts, env, command });

if (service !== 'builder-sandbox') {
  if (process.env.FAKE_DOCKER_HANG) {
    setInterval(() => {}, 1000);
    return;
  }

  process.exit(Number(process.env.FAKE_DOCKER_EXIT || 0));
}

const hostPath = (arg) => mounts.find((mount) => mount.container === arg)?.host ?? arg;
const child = spawn(hostPath(command[0]), command.slice(1).map(hostPath), {
  stdio: 'inherit',
  env: { ...process.env, ...env },
});

if (name) {
  writeFileSync(join(STATE, name + '.pid'), String(child.pid));
}

child.on('exit', (code, signal) => process.exit(signal ? 128 + constants.signals[signal] : code));
`;

/**
 * @typedef {object} FakeDockerCall
 * @property {string[]} argv
 * @property {string} [service]
 * @property {string | null} [name]
 * @property {{ host: string, container: string, mode: string }[]} [mounts]
 * @property {Record<string, string>} [env]
 * @property {string[]} [command]
 */

/**
 * Install the stand-in in `dir`: put `<dir>/bin` first on PATH and `<dir>/state` in
 * FAKE_DOCKER_STATE (with `withEnv`).
 *
 * @param {string} dir
 * @returns {{ bin: string, state: string, calls: () => FakeDockerCall[] }}
 */
export function fakeDocker(dir) {
  const bin = join(dir, 'bin');
  const state = join(dir, 'state');
  const log = join(state, 'calls.jsonl');

  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(bin, 'docker'), SCRIPT);
  chmodSync(join(bin, 'docker'), 0o755);

  return {
    bin,
    state,
    calls: () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .map((line) => /** @type {FakeDockerCall} */ (JSON.parse(line)))
        : [],
  };
}
