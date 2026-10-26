# cascade-layers-scope checklist (LAYER)
Covers `src/rules/{layer,scope,import}.rs`, layer bookkeeping in `CssRuleList::minify`, import state in `TopLevelRuleParser`, the `@scope` arm of `NestedRuleParser`, CSS-wide keywords. Spec: `references/spec/cascade-conditional.md`. Probes are under `cascade-layers-scope/` unless prefixed.

- [LAYER-01] (BLOCKER) Merging same-name `@layer` blocks or hoisting statements never moves layer content across a rule that may declare layers (conditionals, `@import`, unknown at-rules, style rules with nested rules) or across a sublayer declared another way (`@layer a.b`, nested `@layer`); a new `CssRule` variant does not join the arms that keep `layer_rules` alive.
  verify: probes layer-*, nested-sublayer-statement-order; mutations wrap-media, wrap-supports (they skip inputs with top-level layer statements: wrap in a PR probe).
- [LAYER-02] (BLOCKER) An empty `@layer x {}` (also in a true `@media`) still declares `x`: it may become `@layer x;`, removed only if `x` was declared unconditionally earlier; a conditional `@import … layer(x)` does not count.
  verify: probes empty-layer-block-in-matching-media-sets-order, layer-statement-before-import-keeps-order (imports not followed, L7: add `output-contains`).
- [LAYER-03] (BLOCKER) Anonymous `@layer {}` blocks never merge, keep their position, and their contents get the same minify and lowering as named layers' even in a list with no named layer.
  verify: probes anonymous-layers-stay-distinct-important, anonymous-layer-contents-lowered; mutations important, wrap-layer.
- [LAYER-04] (BLOCKER) In `@scope`, `&` keeps `:where(:scope)` meaning and zero specificity with and without targets: no bare `:scope`, `<scope-end>` never takes `<scope-start>` as nesting parent, only a nested `<scope-start>` uses the parent rule; `@scope` itself is never lowered, unwrapped, merged or rewritten to `:root`.
  verify: probes scope-*; mutation retarget-legacy (output keeps `@scope`); C6#scope-effects, NEST#nesting-at-scope; latest engines only.
- [LAYER-05] (MAJOR) `@scope` preludes are unforgiving (an invalid selector, pseudo-element or relative `<scope-start>` voids the rule, never a shorter prelude), and the body accepts bare declarations and relative selectors in place.
  verify: probes scope-prelude-selector-list-is-unforgiving, scoped-declarations*; C6#scope-syntax.
- [LAYER-06] (BLOCKER) An `@import` stays valid after `@charset`, layer statements, invalid style rules, unknown at-rules and `@supports-condition`, and is invalid after a valid rule, an empty layer block, or a layer statement between `@import`s: parser state moves to body only once a rule is known valid.
  verify: probes import-valid-after-* (error-recovery; add `output-contains:"@import"`); C5#at-import.
- [LAYER-07] (BLOCKER) `@import` prints `layer`/`layer(name)`, then `supports(…)`, then media, names escaped; `supports()` is never dropped or evaluated; an empty media list is omitted, never `not all`.
  verify: PR probe `@import url(a.css) layer(x.y) supports(display:grid) screen;` with `output-contains`; C5#conditional-import.
- [LAYER-08] (MAJOR) `revert-rule` is a CSS-wide keyword wherever the PR touches keywords: every list (`CSSWideKeyword`, the `all` parser, reserved idents, `font-family` and `@keyframes` name quoting) changes together, and no merge or dedupe changes what it reverts to.
  verify: probes all-revert-rule-is-valid, revert-rule-*, font/font-family-revert-rule-stays-quoted, transition-animation/keyframes-string-name-revert-rule; latest engines only.
- [LAYER-09] (MAJOR) Inlining an `@import` keeps every condition: `@layer`/`@supports`/`@media` wrappers, one layer per anonymous import, layer statements prefixed once, media as a true logical AND (`not` queries, lists).
  verify: no bundle mode in probes: add `src/bundler.rs` or `node/test/bundle.test.mjs` cases (`references/checklists/bundler.md`).
- [LAYER-10] (BLOCKER) Name-defining rules (`@keyframes`, `@property`, `@font-face`, `@counter-style`) are deduped or replaced only within one rule list, and nothing moves a rule into or out of a layer.
  verify: PR probe with same-name `@keyframes` in `@layer a`, `@layer b` and unlayered, with `output-contains` (L5); C5#layer-ordering.
