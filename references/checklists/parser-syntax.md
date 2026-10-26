# parser-syntax checklist (SYN)
Covers `src/parser.rs`, `src/declaration.rs`, `src/stylesheet.rs`, `src/error.rs`, `derive/src/parse.rs`, the `Property::parse` fallback and cssparser bumps. Spec: `references/spec/syntax-values.md` §1.

- [SYN-01] (BLOCKER) With errorRecovery an invalid declaration, nested rule or disallowed at-rule drops only itself; valid declarations before and after it in the block survive (SYN#consume-block-contents).
  verify: probes parser-syntax/error-recovery-*, nesting/error-recovery-keeps-declarations-before-invalid-nested-rule.
- [SYN-02] (BLOCKER) No input base accepted becomes a sheet error: a new grammar branch returns to the `Property::Unparsed` token fallback instead of propagating Err, also for `var()`/`env()` values of special-cased properties.
  verify: mutations var-before, var-after; probes custom-properties/all-var-accepted, gradient-image/url-request-modifier; `lcr show` on head-only errors.
- [SYN-03] (MAJOR) Valid input gets no new warning (Turbopack turns `UnexpectedToken`, `EndOfInput` and selector warnings into build errors), and each new `Err` branch is also tested with errorRecovery on; a warning becoming an error is flagged as breaking.
  verify: diff warnings in `<run>/corpus/outputs-*.jsonl` (deltas ignore them); probes supports-container/container-name-only-error-recovery, media-queries/general-enclosed-calc-error-recovery; grep for `dbg!`.
- [SYN-04] (MAJOR) Browser-invalid input stays invalid: no new leniency (unitless lengths, hashless hex, `//` comments, `*`/`_` hacks, `2n+1of`), because a typed value lets dedupe delete the author's earlier valid declaration.
  verify: O7 `invalid-became-valid`; probes values-numeric/unitless-length-invalid, calc-math/unitless-zero-in-calc-keeps-fallback; a probe with the invalid form after a valid one.
- [SYN-05] (BLOCKER) Each new recursive path, and each `try_parse` alternative inside a recursive grammar, is depth-bounded and linear; only `TokenList` has a `MaximumNestingDepth` guard.
  verify: generated depth-18 and depth-22 probes (`expect: no-panic`) timed on base and head (x16 per 4 levels is the signal); probe calc-math/sum-of-parenthesized-sums-no-crash.
- [SYN-06] (MAJOR) Nested parsers inherit the caller's ParserOptions (error_recovery, warnings, flags, css_modules, locations): no new `ParserOptions::default()`, `filter_map(Result::ok)`, or `ParserInput` over a substring without a token fallback.
  verify: grep the diff for those three; probes transition-animation/keyframe-nested-at-rule, custom-properties/property-initial-value-color-mix-currentcolor.
- [SYN-07] (MAJOR) A cssparser bump or hand-built `Token` keeps `int_value` and `has_sign` right, and every tuple or realworld delta it causes is explained.
  verify: probes values-numeric/percentage-int-value-serialization, values-numeric/large-integral-value-no-i32-saturation; S1.
- [SYN-08] (MAJOR) A new or reordered `#[derive(Parse)]`/`enum_property!` variant keeps priority: unit variants match as idents, data variants in declaration order, so a broad variant first never shadows a narrower one or a keyword.
  verify: read the enum diff against `derive/src/parse.rs`; a probe per affected keyword and data variant.
- [SYN-09] (MAJOR) Case-insensitive matching is used only for property, at-rule, function names and keywords, never for `--*`, `<custom-ident>`, env() names or `@property` data type names.
  verify: mutation upper-props; probes custom-properties/custom-property-name-case, custom-properties/env-name-case-sensitive, custom-properties/property-syntax-case-sensitive.
- [SYN-10] (MAJOR) `!important` and `{}` follow SYN#consume-declaration: importance never moves between lists, and a typed value with `{}` stays invalid instead of becoming a nested rule.
  verify: probe parser-syntax/important-whitespace-case; mutation important; a probe `--x:{a} b` beside `width:10px {}`.
- [SYN-11] (MINOR) CDO/CDC are dropped only at top level, a BOM is handled the same in files and bundles, and `@charset` stays dropped.
  verify: probe parser-syntax/cdo-cdc-top-level; output-not-contains probes (the oracle cannot see U+FEFF).
- [SYN-12] (MINOR) Locations point at the token after skipped whitespace and stay relative to the original file for re-parsed substrings.
  verify: PR tests asserting `loc`; node location tests (B5).
