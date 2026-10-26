/**
 * Source trees on disk for the build and perf stages: the Rust channel a tree pins, fresh
 * instrumented copies, and mtime refreshes that keep shared cargo target directories honest.
 *
 * Stage: build (build/<side>/tree copies of src/<side>) and perf (release builds of src/<side>).
 *
 * Invariant: the target directories under `<cache>/targets/` are shared by every run (warm
 * incremental builds). `git archive` exports carry commit times, so every tree is touched before
 * cargo sees it; otherwise cargo can judge another tree's artifacts fresh and skip the rebuild.
 */
import { cpSync, existsSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

import { readPyText } from '../core/files.js';
import { pyRe } from '../core/py-re.js';

/**
 * `LCR_BUILD=host` builds with the host toolchain instead of the builder image (no isolation; the
 * toolchain must match rust-toolchain.toml). Browsers always run in Docker.
 *
 * @returns {boolean}
 */
export function isHostBuild() {
  return process.env.LCR_BUILD === 'host';
}

const CHANNEL = pyRe(String.raw`channel\s*=\s*"([^"]+)"`);

/**
 * The Rust channel a tree pins in rust-toolchain.toml, else `stable`.
 *
 * @param {string} tree
 * @returns {string}
 */
export function toolchainChannel(tree) {
  const file = join(tree, 'rust-toolchain.toml');

  if (!existsSync(file)) {
    return 'stable';
  }

  const match = CHANNEL.exec(readPyText(file, { replace: true }));

  return match ? match[1] : 'stable';
}

/**
 * Set every regular file's mtime to now. Symlinks are left alone.
 *
 * @param {string} root
 * @returns {void}
 */
export function touchTree(root) {
  const now = new Date();

  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      utimesSync(join(entry.parentPath, entry.name), now, now);
    }
  }
}

/**
 * Replace `tree` with a copy of `pristine` (symlinks kept as they are), touched.
 *
 * @param {string} pristine
 * @param {string} tree
 * @returns {void}
 */
export function freshCopy(pristine, tree) {
  rmSync(tree, { recursive: true, force: true });
  cpSync(pristine, tree, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  touchTree(tree);
}
