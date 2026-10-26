/**
 * spec-cards: spec data from W3C webref (@webref/css) for the report and `lcr spec-coverage`.
 *
 * Stage: oracle, analysis image (@webref/css available).
 *
 *   node spec-cards.mjs cards <names.json> <out.json>   property cards for the report
 *   node spec-cards.mjs inventory <out.json>            every property/at-rule/selector/function name
 *
 * Both write pretty-printed JSON (2-space indent, trailing newline). Exit status 2 on a usage error.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import css from '@webref/css';

import { specCards, specInventory } from './lib/spec.mjs';

const USAGE = 'usage: spec-cards.mjs cards <names.json> <out.json> | inventory <out.json>';
/** Exit status of a usage error. */
const USAGE_EXIT = 2;

// Positional arguments only: anything else, `--help` included, is a usage error.
const [mode, first, second] = process.argv.slice(2);
const data = await css.listAll();

/**
 * @param {string} file
 * @param {unknown} value
 */
function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

if (mode === 'cards') {
  writeJson(second, specCards(data, JSON.parse(readFileSync(first, 'utf8'))));
} else if (mode === 'inventory') {
  writeJson(first, specInventory(data));
} else {
  process.stderr.write(USAGE + '\n');
  process.exit(USAGE_EXIT);
}
