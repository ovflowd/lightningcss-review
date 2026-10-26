/**
 * Inject the review adapter and a test-tuple recorder into a throwaway copy of a Lightning CSS
 * tree (build/<side>/tree, never the clone and never src/<side>).
 *
 * Stage: build. The recorder makes every leaf test helper of src/lib.rs (the ones that call
 * `StyleSheet::parse` and friends: `minify_test_with_options_and_browsers`, `prefix_test`,
 * `attr_test`, …) append one JSON line per call to `$LCR_DUMP`: the calling test, the call-site
 * line (through `#[track_caller]`) and the helper's arguments. Arguments the recorder cannot
 * serialize directly are recorded as their Debug text (see rust-debug.js).
 *
 * Invariant: every edit stays on an existing line, so line numbers in the recorded tuples match
 * the pristine src/lib.rs that prepare.json's changed ranges refer to.
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { LcrError } from '../core/errors.js';
import { readPyText } from '../core/files.js';
import { SKILL_DIR } from '../core/paths.js';
import { pyRe } from '../core/py-re.js';
import { pySorted, pyStrip } from '../core/py.js';
import { findHelpers } from './rust-scanner.js';

/** @import { Helper } from './rust-scanner.js' */

/** Calls that mark a helper as a leaf: it does the real parse/minify/print work. */
const LEAF_MARKERS = [
  'StyleSheet::parse',
  'StyleAttribute::parse',
  'Property::parse_string',
  '::parse_string(',
];

/**
 * The recorder module, inserted on the `mod tests {` line. One line of Rust: a mutex keeps lines
 * from concurrent tests whole; `#[track_caller]` makes `Location::caller()` the test's call site.
 */
const DUMP_MODULE =
  '#[allow(dead_code, unused)] pub(crate) mod lcr_dump { use std::io::Write; ' +
  'static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(()); ' +
  '#[track_caller] pub(crate) fn dump(helper: &str, fields: serde_json::Value) { ' +
  'let path = match std::env::var("LCR_DUMP") { Ok(p) => p, Err(_) => return }; ' +
  'let loc = std::panic::Location::caller(); ' +
  'let test = std::thread::current().name().unwrap_or("").to_string(); ' +
  'let record = serde_json::json!({"test": test, "helper": helper, "file": loc.file(), "line": loc.line(), "fields": fields}); ' +
  "let mut text = record.to_string(); text.push('\\n'); " +
  'let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner()); ' +
  'if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) { let _ = f.write_all(text.as_bytes()); } } } ';

const STR_TYPE = pyRe(String.raw`^(?:&('\w+)?str)$`);
const OPTION_STR_TYPE = pyRe(String.raw`^(?:Option<&('\w+)?str>)$`);
const SCALAR_TYPES = new Set(['bool', 'u32', 'usize', 'i32']);
const TARGET_TYPES = new Set([
  'Browsers',
  'Option<Browsers>',
  'Targets',
  'crate::targets::Targets',
  'Option<Targets>',
]);

/**
 * The `"name": <expr>` entry of the recorder's `json!` object for one parameter, or null when the
 * type is not recorded. Strings, ints and bools are recorded as values; option structs as an
 * object of their behavior-relevant fields; everything else as Debug text.
 *
 * @param {string} name
 * @param {string} type Whitespace already collapsed.
 * @returns {string | null}
 */
export function fieldExpr(name, type) {
  const compact = type.replaceAll(' ', '');

  if (STR_TYPE.test(compact) || OPTION_STR_TYPE.test(compact) || SCALAR_TYPES.has(compact)) {
    return `"${name}": ${name}`;
  }

  if (TARGET_TYPES.has(compact)) {
    return `"${name}": format!("{:?}", ${name})`;
  }

  if (compact.startsWith('ParserOptions')) {
    return (
      `"${name}": serde_json::json!({"flags": format!("{:?}", ${name}.flags), ` +
      `"css_modules": format!("{:?}", ${name}.css_modules), "error_recovery": ${name}.error_recovery, ` +
      `"filename": ${name}.filename.clone()})`
    );
  }

  if (compact.startsWith('PrinterOptions')) {
    return `"${name}": serde_json::json!({"minify": ${name}.minify, "targets": format!("{:?}", ${name}.targets)})`;
  }

  const debugOnly =
    compact.endsWith('css_modules::Config') ||
    compact === 'Config' ||
    compact.startsWith('ParserError') ||
    compact === 'MinifyErrorKind' ||
    compact.startsWith('&[');

  return debugOnly ? `"${name}": format!("{:?}", ${name})` : null;
}

