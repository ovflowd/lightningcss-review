import assert from 'node:assert/strict';
import { mkdirSync, readlinkSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { tempDir, withEnv, writeFiles } from '../../../test/helpers/index.js';
import { freshCopy, isHostBuild, toolchainChannel, touchTree } from '../tree.js';

const DAY_MS = 86_400_000;

test('copies are touched, and so is the export they come from', () => {
  using dir = tempDir();
  const src = join(dir.path, 'src');
  const file = join(src, 'selectors', 'lib.rs');

  mkdirSync(join(src, 'selectors'), { recursive: true });
  writeFileSync(file, 'x');

  const old = new Date(Date.now() - DAY_MS);

  utimesSync(file, old, old);

  const start = Date.now() - 1000;

  freshCopy(src, join(dir.path, 'tree'));
  assert.ok(statSync(join(dir.path, 'tree', 'selectors', 'lib.rs')).mtimeMs > start);

  touchTree(src);
  assert.ok(statSync(file).mtimeMs > start);
});

test('freshCopy replaces the old copy and keeps symlinks verbatim', () => {
  using dir = tempDir();
  const src = join(dir.path, 'src');
  const tree = join(dir.path, 'tree');

  writeFiles(src, { 'a.txt': 'a' });
  symlinkSync('a.txt', join(src, 'link'));
  writeFiles(tree, { 'stale.txt': 'old' });

  freshCopy(src, tree);

  assert.equal(readlinkSync(join(tree, 'link')), 'a.txt');
  assert.throws(() => statSync(join(tree, 'stale.txt')));
});

test('toolchainChannel reads rust-toolchain.toml, else stable', () => {
  using dir = tempDir();

  assert.equal(toolchainChannel(dir.path), 'stable');
  writeFiles(dir.path, { 'rust-toolchain.toml': '[toolchain]\r\nchannel = "1.96.0"\r\n' });
  assert.equal(toolchainChannel(dir.path), '1.96.0');
  writeFiles(dir.path, { 'rust-toolchain.toml': '[toolchain]\n' });
  assert.equal(toolchainChannel(dir.path), 'stable');
});

test('isHostBuild follows LCR_BUILD', () => {
  {
    using _env = withEnv({ LCR_BUILD: 'host' });

    assert.equal(isHostBuild(), true);
  }

  using _env = withEnv({ LCR_BUILD: undefined });

  assert.equal(isHostBuild(), false);
});
