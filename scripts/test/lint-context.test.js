import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { run } from '../../lib/core/proc.js';
import { FIXTURES_DIR, REPO_ROOT, tempDir, writeFiles } from '../../test/helpers/index.js';
import { lintContext } from '../lint-context.js';

test('the agent context passes (the script, run as CI runs it)', async () => {
  const result = await run([process.execPath, join(REPO_ROOT, 'scripts', 'lint-context.js')], {
    check: false,
  });

  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /^\d+ files, \d+ bytes, 0 problems\n$/);
});

test('history, line references and oversized files are reported once per line', (t) => {
  using dir = tempDir();
  const out = t.mock.method(process.stdout, 'write', () => true);

  writeFiles(dir.path, {
    'SKILL.md': 'ok\r\n',
    'references/a.md': [
      'See #123 and PR 45',
      'PR 45 alone',
      'commit deadbeef1 here',
      'since v1.25.3',
      'src/x.rs:12',
      'https://github.com/x/pull/1234 is a link',
      'foo_#12 and &#123; are not issues',
    ].join('\n'),
    'references/big.md': `${'x'.repeat(9001)}\n`,
  });

  const status = lintContext(dir.path);

  out.mock.restore();
  assert.equal(status, 1);
  assert.deepEqual(
    out.mock.calls.map((call) => call.arguments[0]),
    [
      "references/a.md:1: issue/PR number: '#123'\n",
      "references/a.md:2: issue/PR reference: 'PR 45'\n",
      "references/a.md:3: commit hash: 'deadbeef1'\n",
      "references/a.md:4: Lightning CSS release version: 'v1.25.3'\n",
      "references/a.md:5: file:line reference: '.rs:12'\n",
      'references/big.md: 9002 bytes > budget 9000\n',
      '3 files, 9158 bytes, 6 problems\n',
    ],
  );
});

test('a tree with planted problems prints what py-final printed, byte for byte', (t) => {
  using dir = tempDir();
  const golden =
    /** @type {{ files: Record<string, string>, outputs: Record<string, { stdout: string, status: number }> }} */ (
      JSON.parse(readFileSync(join(FIXTURES_DIR, 'infra', 'scripts.json'), 'utf8'))
    );

  writeFiles(dir.path, golden.files);

  const out = t.mock.method(process.stdout, 'write', () => true);
  const status = lintContext(dir.path);

  out.mock.restore();
  assert.equal(
    out.mock.calls.map((call) => call.arguments[0]).join(''),
    golden.outputs['lint_context.py'].stdout,
  );
  assert.equal(status, golden.outputs['lint_context.py'].status);
});
