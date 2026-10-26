import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { tempDir } from '../../test/helpers/index.js';
import { openRowWriter, readRows } from '../runner/jsonl.cjs';

describe('runner jsonl', () => {
  test('reads plain and gzip files line by line', async () => {
    using dir = tempDir();

    writeFileSync(join(dir.path, 'a.jsonl'), '{"id":"a"}\n\n{"id":"b"}');
    writeFileSync(join(dir.path, 'a.jsonl.gz'), gzipSync('{"id":"a"}\n{"id":"b"}\n'));

    for (const name of ['a.jsonl', 'a.jsonl.gz']) {
      assert.deepEqual(await Array.fromAsync(readRows(join(dir.path, name))), [{ id: 'a' }, { id: 'b' }]);
    }
  });

  test('a missing input file is an error (the runner needs its jobs)', async () => {
    await assert.rejects(Array.fromAsync(readRows('/nonexistent/jobs.jsonl')), { code: 'ENOENT' });
  });

  test('the writer resolves once the file is complete', async () => {
    using dir = tempDir();
    const file = join(dir.path, 'out.jsonl');
    const writer = openRowWriter(file);

    writer.write({ id: 'a', ms: 3 });
    writer.write({ id: 'b' });
    await writer.end();

    assert.equal(readFileSync(file, 'utf8'), '{"id":"a","ms":3}\n{"id":"b"}\n');
  });
});
