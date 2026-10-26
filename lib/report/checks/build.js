/**
 * Build checks B1-B11: the head test suite, CI compile flags, rustfmt, Cargo.lock, the JS lane,
 * the PR's CI checks, the extra cargo lanes and generated-file drift.
 *
 * Stage: report. Reads build.json, build/<side>/tests.json and prepare.json (changed files, CI
 * checks). A failure that base shares is pre-existing: a PARTIAL note, never the PR's defect.
 */
import { join } from 'node:path';

import { readJson } from '../../core/files.js';
import { pyEquals, pyGet } from '../../core/py-value.js';
import { compareCodePoints, pyLstrip, pySlice, pyStr, pyTruthy } from '../../core/py.js';

/**
 * @import { BuildLane, BuildSide, CiCheck, JsLane, TestsFile } from '../../types.js'
 * @import { EvalContext } from '../context.js'
 */

/** Compile errors listed when head does not compile. */
const MAX_COMPILE_ERRORS = 8;

/** Errors listed for a lane that fails on base too / on head only. */
const MAX_PRE_EXISTING_LANE_ERRORS = 4;
const MAX_LANE_ERRORS = 6;

/** Characters of a lane's output tail shown when it reported no error lines. */
const PRE_EXISTING_TAIL_CHARS = 300;
const LANE_TAIL_CHARS = 400;

/** The extra cargo lanes: check id, lane name, why it may not have run. */
const LANES = /** @type {const} */ ([
  ['B7', 'selectors', 'lane not run'],
  ['B8', 'no-default-features', 'lane not run'],
  ['B9', 'wasm-check', 'no napi/node/cfg(target_arch) changes'],
  ['B10', 'c-bindings', 'c/ not touched'],
]);

/**
 * Evaluate B1-B11 (B1-B4 and B7-B11 only when the build stage ran; B5 and B6 always).
 *
 * @param {EvalContext} ctx
 * @returns {void}
 */
export function buildChecks(ctx) {
  const { build, checks } = ctx;
  const head = /** @type {Partial<BuildSide>} */ (pyGet(build, 'head', {}));
  const base = /** @type {Partial<BuildSide>} */ (pyGet(build, 'base', {}));
  const js = /** @type {JsLane} */ (pyGet(build, 'js', {}));
  const ran = pyTruthy(build);

  if (ran) {
    suiteChecks(ctx, head);
  } else {
    for (const id of ['B1', 'B2', 'B3', 'B4']) {
      checks.add(id, 'SKIP', 'build stage did not run');
    }
  }

  jsLaneCheck(ctx, js);

  if (ran) {
    for (const [id, lane, why] of LANES) {
      laneCheck(ctx, id, laneOf(head, lane), laneOf(base, lane), why);
    }

    driftCheck(ctx, js);
  }

  ciCheck(ctx, /** @type {CiCheck[] | null | undefined} */ (ctx.prep.ci_checks));
}

/**
 * B1 (test suite), B2 (-D warnings), B3 (rustfmt on changed files), B4 (Cargo.lock).
 *
 * @param {EvalContext} ctx
 * @param {Partial<BuildSide>} head
 * @returns {void}
 */
function suiteChecks(ctx, head) {
  const { checks } = ctx;

  testSuiteCheck(ctx, head);

  const warnings = pyTruthy(head.warnings_as_errors);

  checks.add(
    'B2',
    warnings ? 'FAIL' : 'PASS',
    warnings ? 'warnings become errors under RUSTFLAGS=-D warnings' : '',
  );

  const changed = Object.keys(pyGet(ctx.prep, 'files', {}));
  const fmtBad = pyGet(head, 'fmt_files', [])
    .filter((file) => {
      const relative = pyLstrip(file, '/').replace('/src/', '');

      return changed.includes(relative) || changed.some((path) => file.endsWith(path));
    })
    .sort(compareCodePoints);

  checks.add(
    'B3',
    fmtBad.length > 0 ? 'FAIL' : 'PASS',
    fmtBad.length > 0 ? `rustfmt would change: ${fmtBad.join(', ')}` : '',
  );

  const lockfile = pyTruthy(head.lockfile_outdated);

  checks.add('B4', lockfile ? 'FAIL' : 'PASS', lockfile ? 'Cargo.lock needs updating' : '');
}

