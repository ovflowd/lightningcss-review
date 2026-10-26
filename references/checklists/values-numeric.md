# values-numeric checklist (NUM)
Covers `src/values/{number,length,percentage,angle,time,resolution,ratio,position,size,rect}.rs` and every property printing through them. Spec: `references/spec/syntax-values.md` §3.

- [NUM-01] (BLOCKER) Every negative value prints one `-` in every numeric type, including exponent notation and |x| < 1, and a formatting fix covers all sibling serializers (`CSSNumber::to_css`, `serialize_dimension`, `Percentage::to_css`, token lists).
  verify: probes values-numeric/negative-sci*, values-numeric/negative-tiny-percentage-serialization; O3.
- [NUM-02] (BLOCKER) Integral values beyond i32 print their value, never the saturated i32 maximum, and integers keep every digit where `int_value` is known.
  verify: probes values-numeric/large-integral-value-no-i32-saturation, values-numeric/percentage-int-value-serialization, custom-properties/custom-property-integer-precision.
- [NUM-03] (MAJOR) No new precision loss beyond f32 with 6 significant digits; a precision-only delta counts when it is visible (layout units, angles, integers), and each changed expectation is justified.
  verify: probe values-numeric/fractional-length-precision; `lcr show` text (the oracle calls this drift noise).
- [NUM-04] (MAJOR) A unitless non-zero number is never accepted as a `<length>` and no new caller reuses that leniency; a fix keeps literal `0` valid and leaves `width:10` Unparsed so the earlier declaration survives (V4#deprecated-quirky-length).
  verify: probes values-numeric/unitless-*; O7 `invalid-became-valid`.
- [NUM-05] (MAJOR) Literal out-of-range values stay Unparsed for every range (`font-weight` [1,1000], `<integer [1,inf]>`, `span`), rejected and not clamped (V4#numeric-ranges).
  verify: `property_range_test` cases expecting `None`; probe calc-math/out-of-range-calc-font-weight.
- [NUM-06] (MAJOR) Unit canonicalization (ms/s, rad/deg, x/dppx) runs only in typed contexts whose grammar and targets accept the result, never context-free in token lists or `image-set()`.
  verify: probe gradient-image/image-set-x-unit-in-token-list; mutations retarget-legacy, retarget-modern.
- [NUM-07] (MAJOR) A zero length keeps its unit where the slot also accepts `<number>` and inside math; unitless zero is printed only in pure `<length>` slots (V4#lengths).
  verify: probes values-numeric/line-height-zero-interpolation, custom-properties/property-number-or-length-zero, calc-math/unitless-zero-inside-math, flex-grid-align/flex-unitless-zero-basis.
- [NUM-08] (MAJOR) `0%` is not rewritten to `0` where the basis can be indefinite (heights, grid tracks, flex-basis).
  verify: O1 on `height`/`flex-basis` probes with an indefinite basis; V4#combine-mixed.
- [NUM-09] (MAJOR) A change to a shared value type (`Position`, `DimensionPercentage`, `NumberOrPercentage`, `Size2D`, `Rect`) is shown valid in the grammar of every property using it (3-value `<position>` exists only in `background-position`).
  verify: radius_areas in `prepare.json`; probe transform/transform-origin-keywords-z; O7 per touched property.
- [NUM-10] (MAJOR) `<integer>` slots reject `1.0`, `1e3`, `1.5`, and `calc()` there is kept until integer calc rounds half toward +inf.
  verify: probes calc-math/integer-calc-not-unwrapped, printer-serialization/token-number-type-flag-kept.
- [NUM-11] (MAJOR) Every new unit or keyword is wired to its compat feature in `IsCompatible` with desktop versions, so an author fallback before it is kept for targets lacking it (the root-relative font units are not wired today).
  verify: probe box-model-size/opera-desktop-dvh-fallback-kept; a probe `width:10px;width:1rch` for Safari 16 asserting `10px`; mutation engine-legacy-2021.
- [NUM-12] (MAJOR) Zero and default checks in serializers use `is_zero()`, never equality with a px zero, so `0rem` from visitors prints like `0px`.
  verify: read the diff for `== …::zero()`; a visitor test with `0rem` components.
- [NUM-13] (MINOR) Shortened forms parse in every target: exponents, `<ratio>` `a / 1` -> `a`, `x`, and never an exponent ahead of a unit starting with `e`.
  verify: mutation retarget-legacy; engine-legacy-2021; probe printer-serialization/dimension-unit-e-digit-not-exponent.