/**
 * @typedef {object} InjectedHelper build.json `<side>.injection.helpers[]`.
 * @property {string} name
 * @property {string[]} fields Recorded parameters.
 * @property {string[]} skipped Parameters whose type the recorder does not serialize.
 */

/**
 * @typedef {object} LeafHelper
 * @property {Helper} helper
 * @property {string[]} fields `"name": expr` entries.
 * @property {string[]} skipped
 */

/**
 * Patch src/lib.rs of `srcRoot` so every leaf test helper records its calls.
 *
 * @param {string} srcRoot
 * @returns {{ helpers: InjectedHelper[] }}
 */
export function injectDump(srcRoot) {
  const lib = join(srcRoot, 'src', 'lib.rs');
  const original = readPyText(lib, { replace: true });
  const { modOpen, helpers } = findHelpers(original);
  const leafs = leafHelpers(original, helpers);

  if (leafs.length === 0) {
    throw new LcrError('no leaf test helpers found in src/lib.rs (helper layout changed?)');
  }

  const patched = applyEdits(original, recorderEdits(leafs, modOpen));

  if (countNewlines(patched) !== countNewlines(original)) {
    throw new LcrError('internal: dump injection changed the line count');
  }

  writeFileSync(lib, patched);

  return {
    helpers: leafs.map(({ helper, fields, skipped }) => ({
      name: helper.name,
      fields: fields.map((field) => pyStrip(field.split(':')[0], '"')),
      skipped,
    })),
  };
}

/**
 * Non-test helpers whose body calls one of the leaf markers, with their recordable fields.
 *
 * @param {string} text
 * @param {Helper[]} helpers
 * @returns {LeafHelper[]}
 */
function leafHelpers(text, helpers) {
  return helpers
    .filter((helper) => !helper.isTest)
    .filter((helper) => {
      const body = text.slice(helper.bodyOpen, helper.bodyClose);

      return LEAF_MARKERS.some((marker) => body.includes(marker));
    })
    .map((helper) => ({
      helper,
      fields: helper.params.flatMap(([name, type]) => fieldExpr(name, type) ?? []),
      skipped: helper.params.filter(([name, type]) => fieldExpr(name, type) === null).map(([name]) => name),
    }));
}

/**
 * `[offset, text]` insertions: the dump call at the start of each leaf body, `#[track_caller]`
 * where missing, and the recorder module after `mod tests {`. None adds a newline.
 *
 * @param {LeafHelper[]} leafs
 * @param {number} modOpen
 * @returns {[offset: number, insert: string][]}
 */
function recorderEdits(leafs, modOpen) {
  /** @type {[number, string][]} */
  const edits = [];

  for (const { helper, fields } of leafs) {
    const call = ` { crate::tests::lcr_dump::dump("${helper.name}", serde_json::json!({${fields.join(', ')}})); }`;

    edits.push([helper.bodyOpen + 1, call]);

    if (!helper.hasTrackCaller) {
      edits.push([helper.fnStart, '#[track_caller] ']);
    }
  }

  edits.push([modOpen + 1, ` ${DUMP_MODULE}`]);

  return edits;
}

/**
 * Apply insertions from the end, so earlier offsets stay valid.
 *
 * @param {string} text
 * @param {[offset: number, insert: string][]} edits
 * @returns {string}
 */
function applyEdits(text, edits) {
  let patched = text;

  for (const [offset, insert] of pySorted(edits, ([offset]) => offset, { reverse: true })) {
    patched = patched.slice(0, offset) + insert + patched.slice(offset);
  }

  return patched;
}

/**
 * @param {string} text
 * @returns {number}
 */
function countNewlines(text) {
  return text.split('\n').length - 1;
}

const NO_AUTOEXAMPLES = pyRe(String.raw`^autoexamples\s*=\s*false`, 'm');

/**
 * Copy adapter/lcr_adapter.rs into the tree as a Cargo example (`cargo build --example
 * lcr_adapter`).
 *
 * @param {string} srcRoot
 * @returns {void}
 */
export function injectAdapter(srcRoot) {
  const examples = join(srcRoot, 'examples');

  mkdirSync(examples, { recursive: true });
  copyFileSync(join(SKILL_DIR, 'adapter', 'lcr_adapter.rs'), join(examples, 'lcr_adapter.rs'));

  if (NO_AUTOEXAMPLES.test(readPyText(join(srcRoot, 'Cargo.toml'), { replace: true }))) {
    throw new LcrError('Cargo.toml disables autoexamples; add an [[example]] entry for lcr_adapter');
  }
}
