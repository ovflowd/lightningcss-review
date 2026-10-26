import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { tempDir } from '../../../test/helpers/index.js';
import {
  decodeVersion,
  encodeVersion,
  featureBits,
  formatTargets,
  parseBrowsersDebug,
  parseFlagsDebug,
  parseTargets,
  parseTargetsDebug,
} from '../targets.js';

test('versions round-trip through the encoding', () => {
  assert.equal(encodeVersion('13.1'), (13 << 16) | (1 << 8));
  assert.equal(decodeVersion((13 << 16) | (1 << 8)), '13.1');
  assert.equal(decodeVersion(80 << 16), '80');
  assert.equal(decodeVersion((15 << 16) | (4 << 8) | 2), '15.4.2');
  assert.deepEqual(parseTargets('chrome 80, safari 13.1'), {
    chrome: 80 << 16,
    safari: (13 << 16) | (1 << 8),
  });
  assert.equal(parseTargets('none'), null);
  assert.equal(parseTargets(null), null);
  assert.equal(formatTargets({ safari: 852224, chrome: 5242880 }), 'chrome 80, safari 13.1');
  assert.equal(formatTargets(null), 'none');
});

test('an unknown browser is an error', () => {
  assert.throws(() => parseTargets('netscape 4'), { name: 'LcrError', message: /bad target 'netscape 4'/ });
});

test('Debug strings parse back into targets and feature bits', () => {
  const text = 'Browsers { android: None, chrome: Some(5898240), safari: Some(852224) }';

  assert.deepEqual(parseBrowsersDebug(text), { chrome: 5898240, safari: 852224 });
  assert.equal(parseBrowsersDebug('None'), null);

  const bits = { Nesting: 1, MediaRangeSyntax: 128, MediaQueries: 448 };

  assert.equal(parseFlagsDebug('Features(Nesting | MediaRangeSyntax)', bits), 129);
  assert.equal(parseFlagsDebug('Features(0x0)', bits), 0);
  assert.deepEqual(parseFlagsDebug('ParserFlags(NESTING | CUSTOM_MEDIA)'), ['NESTING', 'CUSTOM_MEDIA']);
  assert.throws(() => parseFlagsDebug('Features(Nope)', bits), /unknown flag Nope/);
  assert.deepEqual(
    parseTargetsDebug(
      'Targets { browsers: None, include: Features(MediaRangeSyntax), exclude: Features(0x0) }',
      bits,
    ),
    { targets: null, include: 128, exclude: 0 },
  );
});

test('feature bits are read from the tree, composites as the OR of their parts', () => {
  using dir = tempDir();

  mkdirSync(join(dir.path, 'src'));
  writeFileSync(
    join(dir.path, 'src', 'targets.rs'),
    'bitflags! {\n  pub struct Features: u32 {\n    const Nesting = 1 << 0;\n    const A = 1 << 3;\n    const Both = Self::Nesting.bits() | Self::A.bits();\n  }\n}\n',
  );
  assert.deepEqual(featureBits(dir.path), { Nesting: 1, A: 8, Both: 9 });
});

test('versions follow Python: Unicode digits and whitespace, OR-ed parts, no 32-bit wrap', () => {
  const arabicEighty = String.fromCodePoint(0x668, 0x660);
  const noBreakSpace = String.fromCodePoint(0xa0);

  assert.deepEqual(parseTargets(`chrome${noBreakSpace}${arabicEighty}`), { chrome: 80 << 16 });
  // A minor part above 255 spills into the major bits: the parts are OR-ed, not added.
  assert.equal(encodeVersion('1.300'), (1 << 16) | (300 << 8));
  assert.equal(encodeVersion('70000'), 70000 * 65536);
  assert.equal(decodeVersion(2 ** 32 - 1), '65535.255.255');
  assert.equal(decodeVersion(2 ** 31), '32768');
  // BOM is whitespace to JS's \s but not to Python's.
  assert.throws(() => parseTargets(`chrome${String.fromCodePoint(0xfeff)}80`), /bad target/);
});

test('Debug fields need a word boundary in Python terms', () => {
  const accented = String.fromCodePoint(0xe9);

  assert.deepEqual(parseBrowsersDebug(`${accented}chrome: Some(1) safari: Some(2)`), { safari: 2 });
});
