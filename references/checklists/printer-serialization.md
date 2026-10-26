# printer-serialization checklist (PRINT)
Covers `src/printer.rs`, `src/serialization.rs`, `src/values/string.rs`, printing in `src/macros.rs`, and every `ToCss` impl a PR changes. Spec: `references/spec/syntax-values.md` §2.

- [PRINT-01] (BLOCKER) Every rule kind printed without braces or without its last `;` is tested followed by another declaration and another rule, and re-parses to the same rules.
  verify: probes nesting/nested-declarations-semicolon*; mutation nest; T3.
- [PRINT-02] (BLOCKER) Adjacent tokens that would re-tokenize differently keep a separator in every serializer, and a unit starting with `e` plus a digit is escaped (SYN#serialization).
  verify: probes printer-serialization/token-number-*, printer-serialization/dimension-unit-e-digit-not-exponent, custom-properties/plus-sign-token-boundary.
- [PRINT-03] (BLOCKER) Every name reaching output (property ids, at-rule names, descriptors, `@page` names, pseudo-classes, media types, layer and keyframes names) goes through `serialize_identifier`/`serialize_name`, never a raw `write_str`.
  verify: probes printer-serialization/transition-property-ident-escaped, at-rules-other/*escaped*, selectors/custom-pseudo-class-name-escaped, media-queries/custom-media-type-name-escaped.
- [PRINT-04] (MAJOR) A string is unquoted into identifiers only when they re-parse to the same value (whitespace runs, leading/trailing spaces, CSS-wide or generic first words, `revert-rule`).
  verify: probes font/family-consecutive-spaces, font/generic-family-name-quoted, font/font-family-revert-rule-stays-quoted.
- [PRINT-05] (MAJOR) Strings and `url()` serialize per CSSOM: `"` and `\` escaped, a space after a hex escape before a hex digit or whitespace, the chosen quote escaped when quotes flip.
  verify: probes printer-serialization/hex-escape-before-space, printer-serialization/string-escapes-roundtrip.
- [PRINT-06] (MAJOR) Omitting default components never yields an empty or different value: an all-default shorthand prints a keyword, separators stay right.
  verify: probes border-outline/border-image-none-*; O3.
- [PRINT-07] (MAJOR) A number formatting change keeps one `-`, exact integral values and the number type flag, in every sibling serializer.
  verify: probes values-numeric/negative-scientific-percentage-no-double-hyphen, values-numeric/large-integral-value-no-i32-saturation, printer-serialization/token-number-type-flag-kept.
- [PRINT-08] (MAJOR) A shortened form is accepted by every target browser, not just valid per spec (OM#serialize-a-css-value).
  verify: O3 under engine-legacy-2023 and engine-legacy-2021; mutation retarget-legacy.
- [PRINT-09] (MAJOR) `ToCss` writes to `dest`, never a throw-away `Printer::new` (losing targets, css_module, prefix and source-map state), so print-time lowering sees the minify targets.
  verify: grep the diff for `Printer::new(`; mutations retarget-none, retarget-legacy.
- [PRINT-10] (MAJOR) Minify drops only whitespace the known grammar makes insignificant; token lists keep one space; pretty printing adds none inside unknown syntax.
  verify: probes custom-properties/var-empty-fallback-idempotent*, custom-properties/attr-type-syntax-print.
- [PRINT-11] (MAJOR) No escape produces `</style`, no `@charset` is emitted, comments other than leading `/*!` are dropped without merging tokens.
  verify: probes printer-serialization/style-end-tag-not-emitted-in-strings, printer-serialization/comment-dimension-function.
- [PRINT-12] (MAJOR) Deep nesting overflows neither the `u8` indentation in `Printer` nor the stack in `StyleRule::to_css`.
  verify: R1 on a generated 150-200 level nested probe in modes print and lower.
- [PRINT-13] (MINOR) No churn without a semantic reason (keyword case, quote style, order): downstream snapshot suites diff output, Vite string-replaces dependency `url("…")` placeholders, and urls stay quoted when not minifying.
  verify: realworld deltas; node dependency tests (B5).
- [PRINT-14] (NOTE) The JS `transform()` runs `minify()` even with `minify:false` (only whitespace changes), while harness mode print skips it: check "unminified" claims both ways.
  verify: the PR's `test` helper cases vs probes in mode print.
