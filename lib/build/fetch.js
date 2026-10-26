/**
 * The network half of a Rust build: `cargo fetch` of a tree's dependencies into the shared Cargo
 * home, so that every build and test after it runs offline with that Cargo home read-only.
 *
 * Stage: build (each side's instrumented tree) and perf (each side's pristine tree).
 *
 * Invariants:
 * - Only cargo itself runs while the network is on: `cargo fetch` downloads and unpacks crates
 *   but runs no build script, proc-macro or test. Without `--target` it fetches the dependencies
 *   of every target (wasm32 included) and every feature, which is everything a lane builds.
 * - Nothing in the reviewed tree can redirect the downloads into the shared cache. The fetch runs
 *   on a throwaway copy without `.cargo/` (source replacement, registries, `net` settings) and
 *   without the toolchain file (whose `path` key could name a "toolchain" inside the tree), with
 *   `RUSTUP_TOOLCHAIN` pinned to the image's channel. Upstream's `.cargo/config.toml` holds only
 *   rustflags and linkers, which do not change what is fetched.
 * - The copy, not the tree, takes the fallback's updated Cargo.lock, so an outdated lockfile is
 *   still a finding of the build itself (`--locked` fails there, as it would in CI).
 */
import { cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { LcrError } from '../core/errors.js';
import { writeText } from '../core/files.js';
import { log } from '../core/log.js';
import { returncode } from '../core/proc.js';
import { runBuilder } from '../setup/images.js';

/** A cold fetch of every Lightning CSS dependency takes well under a minute; allow slow mirrors. */
const FETCH_TIMEOUT_MS = 30 * 60_000;
/** Files of the reviewed tree that steer cargo or rustup, left out of the copy cargo fetches in. */
const STEERING_FILES = Object.freeze(['.cargo', 'rust-toolchain', 'rust-toolchain.toml']);
/** A toolchain name (`1.96.0`, `stable`, `nightly-2026-01-01`), never a path. */
const CHANNEL_NAME = /^[\w.-]+$/;

/**
 * CI parity first (`--locked`), then the fallback the test attempts use: an outdated lockfile
 * still gets its dependencies, resolved as the fallback attempt will resolve them offline.
 */
export const FETCH_SCRIPT = 'cd /src && { cargo fetch --locked || cargo fetch; }';

/**
 * @typedef {object} FetchOptions
 * @property {string} channel The tree's Rust channel (the builder image's).
 * @property {string} cache The harness cache (its `cargo-home/` is filled).
 * @property {string} scratch A path for the throwaway copy (removed afterwards).
 * @property {string} logFile Where cargo's output goes.
 * @property {string} label For messages: `head`, `base release`, …
 */

/**
 * Fetch a tree's crates into `<cache>/cargo-home` in the networked builder container. A failed
 * fetch is logged, not thrown: the offline build then fails on the missing crates and reports
 * it, like any other build failure.
 *
 * @param {string} tree
 * @param {FetchOptions} options
 * @returns {Promise<number | null>} cargo's exit status.
 */
export async function fetchCrates(tree, { channel, cache, scratch, logFile, label }) {
  if (!CHANNEL_NAME.test(channel)) {
    throw new LcrError(`${label}: the Rust channel ${JSON.stringify(channel)} is not a toolchain name`, {
      remedy: 'name a released channel such as 1.96.0 or stable in rust-toolchain.toml',
    });
  }

  copyForFetch(tree, scratch);

  try {
    const result = await runBuilder(channel, ['bash', '-c', FETCH_SCRIPT], {
      mounts: [
        { host: scratch, container: '/src', mode: 'rw' },
        { host: join(cache, 'cargo-home'), container: '/cargo', mode: 'rw' },
      ],
      env: { CARGO_HOME: '/cargo', RUSTUP_TOOLCHAIN: channel },
      network: true,
      check: false,
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    const code = returncode(result);

    writeText(logFile, result.stdout + result.stderr);

    if (result.timedOut) {
      throw new LcrError(`${label}: cargo fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    }

    if (code !== 0) {
      log(
        `${label}: cargo fetch failed (exit ${code}); the offline build will say what is missing (${logFile})`,
      );
    }

    return code;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * A copy of the tree without the files that steer cargo or rustup.
 *
 * @param {string} tree
 * @param {string} scratch
 * @returns {void}
 */
export function copyForFetch(tree, scratch) {
  rmSync(scratch, { recursive: true, force: true });
  cpSync(tree, scratch, { recursive: true, verbatimSymlinks: true });

  for (const name of STEERING_FILES) {
    rmSync(join(scratch, name), { recursive: true, force: true });
  }
}
