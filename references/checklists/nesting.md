# nesting checklist (NEST)
Covers `NestedRuleParser`, `src/rules/nesting.rs`, print-time lowering in `StyleRule::to_css_base`, `serialize_nesting` in `src/selector.rs`, nested lists in `CssRuleList::minify`. Spec: `spec/cascade-conditional.md`. Probes: `nesting/` unless prefixed; condition-scoped ones come in true/false pairs.

- [NEST-01] (BLOCKER) Declarations after or between nested rules get the same side rules as a style rule's own (logical `:dir()`/`:lang()`, `@supports` fallbacks, light-dark `@media`), emitted right after that block with the parent's selectors in the same conditions, then the context drains: nothing dropped, attached to the next sibling or hoisted.
  verify: probes nested-decl*, *after-nested-rule*, nested-media-logical-dropped, logical/nested-declarations-logical-fallback-on-parent; O1/O4 (mutation nest puts no declaration after a nested rule).
- [NEST-02] (BLOCKER) With nesting preserved, minified output re-parses to the same rules: an invisible nested-declarations block is followed by `;`, statement at-rules (JS custom ones too) end with `;`, no tokens glue across rules.
  verify: probes *semicolon*; R2; O3; mutation nest with retarget-none.
- [NEST-03] (BLOCKER) Lowering keeps order and importance: parent declarations, nested rules in order, trailing declarations as a parent-selector rule; `!important` kept apart in nested rules and group rules; unknown at-rules stay inside their parent, also in nested `@media`/`@supports`/`@layer`.
  verify: probes *order*, important-in-nested-media, unknown-at-rule-stays-in-style-rule, at-rules-other/unknown-at-rule-*; mutations important + nest.
- [NEST-04] (BLOCKER) `&` never represents a pseudo-element: lowered output under a pseudo-element parent matches what native nesting matches (nothing for `.a::before{&:hover{}}`), `:is()` wrappers keep that guard, lists with a pseudo-element branch are handled. Making such rules match is wrong.
  verify: probes *pseudo-element*, plus `&:hover` after the pseudo-element and `.b + &`; NEST#nest-selector; O1 with targets.
- [NEST-05] (BLOCKER) Lowered selectors keep spec specificity: `&` = `:is(parent list)` (max; without `:is()` support keep it or use an exact strategy, never a re-split list or `:-webkit-any()`), nested declarations keep each parent's own, top-level `&` → `:where(:scope)`, a parent is inlined only leftmost in an absolute selector (not in `:has()` after a combinator or `:nth-child(… of &)`).
  verify: probes *specificity*, has-relative-nesting-selector-wrapped-in-is, nth-child-of-ampersand-not-relative; O1 with a weaker competing rule; targets chrome 80 need output assertions.
- [NEST-06] (BLOCKER) `&` beside a type selector stays valid: `&div` is dropped (never `div.a`), `div&` lowers through `:is()` or a type-first swap, `&` in a later compound is never string-concatenated (`.foo{> &a{}}` ≠ `.foo>.fooa`); unwrapping `:is(input:checked)` keeps the type first.
  verify: probes nesting-selector-before-type-selector-is-invalid, relative-amp-type-selector-not-concatenated; WPT css/css-nesting/parsing.html.
- [NEST-07] (MAJOR) An invalid nested item is dropped alone under errorRecovery (earlier declarations and the parent survive), strict mode still errors, and only rules allowed in style rules are accepted.
  verify: probes error-recovery-keeps-declarations-before-invalid-nested-rule, parser-syntax/error-recovery-keeps-*, at-rules-other/nested-property-in-style-rule-error; SYN#consume-block-contents.
- [NEST-08] (BLOCKER) Nested lists get top-level merge safety: a rule with nested rules is never merged or deduped, split lists keep every selector, side rules never get an empty selector list.
  verify: probes nested-split-selector-not-dropped, supports-fallback-empty-selector, rule-merging/stale-dedup-index-drops-nested-rule; mutation duplicate-nonadjacent.
- [NEST-09] (BLOCKER) No crash or blow-up: `:host(&)`/`::slotted(&)` lower without recursion, prefixed nested rules are not re-printed per ancestor prefix, lists do not grow exponentially.
  verify: probes host-amp-nested-rule-no-stack-overflow, prefixed-nested-selector-no-duplication; R1, S2.
- [NEST-10] (MAJOR) Changing when nesting is lowered, or unwrapping `@media all {}` in a style rule, handles engines with nesting but no `CSSNestedDeclarations` (they hoist trailing declarations). Preserved nesting with `&` and no targets is by design.
  verify: output assertion for `.a{&{color:blue} color:red}` at chrome 125 (no harness engine there).
