import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { REPO_ROOT } from '../../../test/helpers/index.js';
import { COMPOSE_FILE } from '../../core/compose.js';
import { loadConfig } from '../../core/paths.js';
import { compareCodePoints } from '../../core/pyjson.js';
import {
  browsersService,
  browsersTag,
  builderTag,
  composeVariables,
  defaultProfiles,
  overridePin,
  playwrightPin,
} from '../images.js';
import { parsePlaywrightImage, readPins, withPin } from '../pins.js';

/** @import { EnginesConfig } from '../../types.js' */

const COMPOSE = readFileSync(COMPOSE_FILE, 'utf8');
const ENGINES = /** @type {EnginesConfig} */ (loadConfig('engines.json'));

test('every engine profile has a Playwright pin and a browser service', () => {
  const pins = readPins();

  assert.deepEqual(
    [...pins.keys()].sort(compareCodePoints),
    Object.keys(ENGINES.profiles).sort(compareCodePoints),
  );

  for (const profile of Object.keys(ENGINES.profiles)) {
    assert.match(COMPOSE, new RegExp(`^  ${browsersService(profile)}:$`, 'm'), profile);
  }
});

test('image tags keep the names existing images and env.json use', () => {
  assert.equal(builderTag('1.96.0'), 'lcr-builder:rust-1.96.0');
  assert.equal(browsersTag('latest'), `lcr-browsers:pw-${playwrightPin('latest').version}-analysis`);
  assert.match(browsersTag('legacy-2021'), /^lcr-browsers:pw-1\.16\.3$/);
  assert.throws(() => browsersTag('nope'), {
    name: 'LcrError',
    message: `unknown engine profile nope; pick one of ${Object.keys(ENGINES.profiles).join(', ')} (config/engines.json)`,
  });
  assert.throws(() => browsersTag('constructor'), /unknown engine profile constructor/);
  assert.deepEqual(defaultProfiles(), ENGINES.default_profiles);
});

test("compose.yaml's image templates spell the same tags as browsersTag", () => {
  const variables = composeVariables('1.96.0');

  for (const profile of Object.keys(ENGINES.profiles)) {
    const block = COMPOSE.slice(COMPOSE.indexOf(`  ${browsersService(profile)}:`));
    const template = /^ {4}image: (.+)$/m.exec(block)?.[1] ?? '';
    const tag = template.replaceAll(/\$\{(\w+)(?::[?-][^}]*)?\}/g, (_match, name) => variables[name]);

    assert.equal(tag, browsersTag(profile), profile);
  }

  assert.match(COMPOSE, /image: lcr-builder:rust-\$\{LCR_RUST_CHANNEL:-stable\}/);
  assert.equal(variables.LCR_RUST_CHANNEL, '1.96.0');
  assert.equal(variables.LCR_BASE_LEGACY_2023, 'mcr.microsoft.com/playwright:v1.30.0-focal');
  assert.equal(variables.LCR_PLAYWRIGHT_LEGACY_2023, '1.30.0');
});

test('Dependabot sees only the latest pin: a single FROM in a service, legacy pins outside services', () => {
  const froms = [...COMPOSE.matchAll(/dockerfile_inline: FROM (\S+)/g)].map((match) => match[1]);

  assert.deepEqual(froms, [playwrightPin('latest').image]);
  assert.ok(COMPOSE.indexOf('x-frozen-pins:') < COMPOSE.indexOf('services:'));
  // No literal Playwright image anywhere Dependabot reads (`image:` keys).
  assert.doesNotMatch(COMPOSE, /image: mcr\.microsoft\.com/);
});

test('an override pin replaces the compose pin until disposed', () => {
  const pin = /** @type {import('../pins.js').PlaywrightPin} */ (
    parsePlaywrightImage('mcr.microsoft.com/playwright:v9.8.7-noble')
  );

  {
    using _pin = overridePin('latest', pin);

    assert.equal(browsersTag('latest'), 'lcr-browsers:pw-9.8.7-analysis');
    assert.equal(composeVariables().LCR_BASE_LATEST, pin.image);
  }

  assert.notEqual(browsersTag('latest'), 'lcr-browsers:pw-9.8.7-analysis');
});

test('pins parse, and rewriting one pin changes only that line', () => {
  assert.deepEqual(parsePlaywrightImage('mcr.microsoft.com/playwright:v1.4.2'), {
    image: 'mcr.microsoft.com/playwright:v1.4.2',
    version: '1.4.2',
    distro: '',
  });
  assert.equal(parsePlaywrightImage('node:24'), null);

  const latest = playwrightPin('latest');
  const moved = withPin(COMPOSE, 'latest', 'mcr.microsoft.com/playwright:v9.0.0-noble');
  const changed = moved.split('\n').filter((line, index) => line !== COMPOSE.split('\n')[index]);

  assert.deepEqual(changed, ['      dockerfile_inline: FROM mcr.microsoft.com/playwright:v9.0.0-noble']);
  assert.equal(readPins(moved).get('latest')?.version, '9.0.0');
  assert.equal(readPins(moved).get('legacy-2023')?.version, '1.30.0');
  assert.ok(COMPOSE.includes(latest.image));

  const frozen = withPin(COMPOSE, 'legacy-2021', 'mcr.microsoft.com/playwright:v1.17.0-focal');

  assert.equal(readPins(frozen).get('legacy-2021')?.version, '1.17.0');
  assert.throws(() => withPin(COMPOSE, 'nope', 'x'), /no Playwright pin for engine profile nope/);
  assert.throws(() => readPins('x-frozen-pins:\n  legacy-2021: node:24\n'), /not a Playwright image/);
});

test("the analysis image's packages are the versions the oracle's unit tests run against", () => {
  const extra = /^\s+EXTRA_PACKAGES: (.+)$/m.exec(COMPOSE);
  const devDependencies = /** @type {{ devDependencies: Record<string, string> }} */ (
    JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
  ).devDependencies;

  assert.ok(extra, 'compose.yaml lists EXTRA_PACKAGES for browsers-latest');

  for (const spec of extra[1].trim().split(/\s+/)) {
    const at = spec.lastIndexOf('@');
    const [name, version] = [spec.slice(0, at), spec.slice(at + 1)];

    // @webref/css only runs in the image (spec-cards.mjs); the others are also dev dependencies.
    if (Object.hasOwn(devDependencies, name)) {
      assert.equal(version, devDependencies[name], `${name}: compose.yaml and package.json disagree`);
    }
  }
});
