import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { tempDir, withEnv } from '../../../test/helpers/index.js';
import { cacheDir, loadConfig, skillVersion } from '../paths.js';

test('LCR_CACHE wins over XDG_CACHE_HOME and is used as given', () => {
  using dir = tempDir();

  {
    using _env = withEnv({ LCR_CACHE: join(dir.path, 'c'), XDG_CACHE_HOME: dir.path });

    assert.equal(cacheDir(), join(dir.path, 'c'));
  }

  using _env = withEnv({ LCR_CACHE: undefined, XDG_CACHE_HOME: dir.path });

  assert.equal(cacheDir(), join(dir.path, 'lightningcss-review'));
});

test('config and version come from the skill checkout', () => {
  assert.match(skillVersion(), /^\d+\.\d+\.\d+$/);
  assert.ok(
    Array.isArray(/** @type {{ default_profiles: unknown }} */ (loadConfig('engines.json')).default_profiles),
  );
});
