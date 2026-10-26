# visitor-api checklist (VISIT)

`src/visitor.rs`, `derive(Visit)` (`derive/src/visit.rs`), the JS bridge `napi/src/transformer.rs` (serde round trip), `napi/src/at_rule_parser.rs` (customAtRules), `node/composeVisitors.js`. No harness lane runs visitors: evidence is node tests (B5) and Rust visitor tests. Applies to `napi/*`/`node/*` visitor changes too.

- [VISIT-01] (BLOCKER) An identity JS visitor is a no-op: every hook returning its input gives byte-identical output, including `null` Option fields (`var()` without fallback, anonymous `@layer`), numbers outside i16/u16 range, ±infinity, -0, bundler `Ignored` rules, and selectors with pseudo-elements (deserialized selectors get no recomputed flags).
  verify: a node test with an identity visitor on each touched hook over tests/testdata and realworld files.
- [VISIT-02] (MAJOR) Visitor errors become JS errors in every entry point: no `unwrap()` on `visit()` or on deserializing a returned node (`transformStyleAttribute` has one), since release builds abort.
  verify: a node test whose visitor throws in each touched entry point; risk flag `added-unwrap` on napi/.
- [VISIT-03] (MAJOR) `#[serde(skip)]` state on a visitable type survives a JS round trip or is documented as lost: `StyleSheet` options (custom media, CSS modules) and content hashes reset when a StyleSheet hook returns the sheet.
  verify: grep the diff for `serde(skip)`; node test `StyleSheetExit: s => s` with `drafts.customMedia` or `cssModules`.
- [VISIT-04] (MAJOR) New AST types and fields are visitable as intended: `cfg_attr(feature = "visitor", derive(Visit))`, `skip_visit` only where a field must stay invisible (a URL stored as a plain string is invisible to Url visitors), `visit(visit_x, TYPES)` for a new kind, `VisitTypes` bits extended without renumbering.
  verify: a Rust test with a visitor counting the new node.
- [VISIT-05] (MAJOR) JS hooks stay complete: a new visitable kind or rule gets napi dispatch, a `composeVisitors` entry, `Visitor` types in node/index.d.ts and wasm parity; `composeVisitors` forwards StyleSheet, StyleSheetExit and `Rule.custom.*`.
  verify: composeVisitors.test.mjs with two visitors on the new hook.
- [VISIT-06] (MAJOR) The phase contract holds or is declared breaking: visitors run after parsing and before `minify()`, so they see unmerged rules, unlowered nesting and `@custom-media`; `var()`/`env()` values stay `Property::Unparsed` unless the visitor returns `{property, raw}`.
  verify: read the call order in napi/src/lib.rs for transform, bundle and style attributes.
- [VISIT-07] (MAJOR) Rules returned by visitors and custom at-rule bodies mean what parsed input would: interleaved declarations and nested rules keep their order, and a relative nested selector spliced into a style rule gets its implicit `&`.
  verify: customAtRules "mixin"/"style block" tests with a nested rule without `&`, lowered (chrome 95) and preserved.
- [VISIT-08] (MAJOR) Token-list edits print correctly: whitespace tokens kept, replaced `var()`/`env()`/function tokens neither glue to neighbors nor lose required spaces, `var(--x, )` idempotent.
  verify: visitor Token/Function/Variable tests; probe custom-properties/var-empty-fallback-idempotent-2.
- [VISIT-09] (MAJOR) Serializers that omit default components compare values, not structure: `== Px(0)`-style checks print a visitor-produced `0rem` component a shorthand then rejects.
  verify: a node test with a px→rem Length visitor on the touched property; grep for structural zero comparisons.
- [VISIT-10] (MAJOR) Custom at-rules keep their contract: prelude syntax follows the `@property` syntax grammar, body kinds are declaration-list, rule-list or style-block, `is_nested` is passed, built-in names win, statement rules (no body) print their `;`.
  verify: customAtRules.mjs; compact output plus strict re-parse with a statement rule followed by a rule.
- [VISIT-11] (MAJOR) Rust `Visitor` changes are source-compatible or declared: required methods, signatures, the `Error` type, `visit_types()`, default recursion (`visit_rule` calls `visit_children`).
  verify: read the src/visitor.rs diff; examples and tests/test_custom_parser.rs build.
- [VISIT-12] (MINOR) A function visitor survives reuse of the options object: `wrap()` replaces `options.visitor` on the caller's object; wasm behaves like node.
  verify: node test calling `transform` twice with one options object and a function visitor.
