import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { PNG } from 'pngjs';

import { tempDir } from '../../test/helpers/index.js';
import { imagesDiffer, judgeShots, pixelCompare, shotFile } from '../lib/shots.mjs';

/** @import { DecodedPng } from 'pngjs' */

/**
 * A solid image, with `changed` pixels set to another color.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} [changed]
 * @param {number} [delta] Channel difference of the changed pixels.
 * @returns {DecodedPng}
 */
function image(width, height, changed = 0, delta = 255) {
  const data = new Uint8Array(width * height * 4).fill(100);

  for (let i = 0; i < changed; i++) {
    data[i * 4] = 100 + delta > 255 ? 0 : 100 + delta;
  }

  return { width, height, data };
}

/**
 * @param {string} file
 * @param {DecodedPng} decoded
 */
function writePng(file, decoded) {
  const png = new /** @type {any} */ (PNG)({ width: decoded.width, height: decoded.height });

  png.data = Buffer.from(decoded.data);
  writeFileSync(file, /** @type {any} */ (PNG).sync.write(png));
}

describe('shotFile', () => {
  test('ids never become directories', () => {
    assert.equal(shotFile('/s', 'p-a/b\\c', 'webkit', 'head'), '/s/p-a__b__c.webkit.head.png');
  });
});

describe('imagesDiffer', () => {
  test('tolerates channel noise up to 3 on up to 0.1% of pixels', () => {
    assert.equal(imagesDiffer(image(100, 100), image(100, 100, 10_000, 3)), false);
    assert.equal(imagesDiffer(image(100, 100), image(100, 100, 10)), false);
    assert.equal(imagesDiffer(image(100, 100), image(100, 100, 11)), true);
    assert.equal(imagesDiffer(image(10, 10), image(10, 11)), true);
  });

  test('an empty image is never within tolerance', () => {
    assert.equal(imagesDiffer(image(0, 0), image(0, 0)), true);
  });
});

describe('pixelCompare and judgeShots', () => {
  test('decodes the PNGs; missing files or no directory are different', () => {
    using dir = tempDir();

    writePng(shotFile(dir.path, 'a/b', 'chromium', 'input'), image(20, 20));
    writePng(shotFile(dir.path, 'a/b', 'chromium', 'head'), image(20, 20));
    writePng(shotFile(dir.path, 'a/b', 'chromium', 'base'), image(20, 20, 50));

    assert.equal(pixelCompare(dir.path, 'a/b', 'chromium', 'head', 'input'), 'pixel-near');
    assert.equal(pixelCompare(dir.path, 'a/b', 'chromium', 'base', 'input'), 'pixel-different');
    assert.equal(pixelCompare(dir.path, 'a/b', 'webkit', 'base', 'input'), 'pixel-different');
    assert.equal(pixelCompare(null, 'a/b', 'chromium', 'head', 'input'), 'pixel-different');
    assert.deepEqual(judgeShots({ input: 'h1', base: 'h2', head: 'h3' }, dir.path, 'a/b', 'chromium'), {
      base: 'pixel-different',
      head: 'pixel-near',
    });
  });

  test('equal hashes are identical without decoding; a side without a shot is null', () => {
    assert.deepEqual(judgeShots({ input: 'h', base: 'h' }, null, 'x', 'webkit'), {
      base: 'pixel-identical',
      head: null,
    });
    assert.deepEqual(judgeShots({ base: 'h' }, null, 'x', 'webkit'), { base: null, head: null });
    assert.deepEqual(join('a', 'b'), 'a/b');
  });
});
