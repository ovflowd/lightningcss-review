# border-outline checklist (BORDER)
`src/properties/border.rs` (BorderHandler drives border-image and border-radius), `border_image.rs`,
`border_radius.rs`, `outline.rs`. box-shadow: FX. Spec: `references/spec/images-effects.md` (anchors as there).

- [BORDER-01] (BLOCKER) `border` resets all `border-image-*` in output order (an earlier border-image is dead, a later one stays after) for typed `border`, unparsed `border: var()` and sides collapsed into `border`; no other border shorthand resets border-image.
  verify: border-outline/*resets-border-image; `var-before`, `var-after`, `reverse-decls` -> O1; backgrounds-3#border-shorthands
- [BORDER-02] (BLOCKER) No all-default shorthand prints empty: `border-image`, `mask-border`, `-webkit-mask-box-image` print `none` when all-initial and a valid value for each single non-default part; the width-omitted form keeps `//`.
  verify: border-outline/border-image-none-*; R2, O3; backgrounds-3#border-image
- [BORDER-03] (MAJOR) Default omission uses the printed property's defaults: the shared serializer does not apply border-image defaults (slice 100%, width 1) to `mask-border`/`-webkit-mask-box-image`, and an explicit `-webkit-border-image` slice (implies `fill`) is kept.
  verify: border-outline/webkit-border-image-explicit-slice, effects-masking/mask-box-image-default-slice; masking-1#the-mask-border-slice
- [BORDER-04] (BLOCKER) Zero lengths keep their unit where `<number>` is valid (border-image width/outset, mask-border): `0px` ≠ `0`; slice `0%` ≠ `0` (interpolation).
  verify: border-outline/*zero-length-stays-length; paused-animation probe; values-4#lengths
- [BORDER-05] (MAJOR) Logical border/radius lowering emits its physical or `:dir()` rules for the declaring rule only: nothing dropped after a nested rule, nothing attached to the next sibling, `!important` kept.
  verify: nesting/*logical*, logical/*important*; `nest`, `important`, `engine-legacy-2021` -> O4
- [BORDER-06] (MAJOR) With targets, BorderImageHandler keeps author order and per-prefix values: a compat flush never prints an earlier `border-image` before a pending `border`, prefixed and unprefixed values with different content are not merged, gradient fallbacks only in the matching-prefix property.
  verify: output assertions (no engine needs `-webkit-border-image`); `prefixed-sibling`, `retarget-legacy`
- [BORDER-07] (BLOCKER) `border-radius` collapse/expansion keeps corner order TL TR BR BL and the axis split (longhand `a b` = h/v, shorthand `a b` = per corner, `/` = axes); expectations come from the spec, not existing tests.
  verify: `reverse-decls` -> O1/O6; backgrounds-3#border-radius
- [BORDER-08] (MAJOR) Collapsing into `border`/`border-<side>` drops no non-initial component: `border:5px none` keeps the width, `border:none` stays distinct from `border:0`, no stray separator.
  verify: `reverse-decls` with a later `border-style` -> O1; backgrounds-3#border-width
- [BORDER-09] (BLOCKER) Invalid values stay unparsed and keep the earlier declaration: `outline-style: hidden`, negative widths/radii/`border-spacing`, unitless non-zero lengths, `hairline` where unsupported.
  verify: border-outline/outline-style-hidden-overrides-valid, values-numeric/*unitless*; O7 `invalid-became-valid`; ui-4#outline-style
- [BORDER-10] (MAJOR) Longhands with CSS-wide keywords never collapse into a shorthand that resets more (`border-*: inherit` → `border: inherit` also inherits border-image).
  verify: rule-merging/css-wide-longhands-not-collapsed-into-shorthand; cascade-5#shorthand
- [BORDER-11] (MAJOR) `outline-style:auto` with an explicit `outline-color` is not collapsed into `outline: auto` (sets color `auto`); a new outline longhand is owned by OutlineHandler or keeps its source position; unowned radius-group properties (`corner*`, `border-shape`) keep order around a deferred `border-radius`.
  verify: spec-only (no engine has `outline-color:auto`): NEEDS_MAINTAINER_DECISION; ui-4#outline-color, borders-4#corner-shorthands
- [BORDER-12] (MINOR) Border color fallbacks are tested with `currentcolor`, system colors and `light-dark()`; prefixed radius copies keep their own per-corner values.
  verify: border-outline/border-color-oklch-currentcolor; `retarget-legacy`, `engine-legacy-2023`, `prefixed-sibling`
