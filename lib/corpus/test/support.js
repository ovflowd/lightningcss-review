/**
 * Test support for the corpus stage: a stand-in for the JSONL adapter and probe files.
 *
 * The fake adapter echoes the CSS as its output (collapsing double spaces, so a second pass is
 * stable), refuses one parser flag if asked to (a revision that does not know it), can mark
 * cases whose CSS contains `delta-me` so base and head differ, and never answers CSS containing
 * `hang-me` (so the client's timeout fires).
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The probe ref every test probe uses. */
export const SPEC_REF = 'https://drafts.csswg.org/css-color-4/#x';

/**
 * @typedef {object} FakeAdapterOptions
 * @property {string} [unknownFlag] A parser flag this "revision" rejects with a request error.
 * @property {string} [marker] Appended to the output of CSS containing `delta-me`.
 */

/**
 * Write an executable fake adapter.
 *
 * @param {string} directory
 * @param {string} name e.g. `base-adapter`.
 * @param {FakeAdapterOptions} [options]
 * @returns {string} Its path.
 */
export function fakeAdapter(directory, name, { unknownFlag = '', marker = '' } = {}) {
  const path = join(directory, name);
  const script = `#!/usr/bin/env node
const FLAG = ${JSON.stringify(unknownFlag)};
const MARKER = ${JSON.stringify(marker)};
const lines = require('node:readline').createInterface({ input: process.stdin });

lines.on('line', (line) => {
  const request = JSON.parse(line);
  const css = request.css ?? '';
  let out;

  if (css.includes('hang-me')) {
    return;
  }

  if (FLAG && (request.flags ?? []).includes(FLAG)) {
    out = { id: request.id, ok: false, stage: 'request', error: 'unknown parser flag ' + FLAG };
  } else {
    const code = css.replaceAll('  ', ' ');

    out = { id: request.id, ok: true, code: css.includes('delta-me') ? code + MARKER : code };
  }

  process.stdout.write(JSON.stringify(out) + '\\n');
});
`;

  mkdirSync(directory, { recursive: true });
  writeFileSync(path, script);
  chmodSync(path, 0o755);

  return path;
}

/**
 * Write a minify-mode probe that expects `idempotent` and `output-contains:"red"`.
 *
 * @param {string} directory
 * @param {string} slug
 * @param {{ extra?: string, css?: string, area?: string }} [options] `extra`: more header lines.
 * @returns {string} The file's path.
 */
export function writeProbe(directory, slug, { extra = '', css = '.t { color: red }', area = 'color' } = {}) {
  const path = join(directory, `${slug}.css`);

  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path,
    `/*! lcr-probe\nid: ${area}/${slug}\narea: ${area}\ntitle: t\nmode: minify\ntargets: none\n` +
      `expect: idempotent, output-contains:"red"\nknown: none\nref: ${SPEC_REF}\n${extra}*/\n${css}\n`,
  );

  return path;
}
