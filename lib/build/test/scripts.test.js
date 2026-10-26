import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildGolden } from '../../../test/fixtures/build/golden.js';
import { tempDir, writeFiles } from '../../../test/helpers/index.js';
import { builderScript, fmtScript, JS_INSTALL, jsLaneScript, jsSteps, lanesFor } from '../scripts.js';

test('the builder script is byte-identical to the frozen script', () => {
  for (const [options, expected] of buildGolden().builder_script) {
    assert.equal(builderScript(options), expected);
  }
});

test('the JS-lane script is byte-identical to the frozen one; only the install step changed', () => {
  for (const [options, script, steps] of buildGolden().js_lane_script) {
    // Deliberate change: the install is the lane's only networked step, so it runs no lifecycle
    // script and reads no .yarnrc or .npmrc; the frozen vectors predate that.
    assert.match(steps[0], /^yarn install --frozen-lockfile --registry=/);
    assert.deepEqual(jsSteps(options), [JS_INSTALL, ...steps.slice(1)]);
    assert.equal(jsLaneScript(steps), script);
  }
});

test("the root lifecycle scripts the install skips run next, in yarn's order", () => {
  const steps = jsSteps({
    runJs: false,
    regenCompat: true,
    regenAst: false,
    lifecycle: ['prepare', 'preinstall'],
  });

  assert.equal(
    JS_INSTALL,
    'yarn install --frozen-lockfile --ignore-scripts --no-default-rc --registry=https://registry.npmjs.com/',
  );
  assert.deepEqual(steps, [
    JS_INSTALL,
    'yarn run preinstall',
    'yarn run prepare',
    'node scripts/build-prefixes.js',
  ]);
  // Names outside the lifecycle list never become steps.
  assert.deepEqual(jsSteps({ runJs: false, regenCompat: false, regenAst: false, lifecycle: ['evil; rm'] }), [
    JS_INSTALL,
  ]);
});

test('lanesFor adds wasm-check and c-bindings when the change needs them', () => {
  for (const [prep, patch, expected] of buildGolden().lanes_for) {
    using dir = tempDir();

    if (patch) {
      writeFiles(dir.path, { 'diff.patch': patch });
    }

    assert.deepEqual(lanesFor(prep, dir.path), expected, JSON.stringify(prep));
  }
});

test('fmtScript keeps cargo fmt exit status behind the output cap', () => {
  assert.equal(
    fmtScript('/src', { prefix: 'CARGO_HOME=/cargo ' }),
    'cd /src && CARGO_HOME=/cargo cargo fmt --all -- --check 2>&1 | head -c 200000; exit ${PIPESTATUS[0]}',
  );
  assert.equal(
    fmtScript("'/a b'"),
    "cd '/a b' && cargo fmt --all -- --check 2>&1 | head -c 200000; exit ${PIPESTATUS[0]}",
  );
});
