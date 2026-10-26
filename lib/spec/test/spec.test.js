import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { tempDir, writeFiles } from '../../../test/helpers/index.js';
import { loadConfig } from '../../core/paths.js';
import { compareCodePoints } from '../../core/pyjson.js';
import { coverageMarkdown, coverageRows, specCards, touchedProperties } from '../spec.js';

/** @import { PropertyEntry } from '../../types.js' */

const EM_DASH = String.fromCodePoint(0x2014);

test('touched properties: WPT deltas first, then the changed handler files, capped', () => {
  using dir = tempDir();
  const properties = /** @type {PropertyEntry[]} */ (loadConfig('properties.json'));
  const owned = properties.find((entry) => entry.file)?.file ?? '';
  const fromFile = properties
    .filter((entry) => entry.file === owned)
    .map((entry) => entry.name)
    .sort(compareCodePoints);

  writeFiles(dir.path, {
    'prepare.json': { files: { [owned]: {} } },
    'corpus/cases.jsonl': [
      { id: 'w-1', source: 'wpt', wpt: { property: 'zoom' } },
      { id: 'w-2', source: 'wpt', wpt: { property: 'zoom' } },
      { id: 't-1', source: 'tuple' },
    ],
    'corpus/deltas.jsonl': [{ id: 'w-1' }, { id: 't-1' }, { id: 'w-2' }, { id: 'gone' }],
  });

  const expected = [...new Set(['zoom', ...fromFile])].slice(0, 40);

  assert.deepEqual(touchedProperties(dir.path), expected);
  assert.deepEqual(touchedProperties(dir.path, 1), ['zoom']);
});

test('a run that touches no property gets an empty spec-cards.json without Docker', async () => {
  using dir = tempDir();

  writeFiles(dir.path, { 'prepare.json': { files: {} } });
  assert.deepEqual(await specCards(dir.path), {});
  assert.equal(
    readFileSync(join(dir.path, 'spec-cards.json'), 'utf8'),
    '{\n  "cards": {},\n  "order": []\n}\n',
  );
});

test('coverage counts typed properties, string literals and kebab-cased variants', () => {
  using dir = tempDir();

  writeFiles(dir.path, {
    'src/properties/mod.rs':
      'fn x() { "all" => return Ok(PropertyId::All) }\ndefine_properties! {\n  "color": Color,\n  "zoom": Zoom,\n}\n',
    'src/parser.rs': 'match name { "media" => 1 }',
    'src/rules/layer.rs': 'enum A { StartingStyle }',
    'src/selector.rs': 'PseudoClass::FocusVisible "hover"',
    'selectors/parser.rs': '',
    'src/values/calc.rs': '"round" Clamp',
  });

  const rows = coverageRows(
    {
      properties: [
        { name: 'color' },
        { name: 'all', href: 'https://x/all' },
        { name: 'gap' },
        { name: 'old', legacyAliasOf: 'x' },
      ],
      atrules: [{ name: '@media' }, { name: '@starting-style' }, { name: '@scope', href: 'https://x/scope' }],
      selectors: [
        { name: ':hover' },
        { name: ':focus-visible' },
        { name: '::part()' },
        { name: '*' },
        { name: ':Weird' },
      ],
      functions: ['round()', '<clamp()>', 'sin()'],
    },
    dir.path,
  );

  assert.deepEqual(rows.properties, [
    ['color', true, null],
    ['all', true, 'https://x/all'],
    ['gap', false, null],
  ]);
  assert.deepEqual(
    rows.atrules.map(([, implemented]) => implemented),
    [true, true, false],
  );
  assert.deepEqual(rows.selectors, [
    [':hover', true, null],
    [':focus-visible', true, null],
    ['::part()', false, null],
  ]);
  assert.deepEqual(
    rows.functions.map(([, implemented]) => implemented),
    [true, true, false],
  );

  const markdown = coverageMarkdown('/t', rows);

  assert.ok(markdown.includes('## properties: 2/3 implemented, 1 missing\n\n- `gap`\n\n'));
  assert.ok(markdown.includes(`- \`@scope\` ${EM_DASH} https://x/scope\n`));
  assert.ok(markdown.includes('\n- `::part()`\n'));
  assert.ok(markdown.endsWith('\n'));
});

test('an empty wpt object on a case names no property, as in Python', () => {
  using dir = tempDir();

  writeFiles(dir.path, {
    'prepare.json': { files: {} },
    'corpus/cases.jsonl': [
      { id: 'w-1', wpt: {} },
      { id: 'w-2', wpt: { property: 'zoom' } },
    ],
    'corpus/deltas.jsonl': [{ id: 'w-1' }, { id: 'w-2' }],
  });

  assert.deepEqual(touchedProperties(dir.path), ['zoom']);
});

test('sources are read as Python reads text: universal newlines, lines start only after \\n', () => {
  using dir = tempDir();
  const lineSeparator = String.fromCodePoint(0x2028);

  writeFiles(dir.path, {
    // CRLF line ends still start lines; a U+2028 inside a line does not (JS's `m` flag says it does).
    'src/properties/mod.rs': `define_properties! {\r\n  "color": Color,\r\n  x${lineSeparator}  "zoom": Zoom,\r\n}\r\n`,
    'src/parser.rs': '',
    'src/rules/a.rs': '',
    'src/selector.rs': '"hover"',
    'selectors/parser.rs': '',
  });

  const rows = coverageRows(
    {
      properties: [{ name: 'color' }, { name: 'zoom' }],
      atrules: [],
      // Python's `$` in re.sub also matches before a final newline.
      selectors: [{ name: ':hover()\n' }],
      functions: [],
    },
    dir.path,
  );

  assert.deepEqual(rows.properties, [
    ['color', true, null],
    ['zoom', false, null],
  ]);
  assert.deepEqual(rows.selectors, [[':hover()\n', false, null]]);
});

test('a tree without src/properties/mod.rs is an LcrError, not a stack trace', () => {
  using dir = tempDir();

  assert.throws(() => coverageRows({ properties: [], atrules: [], selectors: [], functions: [] }, dir.path), {
    name: 'LcrError',
    message: /^not a Lightning CSS source tree: .*; pass a checkout with --tree$/,
  });
});
