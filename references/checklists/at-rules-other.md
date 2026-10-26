# Checklist: at-rules-other (prefix ATRULE)
`src/rules/` (page, counter_style, namespace, document, position_try, unknown, view_transition), prelude dispatch in `src/parser.rs`, napi custom at-rules. Spec: `spec/layout.md` §At-rules. Oracle has no print media or anchor layout. FAIL only when head introduces or widens a violation.

- [ATRULE-01] (BLOCKER) Unknown and custom at-rules nested in a style rule stay inside it, with its selector, when nesting is lowered: as a direct child, after nested rules, in nested declarations, and inside nested group rules.
  verify: nest with targets; `at-rules-other/unknown-at-rule-*`, `nesting/unknown-at-rule-*`
- [ATRULE-02] (MAJOR) Each new or changed prelude arm reaches the `allowed_in_style_rule` placement check (no early return) and is tested at top level, in @media/@layer/@supports, in a style rule, and in @media in one. @property is valid in group rules, not in a style rule.
  verify: `at-rules-other/*property*`; https://drafts.csswg.org/css-nesting-1/#nested-group-rules
- [ATRULE-03] (MAJOR) Under errorRecovery an invalid at-rule is dropped alone with one warning, and the declarations around it survive (not cleared by `parse_nested`); bodies parse with the caller's options. Input base accepted, even with a warning, still parses; a built-in grammar (`@-moz-document` beyond `url-prefix()`) fails only its rule or falls back to customAtRules.
  verify: `flags: error-recovery` probes; warnings in `<run>/corpus/outputs-*.jsonl` (deltas ignore them); parse-error deltas; a customAtRules node test.
- [ATRULE-04] (BLOCKER) Names reaching output go through `serialize_identifier`/`serialize_name`, never raw `write_str`: an escaped `}`, `:`, space or leading digit stays escaped. Statement at-rules, napi custom ones included, end with `;`.
  verify: `at-rules-other/*escape*`; names with `\7d`, `\31 `, `\:`; a body-less customAtRules case followed by a declaration.
- [ATRULE-05] (MAJOR) Same-name rules are never merged, deduplicated or moved across each other: @counter-style (replaced atomically), @view-transition (last wins, no cascade), @position-try (cascades like @keyframes), @page, unknown rules. Risk: in-place replacement in `CssRuleList::minify`.
  verify: `at-rules-other/*not-merged`; duplicate-nonadjacent.
- [ATRULE-06] (MAJOR) `@page`: no whitespace inside a selector, repeated pseudo-pages kept, names case-sensitive, pseudos not; margin at-rules kept; descriptors (`size`, `marks`, `bleed`) are never typed or lowered as style properties.
  verify: `at-rules-other/page-*`; https://drafts.csswg.org/css-page-3/#typedef-page-selector.
- [ATRULE-07] (MAJOR) `@position-try` keeps its declarations unless the PR applies the spec filter exactly (inset, margin, sizing, self-alignment, position-anchor, position-area; `!important` invalidates only that one); never merged into `inset` or lowered; the name is hashed with `position-try-fallbacks` under dashedIdents.
  verify: css_modules_test with dashedIdents; https://drafts.csswg.org/css-anchor-position-1/#fallback-rule.
- [ATRULE-08] (MAJOR) In @counter-style and @property an unknown descriptor is ignored, not fatal; counter-style names keep case; name validation rejects exactly `none` and the non-overridable names; CSS modules rename every reference (`list-style-type`, `system: extends`, `fallback`, `counter()`).
  verify: `css-modules/counter-*`, `at-rules-other/property-unknown-descriptor`; https://drafts.csswg.org/css-counter-styles-3/#non-overridable-counter-styles.
- [ATRULE-09] (MAJOR) `@namespace` stays before all but @charset/@import/@layer statements and keeps prefix case; a selector with an undeclared or wrong-case prefix is never merged into a valid rule (engines drop the list).
  verify: `rule-merging/no-merge-*namespace*`; https://drafts.csswg.org/css-namespaces-3/#prefixes.
- [ATRULE-10] (MAJOR) Draft at-rules (`@function`) pass through untouched without their flag; with it, evaluation is static only when every input is, and `var()` resolves against the element, not the calling rule.
  verify: `at-rules-other/function-rule-*`; a `flags: custom-functions` probe with a `var()` argument.
- [ATRULE-11] (MAJOR) A new at-rule type has typed descriptors (no generic DeclarationBlock accepting `!important`), visitor/serde attributes, a `CssRule` arm and JS visitor name, placement per ATRULE-02, CSS-modules/unusedSymbols handling; new error kinds get typings.
  verify: B5, B11; `napi/src/transformer.rs`; `node/index.d.ts`.
