# tests checklist (TESTS)

Covers the quality of the PR's own tests: `src/lib.rs` `mod tests` (117 `#[test]` fns; helpers at src/lib.rs:76-470), `src/test_helpers.rs`, `tests/*.rs`, `bundler::tests`, `node/test/*.mjs`, and whether they demonstrate the change. The harness records every helper call as a tuple (helper, targets, call-site line), so T1-T5 are the first evidence.
Top failure modes: (1) tests that do not exercise the change or cover one variant only (T2; #929 shipped without tests; #1213 and #930 added only `parcel_selectors` parse tests, which CI does not run); (2) only pretty or only no-target output while the bug lives in compact or lowered output (#936, #850); (3) expectations changed or removed without justification, or expected output that browsers reject (T3, T4).

- [TESTS-01] (MAJOR) Every behavior the PR changes has a test in the area's `test_<area>` fn in src/lib.rs (or a new cross-cutting fn) with an exact expected output, every new case fails on base, and a linked issue's repro is among them.
  verify: T1; T2 (new cases that pass on base show as partial, NOTE); A2 (Devon asks for tests on #182, #260 and #1102, e.g. "Can you please add a test?" on #1102).
- [TESTS-02] (MAJOR) The helper matches the claim: lowering uses `prefix_test` with Browsers (compact: `minify_test_with_options_and_browsers`); nesting uses `nesting_test` (Chrome 95) and `nesting_test_no_targets`; CSS modules use `css_modules_test` with exports and references; rejection uses `error_test` with the exact `ParserError`; invalid values use `property_range_test(.., None)`; `@custom-media` uses `custom_media_test` (its printer has no targets, src/lib.rs:387-414); style attributes use `attr_test` (no logical lowering, no `@supports` rules). `test()` runs `minify()` with the pretty printer; it is not parse-and-print.
  verify: the tuple `helper` and `targets` fields; helper definitions at src/lib.rs:76-470; T5.
- [TESTS-03] (MAJOR) Lowering tests cover both sides of the threshold: a target that needs the lowering, one that does not (output unchanged), and for prefixes both directions (added for old targets, removed for new ones).
  verify: tuples with targets in the PR; mutations `retarget-none`, `retarget-modern`, `retarget-legacy`; GEN-14 (15a48a8 tests text-size-adjust with ios_saf 16, edge 15 and firefox 20 against chrome 110).
- [TESTS-04] (MAJOR) Order-sensitive changes test both orders and the Unparsed, `!important` and CSS-wide variants: typed then `var()` and the reverse, prefixed then unprefixed and the reverse, shorthand then longhand and the reverse.
  verify: the PR's test inputs; mutations `reverse-decls`, `var-before`, `var-after`, `important` and `prefixed-sibling` show what the tests miss; GEN-07 (22a8b6f, 28bf5af, 60622a1; #695, #872).
- [TESTS-05] (MAJOR) Lowered and prefixed output is also tested in compact mode, because the minifying printer applies standard-syntax shortcuts to legacy forms.
  verify: a compact case (`minify_test_with_options_and_browsers` or a `lower-minify` probe) for each new `prefix_test` (#936 had only pretty expectations, and its compact `-webkit-linear-gradient(#00f,red)` is flipped).
- [TESTS-06] (MAJOR) List-valued and multi-part inputs use a distinct value per entry, so misalignment is visible: transition, animation, background and mask lists, selector lists, number chains in `calc()`.
  verify: the PR's test inputs; probe transition-animation/transition-property-prefixed-alignment (#850's equal durations hid the re-indexing bug; #832 calc chains; #1156 multiple selectors).
- [TESTS-07] (MAJOR) Valid inputs for new or changed syntax also run with `errorRecovery: true` and give the same output with an empty warnings list (`error_recovery_test` returns the warnings, src/lib.rs:432-456).
  verify: PR tests; a probe with `flags: error-recovery` on the same inputs; warnings via `lcr show`, since deltas do not compare them (#1125 caused #1370, a false `EndOfInput` warning that fails `next build`; #1137).
- [TESTS-08] (MAJOR) A new or changed ident printer has a `css_modules_test` that shows whether the name is hashed, at the definition and at the references.
  verify: PR tests; MOD-01 (#1133 had no CSS-modules test; #1274).
- [TESTS-09] (BLOCKER) Changed expectations are justified and browser-equivalent: each modified or removed expected string is explained in the PR (spec, issue, WPT), its input and new output compute the same in current engines, and no expectation is deleted while behavior changed.
  verify: T3 (BLOCKER), T4 (MAJOR), O2; `lcr show <run> t-…` for every modified tuple (#1306 and #1385 change existing expectations; #1107 shows existing expectations can codify wrong output).
- [TESTS-10] (MAJOR) A PR that makes a construct known (pseudo-class, pseudo-element, at-rule) tests, at the lightningcss level, the forms the spec still allows after or inside it, not only `parcel_selectors` parse tests.
  verify: B7 for selectors-crate tests; `minify_test` tuples in test_selectors; WPT `css-pseudo/parsing/*` (#1213 → #1303, #930 → #1244, #957 → #1292, #1026).
- [TESTS-11] (MAJOR) Output that can be fed back (prefixes, token lists, merged rules) has an idempotence case: the expected output, minified again with the same options, does not change.
  verify: R2 on the PR's tuples; probes with `expect: idempotent` (#403, #872, #969, #1141, #1335; Tailwind and styled-jsx run LightningCSS twice).
- [TESTS-12] (MAJOR) A fix covers its whole class: the same input shape is tested for each sibling type, handler, math function or fallback branch (RGB, P3, LAB) where the faulty pattern exists.
  verify: `rg` the fixed pattern around the diff; GEN-23 (#722 → #801 left text-shadow and `get_fallback` panicking; #901 → #1192; #1131 → #1312).
- [TESTS-13] (MAJOR) JS-facing changes have `node/test/*.mjs` tests that pass natively and in both wasm modes, run from the repo root (fixtures are cwd-relative under tests/testdata).
  verify: B5; CI test-wasm via B6 (`TEST_WASM=node|browser`, added in 0db4fd3); GEN-26.
- [TESTS-14] (MINOR) WPT-derived cases cite their source with a `// The following tests were converted from WPT: <path>` comment and take expected values from the WPT file at the pinned revision (config/wpt.json, b89af32bc8f42d678f444eb0703bca015ddcf240), not from LightningCSS output.
  verify: the PR's src/lib.rs hunk; O7 for the property.
- [TESTS-15] (MINOR) Feature-gated tests and examples build and run where CI runs them: `#[cfg(feature = …)]` tests (sourcemap, substitute_variables, serde), `required-features = ["cli"]` integration tests and the examples that need `visitor` or `serde` are built by `cargo test --all-features`; doc tests run without `-D warnings`.
  verify: B1, B2.
- [TESTS-16] (MINOR) Tests are deterministic across runs and platforms: no dependence on HashMap order, per-process hash seeds, platform float formatting (Windows color rounding, #541 and PR #1248) or absolute paths in CSS-module hashes (PR #1247).
  verify: run B1 twice; read the hashes and numbers in new expectations.
