import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { run } from '../../lib/core/proc.js';
import { FIXTURES_DIR, REPO_ROOT, tempDir, writeFiles } from '../../test/helpers/index.js';
import { checkChecklists, checklistProblems } from '../check-checklists.js';

test('the checklists pass (the script, run as CI runs it)', async () => {
  const result = await run([process.execPath, join(REPO_ROOT, 'scripts', 'check-checklists.js')], {
    check: false,
  });

  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /^\d+ checklists, 0 problems\n$/);
});

test('format problems are reported in file order', (t) => {
  const text = [
    '- [ZZ-1] (MAJOR) one',
    '  verify: x',
    '- [ZZ-3] (MINOR) two',
    '- [YY-4] (NOTE) three',
    '  verify: y',
    '- [bad',
  ].join('\n');

  assert.deepEqual(checklistProblems('zz.md', text), [
    'zz.md:3: item without a verify: line',
    'zz.md:6: malformed item',
    "zz.md: more than one id prefix ['YY', 'ZZ']",
    'zz.md: ids are not numbered 1..3 without gaps',
  ]);

  using dir = tempDir();
  const out = t.mock.method(process.stdout, 'write', () => true);

  writeFiles(dir.path, { 'a.md': '- [A-1] (NOTE) x\n  verify: y\n', 'b.md': text, 'notes.txt': '- [bad' });

  const status = checkChecklists(dir.path);

  out.mock.restore();
  assert.equal(status, 1);
  assert.equal(out.mock.calls.at(-1)?.arguments[0], '2 checklists, 4 problems\n');
});

test('a tree with planted problems prints what py-final printed, byte for byte', (t) => {
  using dir = tempDir();
  const golden =
    /** @type {{ files: Record<string, string>, outputs: Record<string, { stdout: string, status: number }> }} */ (
      JSON.parse(readFileSync(join(FIXTURES_DIR, 'infra', 'scripts.json'), 'utf8'))
    );

  writeFiles(dir.path, golden.files);

  const out = t.mock.method(process.stdout, 'write', () => true);
  const status = checkChecklists(join(dir.path, 'references', 'checklists'));

  out.mock.restore();
  assert.equal(
    out.mock.calls.map((call) => call.arguments[0]).join(''),
    golden.outputs['check_checklists.py'].stdout,
  );
  assert.equal(status, golden.outputs['check_checklists.py'].status);
});
