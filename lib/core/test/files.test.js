import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { asPythonJson, buildGolden } from '../../../test/fixtures/build/golden.js';
import { tempDir } from '../../../test/helpers/index.js';
import { LcrError } from '../errors.js';
import {
  countPyLines,
  fileSha256,
  iterJsonl,
  readJson,
  readJsonl,
  readPyText,
  universalNewlines,
  writeAtomic,
  writeJson,
  writeJsonl,
} from '../files.js';
import { pyFloat } from '../pyjson.js';

test('writeJson writes the stage-file layout atomically and readJson reads it back', () => {
  using dir = tempDir();
  const path = join(dir.path, 'nested', 'x.json');

  writeJson(path, { b: pyFloat(1), a: ['é'] });

  assert.equal(readFileSync(path, 'utf8'), '{\n  "a": [\n    "é"\n  ],\n  "b": 1.0\n}\n');
  assert.deepEqual(readdirSync(join(dir.path, 'nested')), ['x.json']);
  assert.equal(readJson(join(dir.path, 'missing.json')), null);
  assert.deepEqual(readJson(join(dir.path, 'missing.json'), {}), {});
});

test('a failed atomic write leaves neither the file nor the .tmp behind; ENOSPC names the remedy', () => {
  using dir = tempDir();
  const path = join(dir.path, 'x.json');
  const full = Object.assign(new Error('No space left on device'), { code: 'ENOSPC' });

  assert.throws(
    () =>
      writeAtomic(path, (tmp) => {
        writeFileSync(tmp, 'partial');

        throw full;
      }),
    (error) => error instanceof LcrError && error.message.includes('lcr clean'),
  );
  assert.deepEqual(readdirSync(dir.path), []);
});

test('JSONL streams across chunk boundaries and multi-byte characters', () => {
  using dir = tempDir();
  const path = join(dir.path, 'rows.jsonl');
  const rows = Array.from({ length: 3000 }, (_, index) => ({
    id: `r${index}`,
    text: 'é😀'.repeat(200 + (index % 7)),
  }));

  assert.equal(
    writeJsonl(
      path,
      (function* () {
        yield* rows;
      })(),
    ),
    rows.length,
  );
  assert.deepEqual(readJsonl(path), rows);
  assert.equal([...iterJsonl(join(dir.path, 'missing.jsonl'))].length, 0);
  assert.match(readFileSync(path, 'utf8').split('\n')[0], /^\{"id": "r0", "text": "é😀/);
});

test('fileSha256 hashes bytes and is null for a missing file', () => {
  using dir = tempDir();
  const path = join(dir.path, 'f');

  writeFileSync(path, 'abc');
  assert.equal(fileSha256(path), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(fileSha256(join(dir.path, 'nope')), null);
  assert.equal(existsSync(`${path}.tmp`), false);
});

test('readPyText: universal newlines, BOM kept, strict or replacing decoding', () => {
  using dir = tempDir();
  const path = join(dir.path, 'a.css');

  writeFileSync(path, Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0x62, 0x0d, 0x63, 0xff]));

  assert.throws(() => readPyText(path));
  assert.equal(
    readPyText(path, { replace: true }),
    `${String.fromCodePoint(0xfeff)}a\nb\nc${String.fromCodePoint(0xfffd)}`,
  );
});

test('readPyText and countPyLines read files as Python text mode does', () => {
  using dir = tempDir();

  for (const [bytes, text, lines] of buildGolden().universal_newlines) {
    const path = join(dir.path, 'f.txt');

    writeFileSync(path, Buffer.from(bytes));
    assert.equal(readPyText(path, { replace: true }), text);
    assert.equal(countPyLines(path), lines, asPythonJson(bytes));
  }
});

test('universalNewlines turns CRLF and lone CR into LF', () => {
  assert.equal(universalNewlines('a\r\nb\rc\n'), 'a\nb\nc\n');
});
