import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { gunzipSync } from 'node:zlib';

import { tempDir } from '../../test/helpers/index.js';
import { jsonlWriter, readAll, readJsonl } from '../lib/jsonl.mjs';

describe('jsonl', () => {
  test('streams round-trip, gzip included', async () => {
    using dir = tempDir();

    for (const name of ['r.jsonl', 'r.jsonl.gz']) {
      const file = join(dir.path, name);
      const writer = jsonlWriter(file);

      for (let i = 0; i < 3; i++) {
        writer.write({ i, s: 'x'.repeat(1000) });
      }

      await writer.end();

      assert.deepEqual(
        (await readAll(file)).map((row) => /** @type {{ i: number }} */ (row).i),
        [0, 1, 2],
      );
    }

    assert.equal(
      gunzipSync(readFileSync(join(dir.path, 'r.jsonl.gz')))
        .toString()
        .split('\n').length,
      4,
    );
  });

  test('rows are compact JSON.stringify lines in insertion order', async () => {
    using dir = tempDir();
    const file = join(dir.path, 'r.jsonl');
    const writer = jsonlWriter(file);

    writer.write({ b: 1, a: [1.5, null, 'é'] });
    await writer.end();

    assert.equal(readFileSync(file, 'utf8'), '{"b":1,"a":[1.5,null,"é"]}\n');
  });

  test('blank lines are skipped; a missing or unnamed file reads as empty', async () => {
    using dir = tempDir();
    const file = join(dir.path, 'r.jsonl');

    writeFileSync(file, '{"a":1}\n\n  \r\n{"a":2}\r\n');

    assert.deepEqual(await readAll(file), [{ a: 1 }, { a: 2 }]);
    assert.deepEqual(await readAll(join(dir.path, 'missing.jsonl')), []);
    assert.deepEqual(await Array.fromAsync(readJsonl(undefined)), []);
  });
});
