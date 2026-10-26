import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildGolden } from '../../../test/fixtures/build/golden.js';
import { FIXTURES_DIR, tempDir, withEnv } from '../../../test/helpers/index.js';
import { jsonFileText } from '../../core/pyjson.js';
import {
  ciChecks,
  closingIssueNumbers,
  fetchLinkedIssues,
  linkedIssueNumbers,
  overlappingPrs,
  prMeta,
} from '../github.js';

test('closing and linked issues', () => {
  const pr = {
    number: 9,
    title: 'Fix x',
    body: 'Fixes #12, related to #13.\nCloses: https://github.com/parcel-bundler/lightningcss/issues/14',
    closingIssuesReferences: [{ number: 15 }],
  };

  assert.deepEqual(
    [...closingIssueNumbers(pr)].sort((a, b) => a - b),
    [12, 14, 15],
  );
  assert.deepEqual(linkedIssueNumbers(pr), [12, 13, 14, 15]);
});

test("issue references read as Python's re reads them (Unicode words and digits, dotless i)", () => {
  for (const [pr, linked, closing] of buildGolden().issues) {
    assert.deepEqual(linkedIssueNumbers(pr), linked, JSON.stringify(pr));
    assert.deepEqual(
      [...closingIssueNumbers(pr)].sort((a, b) => a - b),
      closing,
      JSON.stringify(pr),
    );
  }
});

test('prMeta keeps the fields the report shows', () => {
  const meta = prMeta({
    number: 7,
    title: 't',
    author: null,
    url: 'u',
    state: 'OPEN',
    createdAt: '2026-01-02T03:04:05Z',
    updatedAt: '2026-02-03T04:05:06Z',
    labels: [{ name: 'bug' }],
    body: null,
    commits: [{}, {}],
  });

  assert.deepEqual(meta, {
    number: 7,
    title: 't',
    author: null,
    url: 'u',
    state: 'OPEN',
    draft: null,
    created: '2026-01-02',
    updated: '2026-02-03',
    labels: ['bug'],
    body: '',
    commits: 2,
    head_ref: null,
    mergeable: null,
  });
});

// The expected values below are frozen prepare.json fields for the fake `gh`: a change to one is a
// change to the prepare.json format.
const FAKE_GH = join(FIXTURES_DIR, 'build', 'fake-gh');
const ISSUE_12 = {
  body: 'b',
  comments: [],
  labels: [],
  number: 12,
  state: 'OPEN',
  title: 'Twelve',
  url: 'u12',
};

test('linked issues are fetched into issues/; one that is a PR is skipped', async () => {
  using dir = tempDir();
  using _env = withEnv({ PATH: `${FAKE_GH}:${process.env.PATH}` });
  const pr = {
    number: 9,
    title: 'Fix things',
    body: 'Fixes #12, see #13 and #14.',
    closingIssuesReferences: [{ number: 14 }],
  };

  assert.deepEqual(await fetchLinkedIssues(pr, dir.path), [
    { number: 12, title: 'Twelve', state: 'OPEN', closing: true },
    { number: 14, title: 'Fourteen', state: 'CLOSED', closing: true },
  ]);
  assert.deepEqual(readdirSync(dir.path).sort(), ['12.json', '14.json']);
  assert.equal(readFileSync(join(dir.path, '12.json'), 'utf8'), jsonFileText(ISSUE_12));
});

test('overlapping PRs: shared files without lockfiles and src/lib.rs, most shared first', async () => {
  using _env = withEnv({ PATH: `${FAKE_GH}:${process.env.PATH}` });
  const mine = ['src/a.rs', 'src/b.rs', 'src/lib.rs', 'Cargo.lock'];

  // The fake `gh pr list` rejects closingIssuesReferences, so the fallback field list is used.
  assert.deepEqual(await overlappingPrs(9, mine), [
    {
      number: 10,
      title: 'Two shared',
      author: 'y',
      shared_files: ['src/a.rs', 'src/b.rs'],
      linked_issues: [],
    },
    { number: 5, title: 'One shared too', author: null, shared_files: ['src/a.rs'], linked_issues: [] },
    { number: 20, title: 'One shared', author: 'x', shared_files: ['src/b.rs'], linked_issues: [] },
  ]);
  assert.deepEqual(
    (await overlappingPrs(10, mine)).map((overlap) => overlap.number),
    [5, 9, 20],
  );
});

test('CI checks are read despite a failing exit status, sorted by name; no checks is empty', async () => {
  using _env = withEnv({ PATH: `${FAKE_GH}:${process.env.PATH}` });

  assert.deepEqual(await ciChecks(9), [
    { name: 'lint', state: 'SUCCESS', bucket: 'pass', link: 'l2' },
    { name: 'test (ubuntu)', state: 'FAILURE', bucket: 'fail', link: 'l1' },
  ]);
  assert.deepEqual(await ciChecks(10), []);
});