/**
 * B1: tests failing on head only are the PR's; tests failing on both sides are a note.
 *
 * @param {EvalContext} ctx
 * @param {Partial<BuildSide>} head
 * @returns {void}
 */
function testSuiteCheck(ctx, head) {
  const headTests = testsFile(ctx.runDir, 'head');
  const baseTests = testsFile(ctx.runDir, 'base');
  const failed = failedTests(headTests).sort(compareCodePoints);
  const baseFailed = new Set(failedTests(baseTests));
  const newFailed = failed.filter((test) => !baseFailed.has(test));
  const compileErrors = head.compile_errors;

  if (compileErrors && pyTruthy(compileErrors) && !pyTruthy(headTests.tests)) {
    ctx.checks.add('B1', 'FAIL', 'head does not compile', compileErrors.slice(0, MAX_COMPILE_ERRORS));
  } else if (newFailed.length > 0) {
    ctx.checks.add('B1', 'FAIL', `${newFailed.length} test(s) fail on head but not on base`, newFailed);
  } else if (failed.length > 0) {
    ctx.checks.add(
      'B1',
      'PARTIAL',
      `${failed.length} test(s) fail on both base and head (pre-existing)`,
      failed,
      {
        severity: 'NOTE',
      },
    );
  } else {
    const summary = pyGet(head, 'summary', /** @type {Partial<BuildSide['summary']>} */ ({}));

    ctx.checks.add(
      'B1',
      'PASS',
      `${pyStr(pyGet(summary, 'passed', 0))} passed, ${pyStr(pyGet(summary, 'ignored', 0))} ignored`,
    );
  }
}

/**
 * @param {string} runDir
 * @param {'base' | 'head'} side
 * @returns {Partial<TestsFile>}
 */
function testsFile(runDir, side) {
  const tests = readJson(join(runDir, 'build', side, 'tests.json'), {});

  return pyTruthy(tests) ? /** @type {Partial<TestsFile>} */ (tests) : {};
}

/**
 * @param {Partial<TestsFile>} tests
 * @returns {string[]}
 */
function failedTests(tests) {
  return Object.entries(pyGet(tests, 'tests', {}))
    .filter(([, status]) => status === 'failed')
    .map(([name]) => name);
}

/**
 * B5: the JS lane runs when bindings change.
 *
 * @param {EvalContext} ctx
 * @param {JsLane} js
 * @returns {void}
 */
function jsLaneCheck(ctx, js) {
  const failedAt = `failed at \`${pyStr(js.failed_step ?? null)}\``;

  if (pyTruthy(js.ran) && pyTruthy(js.js_tests)) {
    const failed = pyTruthy(js.failed_step);

    ctx.checks.add('B5', failed ? 'FAIL' : 'PASS', failed ? failedAt : 'yarn build, test, tsc');
  } else if (pyTruthy(js.ran) && pyTruthy(js.failed_step)) {
    ctx.checks.add('B5', 'FAIL', failedAt);
  } else {
    ctx.checks.add('B5', 'SKIP', 'bindings not touched');
  }
}

/**
 * @param {Partial<BuildSide>} side
 * @param {string} lane
 * @returns {BuildLane | null}
 */
function laneOf(side, lane) {
  return pyGet(side, 'lanes', /** @type {Record<string, BuildLane>} */ ({}))[lane] ?? null;
}

/**
 * B7-B10: an extra cargo lane passes on head, fails on base too (note), or fails on head only.
 *
 * @param {EvalContext} ctx
 * @param {string} id
 * @param {BuildLane | null} headLane
 * @param {BuildLane | null} baseLane
 * @param {string} why Shown when the lane did not run.
 * @returns {void}
 */
