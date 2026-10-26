/**
 * The parts of Python's pathlib whose behavior shows in lcr's output or in what it touches.
 *
 * Stage: shared. Run resolution and the report print run directories, `lcr clean` sizes build
 * trees, `lcr spec-coverage` walks the Rust sources, the corpus stage lists probe files, and
 * scripts/lint-context.js walks the references. py-final did all of that with pathlib, and the
 * paths it printed and the order it visited files in are part of the diffed output.
 *
 * - `purePath` / `joinPath` spell a path as `str(Path(...))` does. `node:path` collapses `..`
 *   segments and keeps a trailing slash; pathlib does the opposite.
 * - `resolvePath` is `Path.resolve()`: absolute, with symbolic links followed (`path.resolve`
 *   does not follow them).
 * - `walkTree` is `rglob('*')`. `readdirSync(dir, { recursive: true })` follows symbolic links to
 *   directories, so it loops forever on the `node_modules/lightningcss -> ..` links a Lightning CSS
 *   build tree contains; pathlib lists such a link but never descends into it, and so does this.
 * - `rglobSorted` / `rglobRelative` are `sorted(Path(root).rglob('*' + suffix))`: pathlib sorts
 *   component by component, so `a/x` comes before `a-b/x` (a plain string sort says otherwise).
 */
import { readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { compareCodePoints } from './pyjson.js';

/**
 * A path spelled as Python's `str(Path(text))`: repeated slashes, `.` components and a trailing
 * slash dropped, `..` kept; an empty path is `.`.
 *
 * @param {string} text
 * @returns {string}
 */
export function purePath(text) {
  let root = '';

  // POSIX gives exactly two leading slashes a meaning of their own; pathlib keeps them.
  if (text.startsWith('//') && !text.startsWith('///')) {
    root = '//';
  } else if (text.startsWith('/')) {
    root = '/';
  }

  const parts = text.split('/').filter((part) => part !== '' && part !== '.');

  return `${root}${parts.join('/')}` || '.';
}

/**
 * Python's `str(Path(base) / name / …)`: an absolute name replaces everything before it, and
 * `Path('.') / 'a'` is `a`.
 *
 * @param {string} base
 * @param {...string} names
 * @returns {string}
 */
export function joinPath(base, ...names) {
  let joined = base;

  for (const name of names) {
    if (isAbsolute(name)) {
      joined = name;
    } else {
      joined = purePath(joined) === '.' ? name : `${joined}/${name}`;
    }
  }

  return purePath(joined);
}

/**
 * Python's `Path(text).resolve()`: an absolute path with every symbolic link followed. As in
 * Python (non-strict), a path that does not exist yet resolves its existing ancestor and keeps the
 * rest as written.
 *
 * @param {string} text
 * @returns {string}
 */
export function resolvePath(text) {
  const absolute = resolve(text);

  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);

    return parent === absolute ? absolute : join(resolvePath(parent), basename(absolute));
  }
}

/**
 * @typedef {object} TreeEntry
 * @property {string} path
 * @property {string} name
 * @property {boolean} isDirectory False for a symbolic link, whatever it points to.
 */

/**
 * Every entry under `dir` (not `dir` itself), depth first. libuv's scandir sorts each directory's
 * entries by name (byte order, which is code point order for UTF-8 names).
 *
 * @param {string} dir
 * @yields {TreeEntry}
 * @returns {Generator<TreeEntry, void, void>}
 */
export function* walkTree(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);

    yield { path, name: entry.name, isDirectory: entry.isDirectory() };

    if (entry.isDirectory()) {
      yield* walkTree(path);
    }
  }
}

/**
 * `sorted(Path(root).rglob('*' + suffix))`: every entry below `root` whose name ends with
 * `suffix` (hidden ones included, case-sensitive), without descending into symlinked directories,
 * in pathlib's order.
 *
 * @param {string} root A normalized directory path.
 * @param {string} suffix e.g. `.css`.
 * @returns {string[]} Paths joined onto `root` the way pathlib prints them.
 */
export function rglobSorted(root, suffix) {
  return rglobRelative(root, suffix).map((relative) => joinPath(root, relative));
}

/**
 * `rglobSorted`, with each path relative to `root` (`path.relative_to(root)`).
 *
 * @param {string} root
 * @param {string} suffix
 * @returns {string[]}
 */
export function rglobRelative(root, suffix) {
  /** @type {string[][]} */
  const found = [];

  collect(root, [], suffix, found);
  found.sort(comparePathParts);

  return found.map((parts) => parts.join('/'));
}

/**
 * @param {string} root
 * @param {string[]} prefix Components below `root`.
 * @param {string} suffix
 * @param {string[][]} found
 * @returns {void}
 */
function collect(root, prefix, suffix, found) {
  const directory = prefix.length ? joinPath(root, prefix.join('/')) : root;
  let entries;

  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    // pathlib's walker skips directories it cannot list.
    return;
  }

  for (const entry of entries) {
    const parts = [...prefix, entry.name];

    if (entry.name.endsWith(suffix)) {
      found.push(parts);
    }

    if (entry.isDirectory()) {
      collect(root, parts, suffix, found);
    }
  }
}

/**
 * pathlib's ordering: the lists of path components, compared item by item.
 *
 * @param {string[]} left
 * @param {string[]} right
 * @returns {number}
 */
function comparePathParts(left, right) {
  const length = Math.min(left.length, right.length);

  for (let index = 0; index < length; index++) {
    const order = compareCodePoints(left[index], right[index]);

    if (order !== 0) {
      return order;
    }
  }

  return left.length - right.length;
}
