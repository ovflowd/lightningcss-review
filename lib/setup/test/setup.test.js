import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { captureOutput, tempDir, withEnv, writeFiles } from '../../../test/helpers/index.js';
import { browsersTag, defaultProfiles, playwrightPin } from '../images.js';
import { parsePlaywrightImage } from '../pins.js';
import { candidatePin, doctor, updateLatest, withProvisionalEnv } from '../setup.js';

/** @import { PlaywrightPin } from '../pins.js' */

test('the update candidate keeps the pinned distro', () => {
  const current = /** @type {PlaywrightPin} */ (
    parsePlaywrightImage('mcr.microsoft.com/playwright:v1.64.1-noble')
  );

  assert.deepEqual(candidatePin(current, '1.65.0'), {
    image: 'mcr.microsoft.com/playwright:v1.65.0-noble',
    version: '1.65.0',
    distro: 'noble',
  });

  const bare = /** @type {PlaywrightPin} */ (parsePlaywrightImage('mcr.microsoft.com/playwright:v1.4.2'));

  assert.equal(candidatePin(bare, '1.5.0').image, 'mcr.microsoft.com/playwright:v1.5.0');
});

test('--update does nothing when the pin is the newest release', async (t) => {
  const current = playwrightPin('latest');
  const stderr = t.mock.method(process.stderr, 'write', () => true);
  const fail = async () => assert.fail('must not be called');

  assert.deepEqual(
    await updateLatest({ newestRelease: async () => current.version, imagePublished: fail, selftest: fail }),
    current,
  );
  stderr.mock.restore();
  assert.match(String(stderr.mock.calls[0].arguments[0]), /is the newest release; nothing to update/);
});

test('--update refuses a release whose image is not published, before building anything', async (t) => {
  t.mock.method(process.stderr, 'write', () => true);

  await assert.rejects(
    updateLatest({
      newestRelease: async () => '99.0.0',
      imagePublished: async () => false,
      selftest: async () => assert.fail('must not be called'),
    }),
    { name: 'LcrError', message: /v99\.0\.0-noble is not published yet; try `lcr setup --update` later/ },
  );
  assert.equal(playwrightPin('latest').version === '99.0.0', false);
});

test('a failed selftest puts env.json back; a passing one keeps the new entries', async () => {
  using dir = tempDir();
  using _env = withEnv({ LCR_CACHE: dir.path });
  const envPath = join(dir.path, 'env.json');
  /** @type {import('../../types.js').EnvProfile} */
  const entry = { image: 'lcr-browsers:pw-9.9.9-analysis', image_id: null, role: 'reference', versions: {} };
  const original = '{\n  "profiles": {},\n  "skill_version": "0"\n}\n';

  assert.equal(await withProvisionalEnv({ latest: entry }, async () => 1), 1);
  assert.equal(existsSync(envPath), false);

  writeFileSync(envPath, original);
  assert.equal(
    await withProvisionalEnv({ latest: entry }, async () => {
      assert.match(readFileSync(envPath, 'utf8'), /pw-9\.9\.9/);

      return 1;
    }),
    1,
  );
  assert.equal(readFileSync(envPath, 'utf8'), original);
  await assert.rejects(
    withProvisionalEnv({ latest: entry }, async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(readFileSync(envPath, 'utf8'), original);
  assert.equal(await withProvisionalEnv({ latest: entry }, async () => 0), 0);
  assert.match(readFileSync(envPath, 'utf8'), /pw-9\.9\.9/);
});

/**
 * A PATH holding only fake `git`, `gh` and `docker` (plus the shell tools they use). `docker`
 * answers the version and daemon queries; images exist only when listed in `images`.
 *
 * @param {string} dir
 * @param {{ images: string[], plugins: boolean }} options
 * @returns {string}
 */
function fakeTools(dir, { images, plugins }) {
  const bin = join(dir, 'bin');
  const tags = images.map((tag) => `"${tag}"`).join(' ');

  writeFiles(bin, {
    git: '#!/bin/sh\nexit 0\n',
    gh: '#!/bin/sh\necho "github.com"\necho "  Logged in to github.com account someone"\n',
    docker: [
      '#!/bin/sh',
      'case "$1 $2" in',
      `  "compose version") ${plugins ? 'echo "Docker Compose version v2.40.0"; exit 0' : 'exit 1'} ;;`,
      `  "buildx version") ${plugins ? 'echo "github.com/docker/buildx v0.29.0 abc"; exit 0' : 'exit 1'} ;;`,
      '  "info --format") echo "28.5.1"; exit 0 ;;',
      '  "image inspect") for tag in ' + (tags || '""') + '; do [ "$3" = "$tag" ] && exit 0; done; exit 1 ;;',
      'esac',
      'exit 1',
      '',
    ].join('\n'),
  });

  for (const name of ['git', 'gh', 'docker']) {
    chmodSync(join(bin, name), 0o755);
  }

  return `${bin}:/usr/bin:/bin`;
}

test('doctor lists every requirement and names the fix for what is missing', async () => {
  using dir = tempDir();
  const repo = join(dir.path, 'repo');
  const latest = browsersTag('latest');

  mkdirSync(join(repo, '.git'), { recursive: true });

  using _env = withEnv({
    PATH: fakeTools(dir.path, { images: [latest], plugins: false }),
    LCR_CACHE: join(dir.path, 'cache'),
    LCR_REPO: repo,
  });
  const { stdout, result } = await captureOutput(() => doctor());
  const rows = new Map(
    stdout
      .trimEnd()
      .split('\n')
      .map((line) => {
        const [name, rest] = line.split(/ {2,}(?=ok|MISSING)/);

        return [name.trim(), rest];
      }),
  );

  assert.equal(result, 1, 'a missing plugin fails the doctor');
  assert.match(String(rows.get('git')), /^ok +.*\/bin\/git$/);
  assert.match(String(rows.get('gh auth')), /^ok +Logged in to github.com account someone$/);
  assert.match(String(rows.get('docker compose')), /^MISSING +install: /);
  assert.match(String(rows.get('docker buildx')), /^MISSING +install: /);
  assert.match(String(rows.get('docker daemon access')), /^ok +28\.5\.1$/);
  assert.match(String(rows.get('lightningcss clone')), /^ok /);
  assert.match(String(rows.get(`image ${latest}`)), /^ok +\{\}$/);

  for (const profile of defaultProfiles().filter((name) => name !== 'latest')) {
    assert.match(
      String(rows.get(`image ${browsersTag(profile)}`)),
      new RegExp(`^MISSING +run \`lcr setup --profiles ${profile}\`$`),
    );
  }
});
