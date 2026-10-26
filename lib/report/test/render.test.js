/**
 * report.md rendering details the byte-parity fixtures (report.test.js) do not isolate: the engine
 * list, the header facts and the checklist table.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ARROW, MIDDLE_DOT } from '../glyphs.js';
import { engineList, render } from '../render.js';
import { evaluateRun, ITEM, reportRun } from './support.js';

describe('render', () => {
  test('engineList puts latest first, then the profiles in order, browsers only', () => {
    const profiles = {
      'legacy-2023': { webkit: '17', chromium: '120' },
      latest: { node: '24', firefox: '141', chromium: '140' },
      'legacy-2021': { chromium: '97' },
    };

    assert.equal(
      engineList(profiles, '; '),
      'latest: chromium 140, firefox 141; legacy-2023: chromium 120, webkit 17; legacy-2021: chromium 97',
    );
    assert.equal(engineList({}, '; '), '');
  });

  test('the header names the range for a local run and lists the stages that did not run', () => {
    using run = reportRun();

    run.prep.range = 'master~3..master';
    run.oracle = {};

    const md = render(evaluateRun(run), run.dir);
    const dot = ` ${MIDDLE_DOT} `;

    assert.ok(md.startsWith('# LightningCSS review: master~3..master\n'), md.slice(0, 80));
    assert.ok(md.includes(`- Run \`run\`${dot}skill `));
    assert.ok(md.includes(`${dot}local range\n`));
    assert.ok(md.includes('- Stages not run: oracle\n'));
    assert.ok(!md.includes('- Engines:'));
  });

  test('the checklist table shows a valid lowered severity and area-level answers', () => {
    using run = reportRun();
    const display = { ...ITEM, item: 'DISPLAY-01', list: 'display' };

    run.analysis.checklist = [
      { item: 'COLOR-01', answer: 'PASS', evidence: 'e', effective_severity: 'MINOR', severity_reason: 'r' },
      { area: 'display', answer: 'N/A', evidence: 'no display code' },
    ];

    let md = render(evaluateRun(run, [ITEM, display]), run.dir);

    assert.ok(md.includes(`| COLOR-01 | MAJOR ${ARROW} MINOR | Colors stay equivalent | PASS | e |`), md);
    assert.ok(md.includes('| DISPLAY-01 | MAJOR | Colors stay equivalent | N/A (area) | no display code |'));

    // Raising, an unknown severity or a missing reason shows the item's own severity.
    for (const effective of [
      { effective_severity: 'BLOCKER', severity_reason: 'r' },
      { effective_severity: 'HUGE', severity_reason: 'r' },
      { effective_severity: 'MINOR' },
    ]) {
      run.analysis.checklist = [{ item: 'COLOR-01', answer: 'PASS', evidence: 'e', ...effective }];
      md = render(evaluateRun(run, [ITEM]), run.dir);

      assert.ok(
        md.includes('| COLOR-01 | MAJOR | Colors stay equivalent | PASS | e |'),
        JSON.stringify(effective),
      );
    }
  });
});
