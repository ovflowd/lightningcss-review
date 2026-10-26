import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { FIXTURES_DIR } from '../../../test/helpers/index.js';
import { helpWidth } from '../argparse.js';
import { parseCommandLine } from '../main.js';

/**
 * py-final's argparse on ~110 command lines (help, errors, abbreviations, negative numbers, `--`),
 * recorded once with COLUMNS=80 from the py-final tag.
 *
 * @typedef {object} ArgparseCase
 * @property {string[]} argv
 * @property {number} status
 * @property {string} stdout
 * @property {string} stderr
 * @property {Record<string, unknown> | null} values The parsed namespace (snake_case keys).
 */

const GOLDEN = /** @type {{ width: number, cases: ArgparseCase[] }} */ (
  JSON.parse(readFileSync(join(FIXTURES_DIR, 'infra', 'argparse.json'), 'utf8'))
);

/**
 * @param {string} key
 * @returns {string}
 */
function snakeCase(key) {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

test('every recorded command line parses, prints and exits as py-final did', () => {
  for (const { argv, ...expected } of GOLDEN.cases) {
    const parsed = parseCommandLine(argv, GOLDEN.width);
    const actual =
      'status' in parsed
        ? { status: parsed.status, stdout: parsed.stdout, stderr: parsed.stderr, values: null }
        : {
            status: 0,
            stdout: '',
            stderr: '',
            values: Object.fromEntries(
              Object.entries(parsed.args).map(([key, value]) => [snakeCase(key), value]),
            ),
          };

    assert.deepEqual(actual, expected, argv.join(' '));
  }
});

test('help is formatted for COLUMNS, else the terminal, else 80 columns, minus 2', () => {
  assert.equal(helpWidth({ columns: '100', terminalColumns: 0 }), 98);
  assert.equal(helpWidth({ columns: undefined, terminalColumns: 0 }), 78);
  assert.equal(helpWidth({ columns: 'wide', terminalColumns: 120 }), 118);
  assert.equal(helpWidth({ columns: '0', terminalColumns: 0 }), 78);
  // COLUMNS is read with Python's int(): whitespace, `_` and other scripts' digits are fine.
  assert.equal(helpWidth({ columns: ' 1_00 ', terminalColumns: 0 }), 98);
});
