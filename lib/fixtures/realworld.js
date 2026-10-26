/**
 * The real-world stylesheet corpus: large, popular stylesheets pinned by URL and sha256 in
 * config/realworld.json, downloaded once into `<cache>/realworld/<name>.css`.
 *
 * Stage: `lcr realworld` downloads; corpus (the realworld lane) and perf (release-build timing)
 * read the files through `availableFiles`.
 *
 * Invariants:
 * - A file is used only when its bytes match the pinned sha256, so every review runs on exactly
 *   the same CSS; an upstream change is an error, never a silent new input.
 * - An entry without a pin is pinned on first download (config/realworld.json is rewritten with
 *   its sha256 and size), which is how new files are added.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { LcrError } from '../core/errors.js';
import { writeJson } from '../core/files.js';
import { sha256 } from '../core/ids.js';
import { log } from '../core/log.js';
import { cacheDir, CONFIG_DIR, loadConfig } from '../core/paths.js';
import { pyCompare } from '../core/py.js';
import { fetchChecked } from '../setup/http.js';

/** How long one download may take. */
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** Pins are shown shortened in the mismatch message. */
const SHORT_HASH_CHARS = 12;
/** Sent with every download; some CDNs refuse requests without a user agent. */
const USER_AGENT = 'lightningcss-review';

/**
 * @typedef {object} RealworldEntry config/realworld.json `files[]`.
 * @property {string} name
 * @property {string} url
 * @property {string} [sha256]
 * @property {number} [bytes]
 */

/**
 * @typedef {object} RealworldConfig config/realworld.json
 * @property {RealworldEntry[]} files
 */

/**
 * `<cache>/realworld`, created if missing.
 *
 * @returns {string}
 */
export function realworldDir() {
  const dir = join(cacheDir(), 'realworld');

  mkdirSync(dir, { recursive: true });

  return dir;
}

/**
 * Download every missing or changed file; resolves to the real-world directory.
 *
 * @returns {Promise<string>}
 */
export async function ensureRealworld() {
  const config = /** @type {RealworldConfig} */ (loadConfig('realworld.json'));
  let pinned = false;

  for (const entry of config.files) {
    const path = join(realworldDir(), `${entry.name}.css`);

    if (isVerified(path, entry)) {
      continue;
    }

    log(`fetching ${entry.url}`);

    const data = await download(entry.url);
    const digest = sha256(data);

    if (entry.sha256 && entry.sha256 !== digest) {
      throw new LcrError(
        `${entry.name}: sha256 mismatch (pinned ${entry.sha256.slice(0, SHORT_HASH_CHARS)}, got ${digest.slice(0, SHORT_HASH_CHARS)}); the upstream file changed`,
      );
    }

    if (!entry.sha256) {
      entry.sha256 = digest;
      entry.bytes = data.length;
      pinned = true;
    }

    writeFileSync(path, data);
  }

  if (pinned) {
    writeJson(join(CONFIG_DIR, 'realworld.json'), config);
    log('pinned new sha256 values in config/realworld.json');
  }

  return realworldDir();
}

/**
 * `[name, path]` of every downloaded file whose bytes match its pin, sorted by name.
 *
 * @returns {[string, string][]}
 */
export function availableFiles() {
  const config = /** @type {RealworldConfig} */ (loadConfig('realworld.json'));
  /** @type {[string, string][]} */
  const files = [];

  for (const entry of config.files) {
    const path = join(realworldDir(), `${entry.name}.css`);

    if (isVerified(path, entry)) {
      files.push([entry.name, path]);
    }
  }

  if (files.length === 0) {
    log('real-world corpus not downloaded; run `lcr realworld` once');
  }

  return files.sort(pyCompare);
}

/**
 * True when the file exists and matches its pin (an unpinned entry never verifies).
 *
 * @param {string} path
 * @param {RealworldEntry} entry
 * @returns {boolean}
 */
function isVerified(path, entry) {
  return existsSync(path) && entry.sha256 === sha256(readFileSync(path));
}

/**
 * The body of a URL, or an `LcrError` saying why it could not be fetched.
 *
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
async function download(url) {
  const response = await fetchChecked(url, {
    headers: { 'User-Agent': USER_AGENT },
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    remedy: 'check the network, or the URL in config/realworld.json',
  });

  return Buffer.from(await response.arrayBuffer());
}
