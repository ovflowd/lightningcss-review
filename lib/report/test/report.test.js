/**
 * The report stage end to end: report.md, report.json and the chat summary match the frozen
 * expected output under test/fixtures/report/ byte for byte (reviewers diff them between runs),
 * the output is deterministic, and the summary's own rules.
 */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { captureOutput, FIXTURES_DIR, tempDir, withEnv } from '../../../test/helpers/index.js';
import { probeCase, verdict } from '../../../test/helpers/synthetic-run.js';
import { LcrError } from '../../core/errors.js';
import { loads } from '../../core/pyjson.js';
import { deltaCoverage, report, summary } from '../report.js';
import { omitStage, reportRun } from './support.js';

/** @import { ChecklistItem } from '../checklists.js' */

const REPORT_FIXTURES = join(FIXTURES_DIR, 'report');

/**
 * Run `lcr report` and `lcr summary` on a copy of a fixture; outputs with the temp paths replaced
 * by the placeholders the generator wrote.
 *
 * @param {string} name
 * @returns {Promise<{ stdout: string, md: string, json: string }>}
 */
async function runFixture(name) {
  using dir = tempDir();
  const fixture = join(REPORT_FIXTURES, name);
  const runDir = join(dir.path, 'run');
  const cache = join(dir.path, 'cache');

  cpSync(join(fixture, 'run'), runDir, { recursive: true });

  // Git keeps no empty directories, so a fixture without cached files has no cache/ at all.
  if (existsSync(join(fixture, 'cache'))) {
    cpSync(join(fixture, 'cache'), cache, { recursive: true });
  } else {
    mkdirSync(cache);
  }

  using _env = withEnv({ LCR_CACHE: cache });
  const checklistPath = join(fixture, 'checklist.json');
  const checklist = existsSync(checklistPath)
    ? /** @type {ChecklistItem[]} */ (loads(readFileSync(checklistPath, 'utf8')))
    : null;
  const options = checklist ? { checklists: () => structuredClone(checklist) } : {};
  const { stdout } = await captureOutput(async () => {
    await report(runDir, options);
    await summary(runDir);
  });
  const placeholders = (/** @type {string} */ text) =>
    text.replaceAll(runDir, '<RUN>').replaceAll(cache, '<CACHE>');

  return {
    stdout: placeholders(stdout),
    md: placeholders(readFileSync(join(runDir, 'report.md'), 'utf8')),
    json: placeholders(readFileSync(join(runDir, 'report.json'), 'utf8')),
  };
}

describe('byte parity with the frozen report fixtures', () => {
  for (const name of readdirSync(REPORT_FIXTURES).sort()) {
    test(name, async () => {
      const actual = await runFixture(name);
      const expected = (/** @type {string} */ file) =>
        readFileSync(join(REPORT_FIXTURES, name, 'expected', file), 'utf8');

      assert.equal(actual.md, expected('report.md'));
      assert.equal(actual.json, expected('report.json'));
      assert.equal(actual.stdout, expected('stdout.txt'));
    });
  }
});

