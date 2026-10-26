/**
 * The spec checklists and the answers to them: the parser, `resolveAnswers`, `untouchedCovers`
 * (py-final tests/test_report.py ChecklistTest/HelpersTest), and the invariants of the checklist
 * files themselves (py-final tests/test_knowledge.py ChecklistTest).
 */
import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { REPO_ROOT } from '../../../test/helpers/index.js';
import { compareCodePoints } from '../../core/py.js';
import { MUTATIONS } from '../../corpus/mutations.js';
import {
  loadChecklists,
  parseChecklist,
  resolveAnswerMap,
  resolveAnswers,
  untouchedCovers,
} from '../checklists.js';

/**
 * @param {string} relative
 * @returns {string}
 */
function read(relative) {
  return readFileSync(join(REPO_ROOT, relative), 'utf8');
}

describe('checklist loading', () => {
  test('loadChecklists reads same-root-as and covers', () => {
    const items = new Map(loadChecklists(['tests', 'build-release']).map((item) => [item.item, item]));

    assert.equal(items.get('TESTS-03')?.same_root_as, 'GEN-06');
    assert.ok(items.get('BUILD-05')?.covers.includes('.github/workflows/*'));
  });

  test('general comes first, areas in sorted order, unknown areas are ignored', () => {
    const lists = [...new Set(loadChecklists(['tests', 'color', 'no-such-area']).map((item) => item.list))];

    assert.deepEqual(lists, ['general', 'color', 'tests']);
  });

  test('parseChecklist keeps the first definition and reads the attributes', () => {
    const items = parseChecklist(
      [
        '# Title',
        '- [AB-1] (MINOR) First item',
        '  verify: a probe',
        '  covers: `src/a.rs`, src/b/*.rs',
        '- [AB-2] (LOW) not an item',
        '  same-root-as: AB-1 ',
        '- not an item either',
      ].join('\n'),
      'ab',
    );

    assert.deepEqual(items, [
      {
        item: 'AB-1',
        severity: 'MINOR',
        text: 'First item',
        list: 'ab',
        verify: 'a probe',
        covers: ['src/a.rs', 'src/b/*.rs'],
        same_root_as: 'AB-1',
      },
    ]);
  });
});

describe('answers', () => {
  const items = [
    {
      item: 'COLOR-01',
      severity: /** @type {const} */ ('MAJOR'),
      text: 't',
      list: 'color',
      verify: '',
      covers: [],
    },
    {
      item: 'GEN-01',
      severity: /** @type {const} */ ('MAJOR'),
      text: 't',
      list: 'general',
      verify: '',
      covers: [],
    },
  ];

  test('an answer with an answer beats an earlier one; an empty one only fills a gap', () => {
    const answers = resolveAnswerMap(
      {
        checklist: [
          { item: 'COLOR-01', answer: 'PASS', evidence: 'first' },
          { item: 'COLOR-01', answer: '', evidence: 'ignored' },
          { item: 'GEN-01', answer: '', evidence: 'gap' },
          { item: 'GEN-01', answer: 'FAIL', evidence: 'wins' },
        ],
      },
      items,
    );

    assert.equal(answers.get('COLOR-01')?.evidence, 'first');
    assert.equal(answers.get('GEN-01')?.evidence, 'wins');
  });

  test('an area-level N/A covers the area, never general', () => {
    const answers = resolveAnswers(
      {
        checklist: [
          { area: 'color', answer: 'N/A', evidence: 'no color code' },
          { area: 'general', answer: 'N/A', evidence: 'nope' },
        ],
      },
      items,
    );

    assert.deepEqual(answers['COLOR-01'], {
      area: 'color',
      answer: 'N/A',
      evidence: 'no color code',
      item: 'COLOR-01',
      area_level: true,
    });
    assert.equal(answers['GEN-01'], undefined);
  });

  test('untouchedCovers needs covers that match no changed file', () => {
    assert.ok(untouchedCovers({ covers: ['src/rules/*.rs'] }, ['src/values/color.rs']));
    assert.ok(!untouchedCovers({ covers: ['src/rules/*.rs'] }, ['src/rules/supports.rs']));
    assert.ok(!untouchedCovers({ covers: [] }, ['src/values/color.rs']));
  });
});

