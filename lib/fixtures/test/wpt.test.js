import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { tempDir, withEnv, writeFiles } from '../../../test/helpers/index.js';
import { loadConfig } from '../../core/paths.js';
import { compareCodePoints } from '../../core/pyjson.js';
import { ensureFixtures, loadFixtures, wptPropertyDirs } from '../wpt.js';

const COMMIT = /** @type {{ commit: string }} */ (loadConfig('wpt.json')).commit.slice(0, 12);

test('fixtures are read from the pinned revision, null before `lcr wpt`', async () => {
  using dir = tempDir();
  using _env = withEnv({ LCR_CACHE: dir.path });

  assert.equal(loadFixtures(), null);

  const fixtures = { cases: [{ id: 'w-1', file: 'f.html', kind: 'valid', property: 'color', value: 'red' }] };

  writeFiles(dir.path, { [`wpt/fixtures-${COMMIT}.json`]: fixtures });
  assert.deepEqual(loadFixtures(), fixtures);
  // Existing fixtures are reused without Docker or git.
  assert.equal(await ensureFixtures(), join(dir.path, 'wpt', `fixtures-${COMMIT}.json`));
});

test('the property directories of some areas, unique and sorted', () => {
  const areas = /** @type {{ areas: Record<string, { wpt?: string[] }> }} */ (loadConfig('areas.json')).areas;
  const [name, area] = Object.entries(areas).find(([, entry]) => (entry.wpt ?? []).length > 0) ?? ['', {}];

  assert.deepEqual(
    wptPropertyDirs([name, name, 'no-such-area']),
    [...new Set(area.wpt)].sort(compareCodePoints),
  );
  assert.deepEqual(wptPropertyDirs([]), []);
});
