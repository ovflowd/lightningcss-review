# Color checklist (`color`): `src/values/color.rs`, `alpha.rs` and the fallback paths they drive.
Rules and anchors: `references/spec/color.md`. FAIL only for a violation head adds; one base already has is PASS.

- [COLOR-01] (BLOCKER) No touched conversion or fallback path, nor its siblings, unwraps a conversion of an unconvertible color (`currentcolor`, system colors, `light-dark()` arms holding them); every `CssColor` match handles each variant.
  verify: grep the diff for `.unwrap()` after `to_rgb/to_p3/to_lab` and `unreachable!()`; probe `light-dark(currentcolor, oklch(.5 .1 200))` at chrome 90; color/*no-panic*
- [COLOR-02] (BLOCKER) An earlier declaration stays as the author's fallback when a later one is invalid, unparsed or not parsed by every target; each declaration needing fallbacks gets its own.
  verify: mutations `reverse-decls`, `duplicate-nonadjacent`, `var-after`; color/fallback-kept-*, color/second-lab-*; `FallbackHandler` (first occurrence only, `Unparsed` overwrites)
- [COLOR-03] (MAJOR) `@supports` wide-gamut copies of custom properties and unparsed values attach to the declaring selector in every rule kind, never with an empty selector, and are not regenerated inside a guarding `@supports`.
  verify: mutations `nest`, `wrap-layer`, `wrap-supports`; color/nested-decl-*; side rules in `context.rs`
- [COLOR-04] (BLOCKER) `light-dark()` lowering emits toggles for every `color-scheme` holding `light`/`dark` (one that now parses as `Unparsed` gets none), keeps `!important`, survives nesting and re-minification; changed output for existing inputs needs a flag or maintainer sign-off.
  verify: oracle scheme jobs; mutations `important`, `nest`; color/light-dark-*; `ColorSchemeHandler`
- [COLOR-05] (BLOCKER) `none` survives every path that keeps a color (hex printing, token-list re-parse, the branch modern engines take).
  verify: color/*none*; spec #missing
- [COLOR-06] (BLOCKER) Static `color-mix()`, relative colors and `alpha()` follow the spec: analogous carry-forward, same-space operands unconverted, no clamping or gamut mapping of operands/origins, current powerless rules, hue fix-up, premultiplication, percentage normalization, origin alpha when omitted; NaN and infinite hues resolve to 0, never `none`.
  verify: color/mix-*, color/color-mix-*, color/rcs-*, color/relative-color-*, color/calc-nan-*, color/infinite-hue-*; WPT color-computed-*.html by hand
- [COLOR-07] (BLOCKER) Syntax browsers reject stays unparsed: mix percentages outside [0,100], `specified hue`, `calc(h + 1deg)`, legacy commas with numbers or `none`, `alpha()` without `/`.
  verify: color/*stays-invalid, color/hue-method-specified-is-invalid
- [COLOR-08] (BLOCKER) No color switches between legacy and non-legacy form (gradient interpolation space), and `hsl()`/`hwb()` operands of an unresolved `color-mix(in hsl|hwb)` keep hue and saturation.
  verify: color/gradient-*; spec #interpolation-space
- [COLOR-09] (BLOCKER) `currentcolor`, system colors, unequal `light-dark()` arms, `contrast-color()` and functions containing them are never resolved at build time.
  verify: color/*not-precomputed, color/currentcolor-inherits-*, color/light-dark-*collapse
- [COLOR-10] (MAJOR) The final declaration is the authored color or an exact equivalent (oklab/oklch → lab clamps L first); P3 only when a target supports it.
  verify: mutations `retarget-legacy`, `retarget-modern`; color/lowering-*
- [COLOR-11] (MAJOR) Gamut-mapping or conversion changes keep the binary-search contract (white/black cut-offs, in-gamut unchanged), every other use of a shared constant, and add no float residue.
  verify: `engine-legacy-2021`, `engine-legacy-2023`; color/gamut-map-*; `map_gamut`
- [COLOR-12] (MAJOR) Hex alpha only with HexAlphaColors, shortening only when every pair repeats, non-black transparent never `transparent`, opacity < 1 never `1`, `color-scheme` order kept.
  verify: color/hex-alpha-shortening, color/opacity-*, color/color-scheme-*, color/transparent-colors-*
- [COLOR-13] (MAJOR) A change holds in every color context (shorthands, shadows, gradients, custom properties, `@property`, `@keyframes`); newly typed syntax brings conversion and fallbacks, and a failed typed parse never silently skips lowering.
  verify: mutations `var-before`, `nest`; PR tests in several contexts
- [COLOR-14] (MINOR) Color parsing stays linear in nesting depth.
  verify: time base vs head on 18 nested `light-dark(` around `var(--a)`, and on 18 nested `rgb(1 2 3 / `
