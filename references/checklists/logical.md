# Checklist: logical (prefix LOGICAL)
`src/context.rs` (`add_logical_rule`, `get_additional_rules`), `src/logical.rs`, `side_handler!` in `margin_padding.rs`, logical paths of size/border/border_radius/transition, `:dir()` lowering in `selector.rs`. Spec: `references/spec/fonts-text.md` §4.
FAIL only when head introduces or widens a violation. N/A needs evidence no target lacks the Logical* feature. RTL needs a probe `dom:` line.

- [LOGICAL-01] (BLOCKER) Logical declarations before, between or after nested rules (and in nested @media/@supports) keep their side rules: none dropped, none attached to a sibling or hoisted, each after its own declarations and before later nested rules.
  verify: probes nesting/{logical-after-nested-rule,nested-declarations-side-rules-leak-to-sibling,nested-decl-logical-fallback-hoisted}, logical/nested-declarations-logical-fallback-on-parent; read `NestedDeclarationsRule::minify`
- [LOGICAL-02] (BLOCKER) A logical shorthand with `var()` is split only when provably one component; never copy a multi-value list into each longhand.
  verify: probes logical/{multi-value-var-shorthand,multi-value-shorthand-with-var-equivalent}; mutation var-after with retarget-legacy
- [LOGICAL-03] (BLOCKER) Lowering preserves the cascade in ltr and rtl: a later physical declaration still wins, specificity rises by no more than one pseudo-class, and `!important` stays.
  verify: probes logical/{physical-after-logical-wins,dir-fallback-preserves-declaration-order,dir-fallback-specificity,important-logical-lowering-keeps-important}; mutation important; https://drafts.csswg.org/css-logical-1/#box
- [LOGICAL-04] (BLOCKER) Inline-axis properties map to width/min-width/max-width in both directions, also inside `transition-property`/`transition`.
  verify: probe logical/transition-inline-size-rtl-maps-to-height; read `expand_properties`; https://drafts.csswg.org/css-writing-modes-4/#logical-to-physical
- [LOGICAL-05] (BLOCKER) In one block, logical/physical switches flush (order kept), `var()` longhands lower with the `var()` intact, a repeated unparsed value keeps the earlier one as fallback, and later `margin`/`padding`/`inset` shorthands still override.
  verify: mutations reverse-decls, var-before, var-after with retarget-legacy; read `side_handler!`
- [LOGICAL-06] (BLOCKER) Unowned properties sharing a slot keep order against buffered logical ones: `overflow` vs `overflow-inline`, `-webkit-margin-start`, `-webkit-logical-width`, `direction` vs a later `var()`.
  verify: probes rule-merging/overflow-inline-after-overflow, custom-properties/position-direction-var-fallback-order; mutation reverse-decls
- [LOGICAL-07] (MAJOR) Generated selectors parse in every target: `:dir()` only with DirSelector, `:lang()` lists only with LangSelectorList, `:dir()` before any pseudo-element, prefixed copies not merged away.
  verify: probes selectors/{lang-list-lowered-for-chrome,prefixed-any-inside-not-preserved-without-targets,dir-unknown-ident-is-valid}; mutation engine-legacy-2021
- [LOGICAL-08] (MAJOR) Lowering decisions come from generated Logical* compat features, and a flip comes with before/after output.
  verify: mutations retarget-modern (none), retarget-legacy; read `should_compile_logical`
- [LOGICAL-09] (MAJOR) `include`/`exclude` of LogicalProperties or DirSelector affects only that feature.
  verify: a node or `prefix_test` with `exclude` in the PR (probes cannot set it); read `Targets::should_compile_selectors`
- [LOGICAL-10] (BLOCKER) No lowering where no rule can host side rules (style attributes, descriptor blocks, rules whose selectors were all split off); output re-parses.
  verify: probe rule-merging/all-selectors-incompatible-no-empty-supports-rule; read `should_compile_logical`
- [LOGICAL-11] (MAJOR) The horizontal-tb and `:lang()` direction heuristics are not widened, and differences under `dir=rtl` without an RTL lang are classified, never hidden; no `[dir]` or custom-property toggles.
  verify: probes logical/{sft-vertical-writing-mode-inset-block-lowering,sft-dir-attribute-without-lang}; https://drafts.csswg.org/selectors-4/#the-dir-pseudo
- [LOGICAL-12] (MINOR) New flow-relative value lowering (float/clear, caption-side, overflow-*, resize) uses the containing block's direction; `inherit` is not claimed equivalent across a direction change; SVG `writing-mode` values survive.
  verify: probe with parent `dir=rtl`, child `dir=ltr`; https://drafts.csswg.org/css-logical-1/#float-clear
