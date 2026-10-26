# effects-masking checklist (FX)
`masking.rs`, `effects.rs`, `box_shadow.rs`, `shape.rs`, opacity, filter/clip-path paths of `prefix_handler.rs`.
Spec: `references/spec/images-effects.md`.

- [FX-01] (BLOCKER) `FallbackHandler` never replaces an unprefixed `filter`/`backdrop-filter` with a later prefixed one, keeps the prefixed form while a target needs it, and keeps distinct per-vendor values, in both orders.
  verify: effects-masking/backdrop-filter-unprefixed-kept, prefixing-compat/*backdrop-filter*; `prefixed-sibling` is prefixed-first only
- [FX-02] (MAJOR) An earlier author filter or `mix-blend-mode` (before `plus-lighter`/`plus-darker`) is dropped only when the later value is supported by every target (a real `is_compatible`), and every declaration gets its color fallbacks, not only the first.
  verify: effects-masking/filter-fallback-kept, color/second-lab-declaration-gets-no-fallback; `engine-legacy-2023` -> O4
- [FX-03] (MAJOR) Prefixed `Unparsed` mask values are idempotent: an authored `-webkit-mask*` next to the same unprefixed value merges into the adjacent output declaration, never a new copy per pass.
  verify: prefixing-compat/mask-image-var-duplicate; R2; `var-before`, `prefixed-sibling`
- [FX-04] (BLOCKER) Unowned mask longhands (`-webkit-mask-composite`, `-webkit-mask-source-type`, `mask-position-x/-y`, unparsed ones) keep source order around a deferred `mask`/`-webkit-mask`.
  verify: effects-masking/*webkit-mask-composite*, effects-masking/mask-position-x-*; `reverse-decls` -> O1 (Chromium decides)
- [FX-05] (BLOCKER) `mask` resets every `mask-border-*` in output order: an earlier mask-border is dead, a later one stays after.
  verify: effects-masking/mask-shorthand-must-reset-mask-border (only WebKit has unprefixed `mask-border`); masking-1#the-mask
- [FX-06] (MAJOR) Mask lowering maps exactly or not at all (composite keywords, `mask-mode` only for WebKit, `mask-border` → `-webkit-mask-box-image` with explicit slice and `width auto`, never luminance → alpha); prefixed copies come first.
  verify: effects-masking/mask-composite-porter-duff-mapping, effects-masking/mask-box-image-default-slice; `engine-legacy-2021`, `engine-legacy-2023` -> O4
- [FX-07] (MAJOR) Every bit of a changed `property_bitflags!` set is distinct (a `mask` flush must not suppress mask-border fallbacks).
  verify: effects-masking/mask-border-fallback-not-suppressed; read `MaskProperty` in the diff
- [FX-08] (MAJOR) Mask layers keep semantics: `none` layers stay, lists stay index-aligned, box keyword rules (one box, two boxes, `<box> no-clip`), a bottom composite dropped only when `add`.
  verify: effects-masking/mask-image-none-layer-kept; `duplicate-nonadjacent` -> O1/O6; masking-1#the-mask
- [FX-09] (BLOCKER) Invalid values stay unparsed and keep the earlier declaration: `mask-clip/-origin: margin-box`, 3-value `mask-position` or shape `at`, empty `filter:`, an unknown filter function, unitless non-zero lengths.
  verify: effects-masking/*invalid*, values-numeric/*unitless*; O7 `invalid-became-valid`; masking-1#the-mask-clip
- [FX-10] (BLOCKER) Filter and opacity rewrites keep rendering, stacking and animation: functions never merged or reordered, identity ≠ `none`, no `hue-rotate` modulo, no drop-shadow ↔ box-shadow, default arguments spec-exact (workarounds behind targets), `opacity` < 1 never `1`.
  verify: effects-masking/filter-identity-not-none, effects-masking/hue-rotate-not-normalized, color/opacity-below-one-not-rounded-to-one; `dom:` with a `z-index:-1` child
- [FX-11] (MAJOR) A changed color-fallback path is tested in every branch (RGB, P3, LAB) with `currentcolor`, system colors and `light-dark()`; sibling conversion `unwrap()`s are fixed too.
  verify: effects-masking/*currentcolor*, calc-math/*no-panic*; grep `to_rgb/to_p3/to_lab().unwrap()`; `retarget-legacy`
- [FX-12] (MAJOR) box-shadow keeps list order, `inset`, `none` vs zero shadows, spread vs blur, and gets fallbacks after an unparsed value (`none` is never typed).
  verify: multi-shadow probe with distinct colors -> O1/O6; `var-before`, `engine-legacy-2023` -> O4; backgrounds-3#box-shadow
- [FX-13] (MAJOR) `clip-path` keeps cascade order across `var()` (in-place `PrefixHandler` update); shape rewrites are exact (`border-box` ≠ `inset(0)` ≠ `none`, no deduped points, `path()` only with O6 evidence).
  verify: rule-merging/prefix-handler-in-place-update-reorders-unparsed, effects-masking/clip-path-border-box-not-inset; `var-after` -> O1; O6
