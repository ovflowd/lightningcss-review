# Checklist: at-rules-other (prefix ATRULE)
`src/rules/` (page, counter_style, namespace, document, position_try, unknown, view_transition, function), prelude dispatch in `src/parser.rs`, napi custom at-rules. Spec: `spec/layout.md` §At-rules. No print media or anchor layout in the oracle. FAIL only when head introduces or widens a violation.

- [ATRULE-01] (BLOCKER) Unknown and custom at-rules nested in a style rule stay inside it, with its selector, when nesting is lowered: as a direct child, after nested rules, in nested declarations and group rules.
  verify: nest with targets; `*/unknown-at-rule-*`
- [ATRULE-02] (MAJOR) Each new or changed prelude arm reaches the `allowed_in_style_rule` check (no early return) and is tested at top level, in @media/@layer/@supports, in a style rule and in @media in one. @property is valid in group rules, not style rules.
  verify: `at-rules-other/*property*`; css-nesting-1#nested-group-rules
- [ATRULE-03] (MAJOR) Under errorRecovery an invalid at-rule is dropped alone with one warning, and the declarations around it survive (not cleared by `parse_nested`); bodies parse with the caller's options. Input base accepted still parses; a built-in grammar (`@-moz-document` beyond `url-prefix()`) fails only its rule or falls back to customAtRules.
  verify: `flags: error-recovery` probes; warnings in `<run>/corpus/outputs-*.jsonl`; parse-error deltas; a customAtRules node test.
- [ATRULE-04] (BLOCKER) Names reach output via `serialize_identifier`/`serialize_name`, never raw `write_str`: an escaped `}`, `:`, space or leading digit stays escaped. Statement at-rules, napi custom ones included, end with `;`.
  verify: `at-rules-other/*escape*`; names with `\7d`, `\31 `, `\:`; a body-less customAtRules case followed by a declaration.
- [ATRULE-05] (MAJOR) Same-name rules are never merged, deduped or moved across each other: @counter-style (replaced atomically), @view-transition (last wins), @position-try (cascades like @keyframes), @page, unknown rules. Risk: in-place replacement in `CssRuleList::minify`.
  verify: `at-rules-other/*not-merged`; duplicate-nonadjacent.
- [ATRULE-06] (MAJOR) `@page`: no whitespace inside a selector, repeated pseudo-pages kept, names case-sensitive, pseudos not; margin at-rules kept; descriptors (`size`, `marks`, `bleed`) never typed or lowered as properties.
  verify: `at-rules-other/page-*`; css-page-3#typedef-page-selector.
- [ATRULE-07] (MAJOR) `@position-try` keeps its declarations unless the spec filter is applied exactly (inset, margin, sizing, self-alignment, position-anchor, position-area; `!important` invalidates only that one); never merged into `inset` or lowered; hashed with `position-try-fallbacks` under dashedIdents.
  verify: css_modules_test with dashedIdents; css-anchor-position-1#fallback-rule.
- [ATRULE-08] (MAJOR) In @counter-style and @property an unknown descriptor is ignored, not fatal; counter-style names keep case; validation rejects exactly `none` and the non-overridable names; CSS modules rename every reference (`list-style-type`, `system: extends`, `fallback`, `counter()`).
  verify: `css-modules/counter-*`, `at-rules-other/property-unknown-descriptor`; css-counter-styles-3#non-overridable-counter-styles.
- [ATRULE-09] (MAJOR) `@namespace` stays before all but @charset/@import/@layer statements and keeps prefix case; a selector with an undeclared or wrong-case prefix never merges into a valid rule (engines drop the list).
  verify: `rule-merging/no-merge-*namespace*`; css-namespaces-3#prefixes.
- [ATRULE-10] (MAJOR) Static evaluation (`@function`, custom media, build-time `var()` substitution) is untouched without its flag; with it, only all-static inputs evaluate: a `var()` from `:root` or an ancestor in any typed slot (parameter, `returns`, `@property` syntax) leaves the call in place, no build error, no silent default.
  verify: `at-rules-other/function-rule-*`; `flags: custom-functions` probes per typed slot.
- [ATRULE-11] (MAJOR) A new at-rule type has typed descriptors (no DeclarationBlock accepting `!important`), visitor/serde attributes, a `CssRule` arm and JS visitor name, ATRULE-02 placement, CSS-modules/unusedSymbols support; new errors get typings.
  verify: B5, B11; `napi/src/transformer.rs`; `node/index.d.ts`.
- [ATRULE-12] (BLOCKER) A `@function` without `result` makes the declaration invalid at computed-value time, never an inlined empty value.
  verify: a probe with an earlier fallback; css-mixins-1#function-rule.