function laneCheck(ctx, id, headLane, baseLane, why) {
  if (!headLane || !pyTruthy(headLane)) {
    ctx.checks.add(id, 'SKIP', why);
  } else if (pyEquals(headLane.exit, 0)) {
    ctx.checks.add(id, 'PASS', `${pyStr(headLane.seconds ?? null)}s`);
  } else if (baseLane && pyTruthy(baseLane) && !pyEquals(baseLane.exit, 0)) {
    const errors = laneErrors(headLane, MAX_PRE_EXISTING_LANE_ERRORS, PRE_EXISTING_TAIL_CHARS);

    ctx.checks.add(id, 'PARTIAL', 'fails on base too (pre-existing)', errors, { severity: 'NOTE' });
  } else {
    ctx.checks.add(
      id,
      'FAIL',
      'fails on head, passes on base',
      laneErrors(headLane, MAX_LANE_ERRORS, LANE_TAIL_CHARS),
    );
  }
}

/**
 * The lane's first error lines, or the end of its output when it reported none.
 *
 * @param {BuildLane} lane
 * @param {number} maxErrors
 * @param {number} tailChars
 * @returns {string[]}
 */
function laneErrors(lane, maxErrors, tailChars) {
  const errors = lane.errors.slice(0, maxErrors);

  return errors.length > 0 ? errors : [pySlice(lane.tail, -tailChars)];
}

/**
 * B11: regenerated files (compat data, AST types) must match what the PR commits. A file that
 * drifts the same way on base is not the PR's doing (a diff of diffs).
 *
 * @param {EvalContext} ctx
 * @param {JsLane} js
 * @returns {void}
 */
function driftCheck(ctx, js) {
  const { checks } = ctx;

  if (!pyTruthy(js.regen_compat) && !pyTruthy(js.regen_ast)) {
    checks.add('B11', 'SKIP', 'no generated inputs touched');

    return;
  }

  const drift = js.drift && pyTruthy(js.drift) ? js.drift : {};
  const baseDrift = js.base_drift ?? null;
  const isNew = (/** @type {string} */ file) =>
    baseDrift === null || !Object.hasOwn(baseDrift, file) || !pyEquals(baseDrift[file], drift[file]);
  const files = Object.keys(drift);
  const newDrift = files.filter(isNew).sort(compareCodePoints);
  const preDrift = files.filter((file) => !newDrift.includes(file)).sort(compareCodePoints);
  const preNote =
    preDrift.length > 0 ? `; drifts identically on base (pre-existing): ${preDrift.join(', ')}` : '';

  if (newDrift.length > 0) {
    checks.add('B11', 'FAIL', `regenerate and commit: ${newDrift.join(', ')}${preNote}`);
  } else if (preDrift.length > 0) {
    checks.add(
      'B11',
      'PARTIAL',
      `generated files drift identically on base (pre-existing): ${preDrift.join(', ')}`,
      [],
      {
        severity: 'NOTE',
      },
    );
  } else if (pyTruthy(js.failed_step)) {
    checks.add('B11', 'SKIP', `regeneration failed at \`${pyStr(js.failed_step ?? null)}\``);
  } else {
    checks.add('B11', 'PASS', 'regenerated output matches the PR');
  }
}

/**
 * B6: the PR's own CI checks (as `gh pr checks` reported them at prepare time).
 *
 * @param {EvalContext} ctx
 * @param {CiCheck[] | null | undefined} ci
 * @returns {void}
 */
function ciCheck(ctx, ci) {
  if (!ci || !pyTruthy(ci)) {
    ctx.checks.add('B6', 'SKIP', 'no checks reported (first-time contributor workflows may need approval)');

    return;
  }

  const failing = ci.filter((check) => check.bucket === 'fail').map((check) => pyStr(check.name));
  const pending = ci.filter((check) => check.bucket === 'pending').map((check) => pyStr(check.name));

  if (failing.length > 0) {
    ctx.checks.add('B6', 'FAIL', `failing: ${failing.join(', ')}`);
  } else if (pending.length > 0) {
    ctx.checks.add('B6', 'PARTIAL', `pending: ${pending.join(', ')}`, [], { severity: 'NOTE' });
  } else {
    ctx.checks.add('B6', 'PASS', ci.map((check) => pyStr(check.name)).join(', '));
  }
}
