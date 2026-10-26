import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { REPO_ROOT, captureOutput, tempDir } from '../../../test/helpers/index.js';
import { curatedDirs, loadProbes, parseProbe, splitList, validateCli } from '../probes.js';
import { writeProbe } from './support.js';

/**
 * @param {string} dir
 * @param {string} text
 * @param {string} [name]
 * @returns {string}
 */
function write(dir, text, name = 'p.css') {
  const path = join(dir, name);

  writeFileSync(path, text);

  return path;
}

describe('parseProbe', () => {
  test('a valid probe', () => {
    using dir = tempDir();
    const probe = parseProbe(
      write(
        dir.path,
        '/*! lcr-probe\nid: color/x\narea: color\ntitle: t\nmode: lower\ntargets: chrome 80\nexpect: equivalent, output-contains:"a, b"\nknown: open-bug\nref: https://x\n*/\n.t{color:lab(50% 20 30)}\n',
      ),
    );

    assert.deepEqual(probe.errors, []);
    assert.deepEqual(probe.expect, ['equivalent', 'output-contains:"a, b"']);

    const request = probe.request();

    assert.deepEqual(request.targets, { chrome: 80 << 16 });
    assert.equal(request.minify, true);
    assert.equal(request.compact, false);
  });

  test('an invalid probe lists every problem', () => {
    using dir = tempDir();
    const probe = parseProbe(
      write(
        dir.path,
        '/*! lcr-probe\nid: Bad Id\narea: nope\ntitle: t\nmode: lower-minify\nexpect: maybe\nknown: soon\nref: x\n*/\n',
      ),
    );
    const joined = probe.errors.join(' | ');

    for (const needle of [
      'unknown area',
      'lower-minify needs targets',
      'bad expect',
      'bad known',
      'bad id',
      'empty CSS body',
      'bad ref',
    ]) {
      assert.ok(joined.includes(needle), needle);
    }
  });

  test('unknown parser flags pass through; error-recovery is a request option', () => {
    using dir = tempDir();
    const probe = parseProbe(
      write(
        dir.path,
        '/*! lcr-probe\nid: at-rules-other/f\narea: at-rules-other\ntitle: t\nmode: minify\nflags: custom-functions, error-recovery\nexpect: no-panic\nknown: none\nref: https://x.org/\n*/\n@function --f(){}\n',
      ),
    );

    assert.deepEqual(probe.errors, []);

    const request = probe.request();

    assert.deepEqual(request.flags, ['custom-functions']);
    assert.equal(request.error_recovery, true);
  });

  test('css-modules and unused-symbols flags', () => {
    using dir = tempDir();
    const probe = parseProbe(
      write(
        dir.path,
        '/*! lcr-probe\nid: css-modules/p\narea: css-modules\ntitle: t\nmode: print\nflags: css-modules, unused-symbols:b|a\nexpect: no-panic\nknown: none\nref: https://x.org/\n*/\n.a{}\n',
      ),
    );

    assert.deepEqual(probe.errors, []);
    assert.deepEqual(probe.request(), {
      kind: 'sheet',
      css: '.a{}\n',
      minify: false,
      compact: false,
      targets: null,
      css_modules: {},
      filename: 'test.css',
      unused_symbols: ['a', 'b'],
    });
  });

  test('a file without a header is not a probe', () => {
    using dir = tempDir();
    const path = write(dir.path, '.a{}\n');

    assert.throws(() => parseProbe(path), { message: `${path}: missing /*! lcr-probe ... */ header` });
  });
});

