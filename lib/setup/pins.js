/**
 * The Playwright pins in compose.yaml: which `mcr.microsoft.com/playwright` image each engine
 * profile builds on.
 *
 * Stage: setup (build, `--update`), doctor, and every stage that runs a browser container (the
 * image tag derives from the pin). A pin is the only place a profile's Playwright version is
 * written: the base image, the Playwright npm client and the `lcr-browsers:pw-<version>` tag all
 * come from it.
 *
 * Two spellings, both owned by this repository's compose.yaml:
 * - the latest profile: a `playwright-<profile>` service whose `dockerfile_inline` is a single
 *   `FROM <image>` line (the form Dependabot's docker-compose updater reads and bumps);
 * - the frozen legacy profiles: `<profile>: <image>` entries under the top-level `x-frozen-pins`
 *   key, which Dependabot never reads.
 * The file is read as text with these two patterns rather than through `docker compose config`,
 * so tag names are known without Docker and without the variables compose.yaml requires.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { COMPOSE_FILE } from '../core/compose.js';
import { LcrError } from '../core/errors.js';
import { writeAtomic } from '../core/files.js';

/**
 * @typedef {object} PlaywrightPin
 * @property {string} image `mcr.microsoft.com/playwright:v1.64.1-noble`.
 * @property {string} version `1.64.1`.
 * @property {string} distro `noble`, or `''` for the oldest images (no distro suffix).
 */

const PIN_SERVICE_PREFIX = 'playwright-';
const FROZEN_PINS_KEY = 'x-frozen-pins';
const PLAYWRIGHT_IMAGE = /^mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)(?:-([a-z]+))?$/;
/** A top-level YAML key (`services:`, `x-frozen-pins:`). */
const TOP_LEVEL_KEY = /^([A-Za-z][\w.-]*):/;
/** A key indented by two spaces: a service name, or a frozen pin with its image. */
const SECOND_LEVEL_KEY = /^ {2}([\w.-]+):[ \t]*(\S*)[ \t]*$/;
/** The pin service's base image. */
const INLINE_FROM = /^\s+dockerfile_inline:\s*FROM\s+(\S+)\s*$/;

/**
 * Split a Playwright image reference into its parts; null for anything else.
 *
 * @param {string} image
 * @returns {PlaywrightPin | null}
 */
export function parsePlaywrightImage(image) {
  const match = PLAYWRIGHT_IMAGE.exec(image);

  return match ? { image, version: match[1], distro: match[2] ?? '' } : null;
}

/**
 * Where each pin sits in compose.yaml: profile -> line index and image.
 *
 * @param {readonly string[]} lines
 * @returns {Map<string, { line: number, image: string }>}
 */
function locatePins(lines) {
  /** @type {Map<string, { line: number, image: string }>} */
  const pins = new Map();
  let section = '';
  let service = '';

  for (const [index, line] of lines.entries()) {
    const top = TOP_LEVEL_KEY.exec(line);

    if (top) {
      section = top[1];
      service = '';
      continue;
    }

    const second = SECOND_LEVEL_KEY.exec(line);

    if (second && section === FROZEN_PINS_KEY && second[2]) {
      pins.set(second[1], { line: index, image: second[2] });
    } else if (second) {
      service = second[1];
    }

    const inline = INLINE_FROM.exec(line);

    if (inline && section === 'services' && service.startsWith(PIN_SERVICE_PREFIX)) {
      pins.set(service.slice(PIN_SERVICE_PREFIX.length), { line: index, image: inline[1] });
    }
  }

  return pins;
}

/**
 * Every profile's pin, from compose.yaml (or another compose file's text, for tests).
 *
 * @param {string} [text] compose.yaml's content.
 * @returns {Map<string, PlaywrightPin>}
 */
export function readPins(text = readFileSync(COMPOSE_FILE, 'utf8')) {
  /** @type {Map<string, PlaywrightPin>} */
  const pins = new Map();

  for (const [profile, { image }] of locatePins(text.split('\n'))) {
    const pin = parsePlaywrightImage(image);

    if (!pin) {
      throw new LcrError(`compose.yaml pins ${profile} to ${image}, which is not a Playwright image`, {
        remedy: 'use mcr.microsoft.com/playwright:v<version>[-<distro>]',
      });
    }

    pins.set(profile, pin);
  }

  return pins;
}

/**
 * compose.yaml's text with one profile's pin moved to `image` (nothing else changes).
 *
 * @param {string} text
 * @param {string} profile
 * @param {string} image
 * @returns {string}
 */
export function withPin(text, profile, image) {
  const lines = text.split('\n');
  const pin = locatePins(lines).get(profile);

  if (!pin) {
    throw new LcrError(`compose.yaml has no Playwright pin for engine profile ${profile}`);
  }

  lines[pin.line] = lines[pin.line].replace(pin.image, image);

  return lines.join('\n');
}

/**
 * Rewrite one profile's pin in compose.yaml.
 *
 * @param {string} profile
 * @param {string} image
 * @returns {void}
 */
export function writePin(profile, image) {
  const text = withPin(readFileSync(COMPOSE_FILE, 'utf8'), profile, image);

  writeAtomic(COMPOSE_FILE, (tmp) => writeFileSync(tmp, text));
}
