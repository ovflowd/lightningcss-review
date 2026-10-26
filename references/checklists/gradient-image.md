# gradient-image checklist (IMG)
`src/values/gradient.rs`, `image.rs`, `url.rs`. Spec: `references/spec/images-effects.md` (anchors as there).
Judge gradient deltas by O6 pixels, not computed strings; 2011 prefixed gradients need output assertions.

- [IMG-01] (BLOCKER) Every standard-syntax shortcut in `LinearGradient::to_css`/`LineDirection::to_css` (drop `to bottom`/`180deg`, keyword → angle, `0deg` flip) is gated on `is_prefixed`; prefixed gradients keep 2011 meaning in print and minify.
  verify: gradient-image/*prefixed-gradient*, gradient-image/*legacy*; WD-css3-images-20110217#linear-gradient-syntax
- [IMG-02] (MAJOR) Generated prefixed fallbacks convert exactly (`to <side>` → opposite start side, `(90deg − a) mod 360`, radial `<position>, <shape> <size>`), and the PR tests lowering with minify as well as pretty print.
  verify: gradient-image/legacy-*, gradient-image/webkit-radial-gradient-legacy-position; `engine-legacy-2023` (Chromium 100-112 render the `-webkit-` copy made for `image-set()`) -> O4
- [IMG-03] (BLOCKER) Shortening is exact: stops reversed (`to top` flip) only if non-decreasing after fixup with midpoint hints; a hint dropped only at the resolved midpoint, not every `50%`; corners never become angles; an interior stop position goes only if equal to its fixup value.
  verify: gradient-image/to-top-flip-*, gradient-image/*0deg-flip*, gradient-image/*hint-50pct*, gradient-image/corner-direction-not-angle; images-3#color-stop-fixup
- [IMG-04] (BLOCKER) No stop crosses legacy ↔ non-legacy syntax (relative color, `color-mix()`, lab/oklch) without an explicit method; `in <space>` dropped only when redundant; `none` and transparent hue kept in polar spaces.
  verify: gradient-image/*stays-nonlegacy, gradient-image/in-*-kept-*, gradient-image/oklch-transparent-stop-hue-matters; color-4#interpolation-space
- [IMG-05] (MAJOR) `image-set()` prints an explicit `x` resolution (never omitted, never `dppx`) for typed values and inside token lists (`var()`, custom properties); option order and duplicates kept.
  verify: gradient-image/image-set-x-unit-in-token-list, gradient-image/image-set-option-order-preserved; `var-before`, `engine-legacy-2021` -> O3/O4
- [IMG-06] (MAJOR) An author fallback before `image-set()` survives while any target lacks that exact form (`type()`, strings, non-`url()` images; prefixed form takes only `url()` + `x`); partial compat support is not support; the prefixed copy appears once, never as `-moz-/-o-image-set`.
  verify: gradient-image/image-set-*-kept*; `ImageSet::is_compatible`; `engine-legacy-2021`, `engine-legacy-2023` -> O4
- [IMG-07] (MAJOR) A generated `-webkit-gradient()` appears only when exact (monotonic percentage stops, no hints, no method); otherwise the fallback is skipped.
  verify: gradient-image/webkit-gradient-nonmonotonic-stops; `convert_stops_to_webkit`
- [IMG-08] (BLOCKER) Invalid gradients stay unparsed and keep the earlier declaration: 3-value `at`, lengths on conic stops, unitless non-zero positions, negative radial sizes.
  verify: gradient-image/radial-three-value-position-invalid, values-numeric/*unitless*; `reverse-decls`; values-4#position
- [IMG-09] (BLOCKER) `url()` re-parses to the same URL: unquoted output escapes `( ) ' "` and whitespace; modifiers and `src()` are preserved, never a parse error; `url("")` never becomes `none`.
  verify: gradient-image/url-request-modifier; `Url::parse`, `Url::to_css`; values-4#urls
- [IMG-10] (MAJOR) With `analyzeDependencies`, every url-bearing value touched (incl. `image-set()` strings) reports a dependency at the `url(` token; `url(#id)` and `data:` are not dependencies.
  verify: PR `dep_test`/node tests (probes cannot set the option); `Url::is_absolute`
- [IMG-11] (MAJOR) Lowered gradients keep the authored one last, put fallbacks only in the matching-prefix property, and converted unparsed gradients keep `none` and `in <space>`; color-fallback paths are tested with `currentcolor`.
  verify: color/lowering-*, color/currentcolor-gradient-fallback; `retarget-legacy`, `engine-legacy-2023` -> O4
- [IMG-12] (MAJOR) New typed syntax (`in <space>`, `<zero>` conic stops, single stop, L4 radial sizes, `cross-fade()`) accepts every valid form, lowers only exactly, and is flagged if draft or single-engine.
  verify: gradient-image/conic-unitless-zero-stop; O7; `prefix_test` with and without the feature; double positions split only at print, from printer targets
