import assert from 'node:assert/strict';
import { test } from 'node:test';

import { tempDir } from '../../../test/helpers/index.js';
import { freeBytes, mountOf, preflightDisk } from '../disk.js';
import { LcrError } from '../errors.js';

test('preflightDisk passes when there is room and names the remedy when there is not', () => {
  using dir = tempDir();

  preflightDisk(dir.path, 1, 'x');
  assert.ok(freeBytes(dir.path) > 0);
  assert.throws(
    () => preflightDisk(dir.path, 2 ** 60, 'corpus'),
    (error) =>
      error instanceof LcrError && /^corpus needs about \d+ MiB in .*; free space with/.test(error.message),
  );
});

test('mountOf finds the filesystem holding a path', () => {
  using dir = tempDir();
  const mount = mountOf(dir.path);

  assert.ok(mount === null || dir.path.startsWith(mount.mountPoint));
});
