# custom-properties checklist (VAR)
Covers `src/properties/custom.rs` (TokenList, `var()`, `env()`), `src/values/syntax.rs`, `src/rules/property.rs`, the Unparsed paths of `src/properties/mod.rs`, `prefix_handler.rs` and `src/declaration.rs`. Spec: `references/spec/syntax-values.md` §5.

- [VAR-01] (BLOCKER) Token-list whitespace that matters after substitution survives: adjacent `var()`/functions/idents/numbers keep one space when minified, and visitors still see whitespace tokens (an identity visitor round-trips).
  verify: probes custom-properties/*adjacent*, values-numeric/attr-ident-unit-space; O1 in Firefox.
- [VAR-02] (BLOCKER) Dropping a comment or sign never merges tokens (`12px/**/var(--f)`, `x//**/*y` opening a comment, `1px+2px`, `2e3.4`).
  verify: probes custom-properties/comment-*, custom-properties/plus-sign-token-boundary, printer-serialization/comment-dimension-function.
- [VAR-03] (BLOCKER) A handler that buffers a property flushes before an Unparsed declaration of it or a related property, so typed-then-var() and var()-then-typed keep source order.
  verify: mutation reverse-decls; probes custom-properties/position-direction-var-fallback-order, box-model-size/width-literal-then-var-order, rule-merging/prefix-handler-in-place-update-reorders-unparsed (var-before/var-after reuse the typed value, so a pure reorder looks equivalent).
- [VAR-04] (BLOCKER) An unparsed value without a valid substitution function never deletes an earlier declaration of the property (V5#resolve-property).
  verify: probes rule-merging/invalid-color-*, effects-masking/invalid-filter-empty-replaces-valid; O7 `fallback-changed`.
- [VAR-05] (BLOCKER) `var()`/`env()` parse as Unparsed in every property, special-cased ones included, and stay tokens in preludes that allow them; a typed parse failing on a value it used to accept is a delta, as the Unparsed path skips lowering, renaming and handlers.
  verify: probes custom-properties/all-var-accepted, supports-container/container-query-var, custom-properties/invalid-var-dropped-with-recovery; O7 `valid-became-invalid`.
- [VAR-06] (MAJOR) Token text is kept: no new color, number, unit, `none`, url or calc normalization in token lists (VAR#serializing-custom-props).
  verify: probes custom-properties/*verbatim*, custom-properties/integer-token-keeps-all-digits; output-contains (oracle tolerance hides drift).
- [VAR-07] (MAJOR) Context-free token rewrites are valid in every substitution context (`x` stays `x` for `image-set()`, `rgb(none 0 0)` keeps `none`).
  verify: probe gradient-image/image-set-x-unit-in-token-list; mutation retarget-legacy.
- [VAR-08] (MAJOR) `var(--x,)` keeps its empty fallback in minified and pretty output, and pretty printing adds no space inside unknown syntax.
  verify: probes custom-properties/var-empty-fallback-*, custom-properties/attr-type-syntax-print (mode print).
- [VAR-09] (MAJOR) A shorthand with `var()` is kept as written (V5#substitution-in-shorthands).
  verify: mutations var-before, var-after; probe logical/shorthand-with-var-in-calc-lowered.
- [VAR-10] (MAJOR) `@property` validity matches engines (PV#at-property-rule), the printed `initial-value` re-parses to the same syntax alternative, and same-name dedupe never lets an engine-invalid later rule win.
  verify: probes custom-properties/property-*.
- [VAR-11] (MAJOR) Custom-property color and `light-dark()` fallbacks keep cascade semantics: `@supports` copies right after the rule with its selector and `!important` for every rule kind holding declarations; no toggles in descriptors; an author pair is kept.
  verify: probes custom-properties/nested-decls-custom-prop-supports-fallback, custom-properties/light-dark-not-lowered-in-property-initial-value; mutations nest, important; dark-scheme job.
- [VAR-12] (MAJOR) Custom property names compare by code point and print escaped; env() names stay case-sensitive with unknown names and indexes kept (ENV#env-function).
  verify: mutation upper-props; probes custom-properties/*case*, printer-serialization/custom-property-name-escape.
- [VAR-13] (MINOR) Values-5 syntax (`if()`, typed `attr()`, `random()`, `{}` arguments, `...var()`) passes through verbatim, and relative urls in custom properties are not rewritten (dependency analysis keeps `AmbiguousUrlInCustomProperty`).
  verify: probe custom-properties/if-passthrough; `dep_test` cases; output-contains probes.
