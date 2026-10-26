/**
 * A stand-in for the JSONL adapter in the driver group's tests (oracle-driver and inspect): it
 * answers every request with the CSS unchanged, so "pretty-printing" is the identity and a test
 * controls both sides' output. py-final's goldens (python-golden.json) ran the same script.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPT = `#!/usr/bin/env node
const lines = require('node:readline').createInterface({ input: process.stdin });

lines.on('line', (line) => {
  const request = JSON.parse(line);

  process.stdout.write(JSON.stringify({ id: request.id, ok: true, code: request.css }) + '\\n');
});
`;

/**
 * Write bin/base-adapter and bin/head-adapter into a run directory.
 *
 * @param {string} runDir
 * @returns {void}
 */
export function writeFakeAdapters(runDir) {
  const bin = join(runDir, 'bin');

  mkdirSync(bin, { recursive: true });

  for (const name of ['base-adapter', 'head-adapter']) {
    writeFileSync(join(bin, name), SCRIPT);
    chmodSync(join(bin, name), 0o755);
  }
}
