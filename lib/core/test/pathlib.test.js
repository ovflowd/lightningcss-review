import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { tempDir } from '../../../test/helpers/index.js';
import { joinPath, purePath, resolvePath, rglobRelative, walkTree } from '../pathlib.js';

test('paths are spelled as str(Path(...)) spells them', () => {
  assert.equal(purePath('/a//b/./c/'), '/a/b/c');
  assert.equal(purePath('a/../b'), 'a/../b');
  assert.equal(purePath('a/../b//c/./d/'), 'a/../b/c/d');
  assert.equal(purePath('./'), '.');
  assert.equal(purePath('./x'), 'x');
  assert.equal(purePath(''), '.');
  assert.equal(purePath('//srv/x'), '//srv/x');
  assert.equal(purePath('///srv'), '/srv');
});

test('joinPath joins as the / operator does: an absolute name replaces the base', () => {
  assert.equal(joinPath('/c/runs', 'pr1-x'), '/c/runs/pr1-x');
  assert.equal(joinPath('/c/runs', 'pr1-x/'), '/c/runs/pr1-x');
  assert.equal(joinPath('/c/runs', '../other/pr1-x'), '/c/runs/../other/pr1-x');
  assert.equal(joinPath('/c/runs', '/elsewhere/pr1-x'), '/elsewhere/pr1-x');
  assert.equal(joinPath('/r/', 'probes', 'x.css'), '/r/probes/x.css');
  assert.equal(joinPath('.', 'a'), 'a');
  assert.equal(joinPath('', 'a'), 'a');
  assert.equal(joinPath('a', '/b', 'c'), '/b/c');
});

test('resolvePath follows symbolic links, also below a path that does not exist yet', () => {
  using dir = tempDir();
  const real = realpathSync(dir.path);

  mkdirSync(join(real, 'target'));
  symlinkSync(join(real, 'target'), join(real, 'link'));

  assert.equal(resolvePath(join(dir.path, 'link')), join(real, 'target'));
  assert.equal(resolvePath(join(dir.path, 'link', 'missing', 'x')), join(real, 'target', 'missing', 'x'));
});

test('walkTree lists symlinks and dotfiles but never enters a linked directory', () => {
  using dir = tempDir();

  mkdirSync(join(dir.path, 'b', 'deep'), { recursive: true });
  writeFileSync(join(dir.path, 'b', 'deep', 'f.txt'), '');
  writeFileSync(join(dir.path, '.hidden'), '');
  // node_modules/lightningcss -> .. in a Lightning CSS build tree: a loop for a following walk.
  symlinkSync('..', join(dir.path, 'b', 'loop'));

  const entries = [...walkTree(dir.path)].map((entry) => [
    entry.path.slice(dir.path.length + 1),
    entry.isDirectory,
  ]);

  assert.deepEqual(entries, [
    ['.hidden', false],
    ['b', true],
    ['b/deep', true],
    ['b/deep/f.txt', false],
    ['b/loop', false],
  ]);
});

test('rglob order is component-wise and includes hidden entries', () => {
  using dir = tempDir();

  for (const relative of ['a-b/x.css', 'a/x.css', '.h/y.css', 'z.CSS', 'b.css', 'dir.css/inner.css']) {
    mkdirSync(join(dir.path, relative, '..'), { recursive: true });

    writeFileSync(join(dir.path, relative), '');
  }

  assert.deepEqual(rglobRelative(dir.path, '.css'), [
    '.h/y.css',
    'a/x.css',
    'a-b/x.css',
    'b.css',
    'dir.css',
    'dir.css/inner.css',
  ]);
});