describe('probe headers', () => {
  test('repro and timeout', () => {
    using dir = tempDir();
    const probe = parseProbe(writeProbe(dir.path, 'x', { extra: 'repro: #1291\ntimeout: 60\n' }));

    assert.deepEqual(probe.errors, []);
    assert.equal(probe.repro, 1291);
    assert.equal(String(probe.timeout), '60.0');

    const bad = parseProbe(writeProbe(dir.path, 'y', { extra: 'repro: 1291\ntimeout: 9999\n' }));
    const joined = bad.errors.join(' | ');

    assert.ok(joined.includes('bad repro'));
    assert.ok(joined.includes('bad timeout'));
  });

  test('timeouts parse like Python float()', () => {
    using dir = tempDir();
    const cases = [
      ['1_0.5', '10.5'],
      ['.5', '0.5'],
      ['5.', '5.0'],
      ['2e2', '200.0'],
    ];

    for (const [text, repr] of cases) {
      const probe = parseProbe(writeProbe(dir.path, 'x', { extra: `timeout: ${text}\n` }));

      assert.deepEqual(probe.errors, [], text);
      assert.equal(String(probe.timeout), repr, text);
    }

    for (const text of ['nan', 'inf', '0', '-1', '0x10', '1__0', 'abc', '601']) {
      const probe = parseProbe(writeProbe(dir.path, 'x', { extra: `timeout: ${text}\n` }));

      assert.ok(
        probe.errors.some((error) => error.startsWith(`bad timeout ${text} `)),
        text,
      );
    }
  });

  test('placeholder refs are rejected', () => {
    using dir = tempDir();
    const path = join(dir.path, 'z.css');
    const header = (/** @type {string} */ ref) =>
      `/*! lcr-probe\nid: color/z\narea: color\ntitle: t\nmode: minify\nexpect: no-panic\nknown: none\nref: ${ref}\n*/\n.t{}\n`;

    for (const ref of [
      'https://github.com/parcel-bundler/lightningcss/pull/<open',
      'https://github.com/x/y/pull/N',
      'see-spec',
      `https://x/${String.fromCodePoint(0x2026)}`,
      'https://x/TODO',
    ]) {
      writeFileSync(path, header(ref));
      assert.ok(
        parseProbe(path).errors.some((error) => error.includes('bad ref')),
        ref,
      );
    }

    writeFileSync(
      path,
      header(
        'https://github.com/parcel-bundler/lightningcss/issues/1291 https://drafts.csswg.org/css-color-4/#missing',
      ),
    );
    assert.deepEqual(parseProbe(path).errors, []);
    writeFileSync(path, header('https://x.org/TODOS'));
    assert.deepEqual(parseProbe(path).errors, [], 'TODO inside a word is no placeholder');
  });

  test('lower without targets is a pretty-printed minify', () => {
    using dir = tempDir();
    const path = write(
      dir.path,
      '/*! lcr-probe\nid: color/w\narea: color\ntitle: t\nmode: lower\ntargets: none\nexpect: no-panic\nknown: none\nref: https://x.org/\n*/\n.t{}\n',
      'w.css',
    );
    const probe = parseProbe(path);

    assert.deepEqual(probe.errors, []);
    assert.deepEqual(probe.request(), {
      kind: 'sheet',
      css: '.t{}\n',
      minify: true,
      compact: false,
      targets: null,
    });
  });

  test('a file name that differs from the slug and an unknown key are warnings', () => {
    using dir = tempDir();
    const path = write(
      dir.path,
      '/*! lcr-probe\nid: color/w\narea: color\ntitle: t\nmode: minify\nexpect: no-panic\nknown: none\nref: https://x.org/\nexpected: x\n*/\n.t{}\n',
      'other-name.css',
    );
    const probe = parseProbe(path);

    assert.deepEqual(probe.errors, []);
    assert.equal(probe.warnings.length, 2);
  });

  test('duplicate keys and bad header lines are errors', () => {
    using dir = tempDir();
    const probe = parseProbe(
      writeProbe(dir.path, 'x', { extra: 'title: again\nNot A Key\nconstructor: x\n' }),
    );

    assert.deepEqual(probe.errors, ['duplicate key title', 'bad header line: Not A Key']);
    assert.deepEqual(probe.warnings, ['unknown header key constructor']);
  });

  test('CRLF files read like Python text mode', () => {
    using dir = tempDir();
    const path = writeProbe(dir.path, 'x');

    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('\n', '\r\n'));

    const probe = parseProbe(path);

    assert.deepEqual(probe.errors, []);
    assert.equal(probe.css, '.t { color: red }\n');
  });
});

describe('splitList', () => {
  test('quoted strings may contain commas', () => {
    assert.deepEqual(splitList('a, output-contains:"x, y" ,, b'), ['a', 'output-contains:"x, y"', 'b']);
    assert.deepEqual(splitList(''), []);
  });
});

