import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { asPythonJson, buildGolden } from '../../../test/fixtures/build/golden.js';
import { tempDir, writeFiles } from '../../../test/helpers/index.js';
import { fieldExpr, injectAdapter, injectDump } from '../inject.js';
import { findHelpers, splitParams } from '../rust-scanner.js';

const LIB_RS = `pub fn api() {}

#[cfg(test)]
mod tests {
  use super::*;

  #[track_caller]
  fn minify_test(source: &str, expected: &str) {
    minify_test_with_options(source, expected, ParserOptions::default())
  }

  #[track_caller]
  fn minify_test_with_options<'i>(source: &'i str, expected: &'i str, options: ParserOptions<'i>) {
    let mut stylesheet = StyleSheet::parse(&source, options).unwrap();
    let _ = "a { b }";
    let _ = r#"{ unbalanced "#;
    assert_eq!(stylesheet.to_css(PrinterOptions::default()).unwrap().code, expected);
  }

  fn error_test(source: &str, error: ParserError) {
    let res = StyleSheet::parse(&source, ParserOptions::default());
    assert!(res.is_err());
  }

  #[test]
  fn test_color() {
    minify_test(".a { color: red }", ".a{color:red}");
  }
}
`;

/**
 * A tree whose src/lib.rs is `text`.
 *
 * @param {string} root
 * @param {string} text
 * @returns {string}
 */
function treeWith(root, text) {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'lib.rs'), text);

  return join(root, 'src', 'lib.rs');
}

test('injection keeps line numbers and targets leaf helpers only', () => {
  using dir = tempDir();
  const lib = treeWith(dir.path, LIB_RS);
  const info = injectDump(dir.path);
  const out = readFileSync(lib, 'utf8');

  assert.equal(out.split('\n').length, LIB_RS.split('\n').length);
  // minify_test is not a leaf: it calls another helper, not the parser.
  assert.deepEqual(
    info.helpers.map((helper) => helper.name),
    ['minify_test_with_options', 'error_test'],
  );
  assert.ok(out.includes('"options": serde_json::json!({"flags"'));
  assert.ok(out.includes('#[track_caller] fn error_test'));
  assert.ok(out.includes('mod lcr_dump'));
  // The test itself is untouched.
  assert.ok(out.includes('    minify_test(".a { color: red }", ".a{color:red}");'));
});

test('the patched file and the helper list match the golden output byte for byte', () => {
  using dir = tempDir();
  const golden = buildGolden().inject_dump;
  const lib = treeWith(dir.path, buildGolden().find_helpers.text);

  assert.equal(asPythonJson(injectDump(dir.path)), asPythonJson(golden.info));
  assert.equal(readFileSync(lib, 'utf8'), golden.text);
});

test('CRLF sources are read with universal newlines', () => {
  using dir = tempDir();
  const lib = treeWith(dir.path, LIB_RS.replaceAll('\n', '\r\n'));

  injectDump(dir.path);

  assert.ok(!readFileSync(lib, 'utf8').includes('\r'));
});

test('injection failures carry their fixed messages', () => {
  for (const [name, [text, message]] of Object.entries(buildGolden().inject_errors)) {
    using dir = tempDir();

    treeWith(dir.path, text);

    if (message === null) {
      assert.doesNotThrow(() => injectDump(dir.path), name);
    } else {
      assert.throws(() => injectDump(dir.path), { message }, name);
    }
  }
});

test('findHelpers skips strings, raw strings, chars, lifetimes and nested comments', () => {
  const golden = buildGolden().find_helpers;
  const found = findHelpers(golden.text);

  assert.equal(found.modOpen, golden.mod_open);
  assert.equal(found.modClose, golden.mod_close);
  assert.equal(
    asPythonJson(
      found.helpers.map((helper) => ({
        name: helper.name,
        fn_start: helper.fnStart,
        params: helper.params,
        body_open: helper.bodyOpen,
        body_close: helper.bodyClose,
        attrs_start: helper.attrsStart,
        has_track_caller: helper.hasTrackCaller,
        is_test: helper.isTest,
      })),
    ),
    asPythonJson(golden.helpers),
  );
});

test('fieldExpr records what the recorder can serialize', () => {
  for (const [type, expected] of buildGolden().field_expr) {
    assert.equal(fieldExpr('x', type), expected, type);
  }
});

test('splitParams splits on top-level commas only', () => {
  for (const [text, expected] of buildGolden().split_params) {
    assert.deepEqual(splitParams(text), expected, text);
  }
});

test('injectAdapter copies the example and refuses a manifest without autoexamples', () => {
  using dir = tempDir();

  writeFiles(dir.path, { 'Cargo.toml': '[package]\nname = "lightningcss"\n' });
  injectAdapter(dir.path);
  injectAdapter(dir.path);
  assert.match(readFileSync(join(dir.path, 'examples', 'lcr_adapter.rs'), 'utf8'), /fn main/);

  writeFiles(dir.path, { 'Cargo.toml': '[package]\nautoexamples = false\n' });
  assert.throws(() => injectAdapter(dir.path), /disables autoexamples/);
});
