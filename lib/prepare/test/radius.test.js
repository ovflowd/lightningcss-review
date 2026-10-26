import assert from 'node:assert/strict';
import { test } from 'node:test';

import { blastRadius } from '../radius.js';

/** @import { GrepUsers } from '../radius.js' */

/** @typedef {[needle: string, exclude: string[] | undefined]} GrepCall */

/**
 * A `grep` stand-in that records its calls and finds `files`.
 *
 * @param {string[]} [files]
 * @returns {{ calls: GrepCall[], grep: GrepUsers }}
 */
function recordingGrep(files = []) {
  /** @type {GrepCall[]} */
  const calls = [];

  return {
    calls,
    grep: async (_tree, needle, { exclude } = {}) => {
      calls.push([needle, exclude && [...exclude]]);

      return files;
    },
  };
}

test('the radius of src/compat.rs is its changed Feature variants, not every is_compatible user', async () => {
  const { calls, grep } = recordingGrep();
  const items = [
    {
      file: 'src/compat.rs',
      item: { kind: 'fn', name: 'is_compatible', line: 1 },
      impl: { trait: null, type: 'Feature', line: 1 },
    },
  ];

  await blastRadius('tree', items, { variants: ['AnyLink'], grep });

  assert.deepEqual(calls, [['Feature::AnyLink', ['src/compat.rs']]]);
});

test('generic and short names are skipped; names are sorted; areas come from the users', async () => {
  const { calls, grep } = recordingGrep(['src/properties/display.rs', 'src/lib.rs']);
  const items = [
    {
      file: 'src/a.rs',
      item: { kind: 'fn', name: 'parse', line: 1 },
      impl: { trait: null, type: 'Zeta', line: 1 },
    },
    { file: 'src/a.rs', item: { kind: 'fn', name: 'ab', line: 2 }, impl: null },
    { file: 'src/b.rs', item: { kind: 'struct', name: 'Alpha', line: 3 }, impl: null },
  ];
  const radius = await blastRadius('tree', items, { grep });

  assert.deepEqual(
    calls.map(([needle]) => needle),
    ['Alpha', 'Zeta'],
  );
  assert.deepEqual(radius[0].files, ['src/properties/display.rs', 'src/lib.rs']);
  assert.deepEqual(radius[0].areas, [...new Set(radius[0].areas)].sort());
  assert.ok(radius[0].areas.includes('tests'));
});