describe('loadProbes', () => {
  test('pathlib order, duplicate ids and problems', () => {
    using dir = tempDir();
    const root = join(dir.path, 'probes');

    writeProbe(join(root, 'a-b'), 'one');
    writeProbe(join(root, 'a'), 'one');
    writeProbe(join(root, 'a'), 'two', { extra: 'mode: nope\n' });
    write(root, 'no header\n', 'zz.css');

    const { probes, problems } = loadProbes([[`${root}/`, 'cli']]);

    // `a/` sorts before `a-b/` component-wise, so a/one.css wins the id.
    assert.deepEqual(
      probes.map((probe) => probe.path),
      [join(root, 'a', 'one.css')],
    );
    assert.deepEqual(problems, [
      `${join(root, 'a', 'two.css')}: duplicate key mode; unknown mode nope`,
      `${join(root, 'a-b', 'one.css')}: duplicate id color/one (also ${join(root, 'a', 'one.css')})`,
      `${join(root, 'zz.css')}: missing /*! lcr-probe ... */ header`,
    ]);
  });

  test('symlinked directories are not followed, missing directories are skipped', () => {
    using dir = tempDir();
    const root = join(dir.path, 'probes');

    writeProbe(join(dir.path, 'elsewhere'), 'x');
    mkdirSync(root);
    symlinkSync(join(dir.path, 'elsewhere'), join(root, 'linked'));

    assert.deepEqual(
      loadProbes([
        [root, 'cli'],
        [join(dir.path, 'missing'), 'pr'],
      ]),
      { probes: [], problems: [] },
    );
  });
});

describe('the curated corpus', () => {
  const { probes: curated, problems } = loadProbes(curatedDirs());
  const byId = (/** @type {string} */ id) => {
    const probe = curated.find((candidate) => candidate.id === id);

    assert.ok(probe, id);

    return probe;
  };

  test('every curated probe validates', () => {
    assert.deepEqual(problems, []);
    assert.ok(curated.length > 0);
  });

  test('refs are URLs without placeholders', () => {
    for (const probe of curated) {
      for (const ref of probe.refs) {
        assert.match(ref, /^https?:\/\/[^<>]+$/, probe.id);
      }
    }
  });

  test('headers do not prejudge open PRs or quote maintainers', () => {
    const bad =
      /open PR|open fix PR|\(approved|maintainer (wants|questioned|considers|said)|\bDevon\b|would make it match/i;

    for (const probe of curated) {
      assert.doesNotMatch(readFileSync(probe.path, 'utf8').split('*/')[0], bad, probe.id);
    }
  });

  test('no curated probe claims a repro', () => {
    for (const probe of curated) {
      assert.doesNotMatch(readFileSync(probe.path, 'utf8').split('*/')[0], /^repro:/m, probe.path);
    }
  });

  test('logical-after-nested-rule uses Chrome targets', () => {
    const probe = byId('nesting/logical-after-nested-rule');

    assert.equal(probe.targetsText, 'chrome 80');
    assert.ok(!probe.refs.join(' ').includes('pull/'));
  });

  test('the margin-block var() probe targets below the logical longhands', () => {
    const probe = byId('logical/shorthand-with-var-in-calc-lowered');

    assert.equal(probe.targetsText, 'chrome 68');
    assert.ok(probe.expect.includes('output-not-contains:"margin-block:"'));
  });

  test('the color-mix token-list probe is an unfiled bug', () => {
    assert.equal(byId('color/color-mix-none-in-token-list').known, 'open-bug');
  });

  test('the function-rule probe note is current', () => {
    assert.ok(!byId('at-rules-other/function-rule-untouched-without-flag').note?.includes('cannot express'));
  });

  test('curated probes live in the skill directory', () => {
    assert.ok(curated.every((probe) => probe.path.startsWith(join(REPO_ROOT, 'corpus', 'probes'))));
  });
});

describe('validateCli', () => {
  test('prints problems, warnings and a per-area count', async () => {
    using dir = tempDir();

    writeProbe(dir.path, 'ok');
    writeProbe(dir.path, 'warned', { extra: 'colour: x\n' });
    writeProbe(dir.path, 'broken', { extra: 'known: maybe\n' });

    const { stdout, result } = await captureOutput(() => validateCli([dir.path]));

    assert.equal(result, 1);
    assert.equal(
      stdout,
      [
        `${join(dir.path, 'broken.css')}: duplicate key known; bad known maybe`,
        `warning: ${join(dir.path, 'warned.css')}: unknown header key colour`,
        '2 valid probes, 1 problems, 1 warnings',
        '  color: 2',
        '',
      ].join('\n'),
    );
  });

  test('exit status 0 without problems', async () => {
    using dir = tempDir();

    writeProbe(dir.path, 'ok');

    const { stdout, result } = await captureOutput(() => validateCli([dir.path]));

    assert.equal(result, 0);
    assert.equal(stdout, '1 valid probes, 0 problems\n  color: 1\n');
  });
});
