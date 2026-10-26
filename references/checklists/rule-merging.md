# rule-merging checklist (MERGE)
Covers `CssRuleList::minify`, `merge_style_rules`, `StyleRuleKey`, `DeclarationBlock::minify`, handlers, side rules in `src/context.rs`. `transform()` always minifies, so these run with `minify:false`. Probes: `rule-merging/` unless prefixed.

- [MERGE-01] (BLOCKER) Buffering keeps declaration order: a handler holding a shorthand flushes before a later declaration it does not own but resets (reset-only or newer longhands, aliases) and before an `Unparsed`/`var()` value of one it owns; in-place prefix overwrites never jump an `Unparsed` value; `finalize` resets fully.
  verify: mutations reverse-decls, var-before, var-after (add distinct values), prefixed-sibling; probes font-reset-only-*, overflow-inline-*, transition-behavior-*, prefix-handler-*.
- [MERGE-02] (BLOCKER) Every key that drops or merges rules compares (property id with prefix, importance) over both lists, CSS-modules source, additive properties (`composes`), condition and layer; a rule using `revert-rule` is never merged or deduped with a same-selector rule.
  verify: probes *important*, dup-rule-keeps-importance, cascade-layers-scope/revert-rule-*; mutation important (none mixes importance: write that probe).
- [MERGE-03] (BLOCKER) Index tables match the rule vector: `rules.pop()` removes the `style_rules` entry, a rule changed by `merge_style_rules` is re-keyed (hash cached at insert), a key never matches its own rule; output ignores hash seed and HashMap order.
  verify: probes *stale-dedup*, dedupe-stale-index-drops-rule; R2; run the corpus twice.
- [MERGE-04] (BLOCKER) Splitting or merging never loses a selector: clones and side rules are built before a merge drains the rule; every split selector is emitted, in nested lists and with `targets: {}` too.
  verify: probes incompatible-selector-kept-after-merge, split-selector-list-not-dropped; mutations retarget-modern, retarget-legacy.
- [MERGE-05] (BLOCKER) Selectors share a list only if each is valid in every target (`is_compatible` classifies unknown, prefixed and compat-less pseudos, `s` flag, `:has()`, namespaces, `:global()`); `:is()` wrapping needs `:is()` support, no pseudo-element, equal specificities (`:has()` counts its argument).
  verify: probes no-merge-*, attr-s-flag-merge, engine-specific-selectors-not-merged, is-wrap-has-specificity; O3.
- [MERGE-06] (BLOCKER) No fallback of a later value a target rejects is removed (C5#filtering): invalid input stays `Unparsed`, a prefixed value never replaces the unprefixed one, with targets the earlier value survives. No targets = perfect engine, by design.
  verify: probes invalid-color-*, empty-flex-*, duplicate-rule-removal-prefixed-*; O7; retarget-legacy with O4.
- [MERGE-07] (BLOCKER) Side rules (`:dir()`/`:lang()`, `@supports` fallbacks, dark `@media`, clones) have a non-empty selector list, follow their rule before its nested-rules clone, keep `!important`, and reset per rule.
  verify: probes all-selectors-incompatible-*, logical/important-logical-*, logical/dir-fallback-*.
- [MERGE-08] (BLOCKER) Folding is exact: a shorthand expands to the same longhands, reset-only included; `translate`/`transform` and longhands sharing a CSS-wide keyword never fold; a drained buffer never prints an empty value; `all` keeps only `direction`, `unicode-bidi`, custom properties before it (C5#all-shorthand).
  verify: probes css-wide-longhands-*, all-shorthand-*, transition-animation/*not-emptied; O7 `shorthand-reset-changed`.
- [MERGE-09] (BLOCKER) A later same-name `@keyframes`/`@property` replaces the earlier in place only with no conditional or layer copy between and a valid later rule, taking the loser's `@supports` fallbacks along; never for `@font-face`, `@layer`.
  verify: probes keyframes-replacement-*, custom-properties/property-invalid-later-*; `output-contains` (L5).
- [MERGE-10] (BLOCKER) Merges stay adjacent: conditional rules need identical conditions, coalesced runs never let dedupe cross the original boundary, `@media all {}` unwraps in a style rule only where equivalent (NEST-10). Non-adjacent merging must show no rule between matches with another value, layer, scope or importance.
  verify: probes no-media-merge-*, adjacent-media-*; mutations wrap-media, wrap-layer, duplicate-nonadjacent.
- [MERGE-11] (MAJOR) Tests cover `minify:false`, no targets and `targets: {}`, nesting, `!important`, CSS modules; no quadratic scan or re-minify of a growing list.
  verify: T2; R2; S2; mutations nest, retarget-none.