const ITEM_LINE = /^- \[([A-Z0-9]+-\d+)\] /;

/**
 * Every item of every checklist file with its indented lines (py-final's test parser).
 *
 * @returns {Map<string, string[]>}
 */
function checklistItems() {
  /** @type {Map<string, string[]>} */
  const items = new Map();
  const files = globSync('references/checklists/*.md', { cwd: REPO_ROOT }).sort(compareCodePoints);

  for (const file of files) {
    /** @type {string[] | null} */
    let current = null;

    for (const line of read(file).split('\n')) {
      const match = ITEM_LINE.exec(line);

      if (match) {
        current = [];
        items.set(match[1], current);
      } else if (current && line.startsWith('  ')) {
        current.push(line.trim());
      }
    }
  }

  return items;
}

/**
 * @param {string} relative
 * @param {string} item
 * @returns {string}
 */
function itemLine(relative, item) {
  return /** @type {string} */ (
    read(relative)
      .split('\n')
      .find((line) => line.startsWith(`- [${item}]`))
  );
}

describe('checklist files', () => {
  test('same-root-as names an existing other item', () => {
    const items = checklistItems();
    const links = new Map();

    for (const [item, lines] of items) {
      for (const line of lines) {
        if (line.startsWith('same-root-as:')) {
          links.set(item, line.split(':').slice(1).join(':').trim());
        }
      }
    }

    assert.ok(links.has('COMPAT-10'));

    for (const [item, target] of links) {
      assert.ok(items.has(target), item);
      assert.notEqual(item, target);
    }
  });

  test('same-root-as follows verify', () => {
    for (const [item, lines] of checklistItems()) {
      if (lines.some((line) => line.startsWith('same-root-as:'))) {
        assert.ok(lines[0].startsWith('verify:'), item);
      }
    }
  });

  test('supports boolean items are base-relative', () => {
    assert.ok(
      itemLine('references/checklists/supports-container.md', 'COND-02').includes('FAIL_PRE_EXISTING'),
    );
    assert.ok(itemLine('references/checklists/prefixing-compat.md', 'COMPAT-10').includes('COND-02'));
  });

  test('the general checklist allows pre-existing answers', () => {
    assert.ok(read('references/checklists/general.md').split('- [GEN-01]')[0].includes('FAIL_PRE_EXISTING'));
  });

  test('the animation shorthand timeline split', () => {
    const text = read('references/checklists/transition-animation.md');

    assert.ok(
      !itemLine('references/checklists/transition-animation.md', 'ANIM-05').includes('parsed inside'),
    );
    assert.ok(text.includes('- [ANIM-14] (NOTE)'));
  });

  test('the compact test item accepts either evidence', () => {
    const tests04 = itemLine('references/checklists/tests.md', 'TESTS-04');

    assert.ok(tests04.includes('**or**'));
    assert.ok(tests04.includes('effective_severity: MINOR'));
  });

  test('missing branch coverage is minor and reasons live outside code', () => {
    const tests03 = itemLine('references/checklists/tests.md', 'TESTS-03');
    const tests11 = itemLine('references/checklists/tests.md', 'TESTS-11');

    assert.ok(tests03.startsWith('- [TESTS-03] (MINOR)'));
    assert.ok(tests03.includes('oracle-verified'));
    assert.ok(tests11.startsWith('- [TESTS-11] (NOTE)'));
    assert.ok(tests11.includes('PR body or a comment'));
  });

  test('the display handler and rule dedupe are separate items', () => {
    const file = 'references/checklists/display-layout.md';

    assert.ok(!itemLine(file, 'DISPLAY-02').includes('is_duplicate'));
    assert.ok(itemLine(file, 'DISPLAY-03').includes('StyleRule::is_duplicate'));
    // value-prefixed-sibling only puts prefixes first; the later-prefixed order needs reverse-decls.
    assert.ok(checklistItems().get('DISPLAY-02')?.[0].includes('reverse-decls'));
  });

  test('the value-prefix mutation is named where value prefixes matter', () => {
    const items = checklistItems();

    assert.ok(MUTATIONS.includes('value-prefixed-sibling'));

    for (const item of ['GEN-06', 'DISPLAY-02', 'TESTS-03']) {
      assert.ok(items.get(item)?.[0].includes('value-prefixed-sibling'), item);
    }
  });
});
