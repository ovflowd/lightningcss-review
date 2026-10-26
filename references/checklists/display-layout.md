# Checklist: display-layout (prefix DISPLAY)
DisplayHandler (`src/properties/display.rs`), PositionHandler, OverflowHandler, `contain.rs`, direction/unicode-bidi buffering (`src/declaration.rs`), passthrough float/clear/columns/break-*. Spec: `spec/layout.md` §Display. FAIL only when head introduces or widens a violation.

- [DISPLAY-01] (BLOCKER) `position`, `direction` and `unicode-bidi` keep source order against `var()` in both orders: a missing Unparsed arm or a value buffered to finalize lets `var()` print first and lose.
  verify: var-before, var-after; `display-layout/position-var-order*`, `custom-properties/position-direction-var-fallback-order`, `rule-merging/all-shorthand-position`.
- [DISPLAY-02] (BLOCKER) In one rule with targets, DisplayHandler never lets a later prefixed `display` current engines reject (`-ms-flexbox`, `-moz-box`) remove an earlier `display:flex`. `-webkit-box`/`-webkit-flex` are accepted everywhere.
  verify: `flex-grid-align/display-flex-before-ms-flexbox`; value-prefixed-sibling (prefixed first), reverse-decls.
- [DISPLAY-03] (BLOCKER) Duplicate-rule removal (`StyleRule::is_duplicate`) never drops an earlier rule for a later one whose values engines reject: it compares values, not property ids. Independent of DISPLAY-02.
  verify: `rule-merging/duplicate-rule-removal-prefixed-display`; duplicate-nonadjacent.
- [DISPLAY-04] (BLOCKER) The line-clamp idiom (`display:-webkit-box`, `-webkit-box-orient:vertical`, `-webkit-line-clamp`) survives with and without targets; an earlier prefixed display goes only when a later value wins in every target engine.
  verify: `flex-grid-align/webkit-box-orient-*`; retarget-modern; https://drafts.csswg.org/css-overflow-4/#propdef--webkit-line-clamp.
- [DISPLAY-05] (MAJOR) A declaration emitted at finalize stays before a later unowned longhand or reset-only sub-property it resets: `overflow` before `overflow-inline`/`-block`, `position` before `position-anchor`. No engine resets `position-anchor` yet (oracle `equivalent`): assert the output order.
  verify: `rule-merging/overflow-inline-after-overflow`, `display-layout/position-anchor-after-position`; reverse-decls; https://drafts.csswg.org/css-anchor-position-1/#propdef-position-anchor.
- [DISPLAY-06] (MAJOR) `overflow` fallbacks are per target: two values only where supported, and `overflow:hidden` before `overflow:clip` (or an x/y pair folded into `overflow:clip auto`) survives for targets without `clip`.
  verify: `prefixing-compat/overflow-clip-author-fallback-kept`; retarget-legacy, engine-legacy-2021.
- [DISPLAY-07] (MAJOR) `display` takes each keyword at most once and `list-item` only with flow/flow-root; multi-keyword values print the most backwards-compatible, then shortest, form. WebKit rejects some multi-keyword list-item forms and `block ruby` (O9).
  verify: `display-layout/display-*`; https://drafts.csswg.org/css-display-3/#display-value-summary.
- [DISPLAY-08] (MAJOR) Prefixed values are generated only for targets that need them: `-webkit-box`/`-moz-box` inside `is_flex_2009`, `-webkit-flex`/`-ms-flexbox` and `-webkit-sticky` per prefix data, prefixed before unprefixed, `display:-moz-box` wherever `-moz-box-*` longhands are added; an authored prefixed pair collapses only when no target needs the prefix.
  verify: retarget-none, retarget-modern, retarget-legacy; `flex-grid-align/firefox-2009-display-moz-box`.
- [DISPLAY-09] (MAJOR) Typing a passthrough property (contain, content-visibility, float, clear, columns, break-*, `container-type`, scroll-snap-*, scrollbar-*) round-trips every engine-valid value, keeps engine-invalid ones Unparsed and numeric ranges enforced (`column-count` is `<integer [1,∞]>`), and names its owning handler.
  verify: a `P:valid;P:invalid` probe per new grammar; O7; B11.
- [DISPLAY-10] (MAJOR) calc() in an `<integer>` (z-index, order, grid lines) resolves only when fully computable, rounds to nearest with ties toward +∞, and is otherwise kept.
  verify: `calc-math/integer-calc-not-unwrapped`; var-after; https://drafts.csswg.org/css-values-4/#css-round-to-the-nearest-integer.
- [DISPLAY-11] (MINOR) Draft values pass through unnormalized: `display: grid-lanes`/`math`, `visibility: force-hidden`, reading-flow, position-area, position-try-fallbacks, anchor()/anchor-size() in insets, `overflow: overlay`; duplicate passthrough declarations (`float:left;float:inline-start`) keep every fallback a target needs.
  verify: minify round trips; O3; duplicate-nonadjacent.
