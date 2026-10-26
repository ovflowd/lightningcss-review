import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildGolden } from '../../../test/fixtures/build/golden.js';
import { tempDir, writeFiles } from '../../../test/helpers/index.js';
import { builderScript, fmtScript, jsLaneScript, jsSteps, lanesFor } from '../scripts.js';

test('the builder script is byte-identical to the frozen script', () => {
  for (const [options, expected] of buildGolden().builder_script) {
    assert.equal(builderScript(options), expected);
  }
});

test('the JS-lane steps and script are byte-identical to the frozen ones', () => {
  for (const [options, script, steps] of buildGolden().js_lane_script) {
    assert.deepEqual(jsSteps(options), steps);
    assert.equal(jsLaneScript(jsSteps(options)), script);
  }
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
