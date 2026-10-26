# tests checklist (TESTS)

Quality of the PR's own tests (`src/lib.rs` `mod tests`, `tests/*.rs`, `bundler::tests`, `node/test/*.mjs`). T1-T5 already decide presence, fail-on-base, changed and removed expectations; R2 decides idempotence. These items judge whether the tests demonstrate the claim.

- [TESTS-01] (MAJOR) The helper matches the claim: lowering via `prefix_test` with Browsers; nesting via `nesting_test` and `nesting_test_no_targets`; CSS modules via `css_modules_test` with exports; rejection via `error_test` with the exact `ParserError`; invalid values via `property_range_test(.., None)`; style attributes via `attr_test` (no rules, so no `@supports` fallbacks); `custom_media_test` minifies at chrome 95 but prints without targets. `test()` runs `minify()`, it is not parse-and-print.
  verify: the tuple `helper` and `targets` fields.
- [TESTS-02] (MAJOR) Lowering tests cover both sides of the threshold: a target that needs it, one that does not (output unchanged), and for prefixes both directions.
  verify: tuples with targets; `retarget-none`, `retarget-modern`, `retarget-legacy`.
- [TESTS-03] (MAJOR) Order-sensitive changes test both orders and the Unparsed, `!important` and CSS-wide variants: typed then `var()` and reverse, prefixed then unprefixed and reverse, shorthand then longhand and reverse.
  verify: mutation deltas show what the tests miss (`reverse-decls`, `var-before`, `var-after`, `important`, `prefixed-sibling`).
- [TESTS-04] (MAJOR) Lowered and prefixed output is also tested in compact mode, where the minifying printer applies standard-syntax shortcuts.
  verify: a `minify_test_with_options_and_browsers` case or a `lower-minify` probe per new `prefix_test`.
- [TESTS-05] (MAJOR) List-valued and multi-part inputs use a distinct value per entry, so misalignment shows: transition, animation, background and mask lists, selector lists, `calc()` chains.
  verify: the PR's inputs; probe transition-animation/transition-property-prefixed-alignment.
- [TESTS-06] (MAJOR) Valid inputs for new syntax also run with `errorRecovery: true` and give the same output with no warnings.
  verify: `error_recovery_test` cases or a probe with `flags: error-recovery`; warnings via `lcr show`.
- [TESTS-07] (MAJOR) A new or changed ident printer has a `css_modules_test` showing whether the name is hashed at the definition and the references.
  verify: the PR's tests.
- [TESTS-08] (MAJOR) Making a construct known (pseudo-class, pseudo-element, at-rule) is tested at the lightningcss level, including what the spec allows after or inside it, not only by `parcel_selectors` parse tests.
  verify: `minify_test` tuples; WPT `css-pseudo/parsing/*`.
- [TESTS-09] (MAJOR) A fix covers its whole class, the linked repro included: the same input shape is tested for each sibling type, handler, math function or color-space branch where the faulty pattern exists.
  verify: `rg` the fixed pattern around the diff.
- [TESTS-10] (MAJOR) JS-facing changes have `node/test/*.mjs` tests that run from the repo root and in both wasm modes.
  verify: B5; CI test-wasm via B6.
- [TESTS-11] (MINOR) Changed expectations cite their reason (spec, WPT, issue), and WPT-derived cases cite the WPT file and take expected values from it, not from LightningCSS output.
  verify: the PR's src/lib.rs hunk.
- [TESTS-12] (MINOR) Tests are deterministic across runs and platforms: no HashMap order, hash seeds, platform float formatting or absolute paths in module hashes.
  verify: read hashes and numbers in new expectations.