describe('report and summary', () => {
  test('report and summary are deterministic', async () => {
    using run = reportRun();
    const id = run.addCase(probeCase('p-color/f', { flags: ['custom-functions'] }), { delta: true });
    const neutral = run.addCase(probeCase('p-color/n'));

    run.corpus.flag_only = { 'custom-functions': [id] };
    run.oracle.verdicts[id] = verdict(id, { base: 'unknown', head: 'different', transition: 'introduced' });
    run.oracle.verdicts[neutral] = verdict(neutral, {
      base: 'different',
      head: 'different',
      transition: 'still-different',
      summary: { neutral: true },
    });
    run.analysis.deltas = [{ id: neutral, classification: 'NEEDS_MAINTAINER_DECISION', reason: 'keep it?' }];
    run.write();

    const texts = [];

    for (let round = 0; round < 2; round++) {
      const { result } = await captureOutput(async () => {
        await report(run.dir, { checklists: () => [] });

        return [
          readFileSync(join(run.dir, 'report.md'), 'utf8'),
          readFileSync(join(run.dir, 'report.json'), 'utf8'),
          await summary(run.dir),
        ];
      });

      texts.push(result);
    }

    assert.deepEqual(texts[0], texts[1]);

    const [md, rep, chat] = /** @type {string[]} */ (texts[0]);

    assert.ok(md.includes('**VERDICT: UNSAFE (flag custom-functions only)**'));
    assert.ok(md.includes('### 4.2 Changed and still different from input (0)'));
    assert.ok(chat.includes('default path byte-identical (1 requests)'));
    assert.ok(chat.includes('Decision needed:\n- keep it? (1 case(s))'));
    assert.equal(
      /** @type {{ verdict_scope: string }} */ (loads(rep)).verdict_scope,
      'flag custom-functions only',
    );
  });

  test('report prints the verdict line and the report path', async () => {
    using run = reportRun();

    run.write();

    const { stdout, result } = await captureOutput(() => report(run.dir, { checklists: () => [] }));

    assert.equal(
      stdout,
      `VERDICT: SAFE (0 blocker, 0 major, 0 minor, 0 note)\n${join(run.dir, 'report.md')}\n`,
    );
    assert.equal(/** @type {{ verdict: string }} */ (result).verdict, 'SAFE');
  });

  test('printed paths keep `..` and drop `.`, as pathlib spells them', async () => {
    using dir = tempDir();
    const fixture = join(REPORT_FIXTURES, 'full-render');

    mkdirSync(join(dir.path, 'sub'));
    cpSync(join(fixture, 'run'), join(dir.path, 'run'), { recursive: true });
    cpSync(join(fixture, 'cache'), join(dir.path, 'cache'), { recursive: true });

    const runDir = `${dir.path}/sub/../run/.`;
    const cache = `${dir.path}/sub/../cache/`;

    using _env = withEnv({ LCR_CACHE: cache });
    const { stdout } = await captureOutput(async () => {
      await report(runDir);
      await summary(runDir);
    });
    const md = readFileSync(join(dir.path, 'run', 'report.md'), 'utf8');

    assert.ok(stdout.includes(`\n${dir.path}/sub/../run/report.md\n`), stdout);
    assert.ok(stdout.includes(`Report: ${dir.path}/sub/../run/report.md\n`), stdout);
    assert.ok(md.includes(`- _2 more in ${dir.path}/sub/../cache/baseline.json_`), md);
  });

  test('summary needs report.json', async () => {
    using run = reportRun();

    run.write();
    await assert.rejects(
      summary(run.dir),
      (error) => error instanceof LcrError && error.message === 'run `lcr report` first',
    );
  });

  test('a run without prepare.json cannot be reported', async () => {
    using run = reportRun();

    omitStage(run, 'prep');
    run.write();
    await assert.rejects(
      report(run.dir),
      (error) => error instanceof LcrError && error.message === 'no prepare.json; run `lcr prepare`',
    );
  });

  test('deltaCoverage counts deltas, browser-verified and errored ones', () => {
    const oracle = {
      verdicts: {
        a: verdict('a', { transition: 'fixed' }),
        b: verdict('b', { transition: 'errored' }),
        c: verdict('c', { transition: 'input-rejected' }),
      },
    };
    const corpus = { deltas: { probe: 2, mutation: 2 } };

    assert.deepEqual(deltaCoverage(corpus, /** @type {never} */ (oracle), ['a', 'b', 'c', 'd']), [4, 1, 1]);
    assert.deepEqual(deltaCoverage(corpus, /** @type {never} */ (oracle), null), [4, 1, 1]);
    assert.deepEqual(deltaCoverage({}, {}, null), [0, 0, 0]);
  });
});
