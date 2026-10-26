# transform checklist (XFORM)
`src/properties/transform.rs` (`Transform::to_css`, `TransformHandler`), PrefixHandler transform properties, motion path, `will-change`. Spec: `references/spec/anim-transforms.md`.
Rewrites run only with `dest.minify`; interpolation is invisible at rest (L5): sample with `animation: k 1s linear -0.5s paused`, compared within one engine.

- [XFORM-01] (BLOCKER) `translate`/`rotate`/`scale` are never folded into `transform`, a later `transform` (even `none`) never resets them, and a later duplicate `transform` wins.
  verify: probes transform/individual-*, transform/transform-duplicate-last-wins; mutations reverse-decls, duplicate-nonadjacent; https://drafts.csswg.org/css-transforms-2/#ctm
- [XFORM-02] (BLOCKER) No list is collapsed into or decomposed from a matrix, and functions are renamed only within one primitive (`skew`, `skewX`, `skewY` share none).
  verify: probes transform/rotate-over-360-not-matrix, transform/sat-skew* (WebKit-only pass = O9); https://drafts.csswg.org/css-transforms-2/#transform-primitives
- [XFORM-03] (BLOCKER) `none` and identity values are never interchanged (`translate: none` ≠ `0`, `rotate: none` ≠ `0deg`, `transform`/`perspective: none` ≠ identity); individual properties print `none` only when specified.
  verify: probes transform/*none*, transform/sat-individual-identity-not-none; `dom:` with a `position: fixed` child
- [XFORM-04] (MAJOR) Identity functions in a list are kept, only count-preserving rewrites happen, `rotate` axes collapse to an angle only for z vectors (right sign), and other axes are negated only if interpolation is unchanged.
  verify: probe transform/sat-identity-functions-kept-in-list; sampling against an unnormalized endpoint (split = O9)
- [XFORM-05] (MAJOR) 3D functions stay 3D (status, `is2D`, `translateZ(0)` hint) unless the PR states the collapse as a maintainer decision.
  verify: probe transform/sat-translate3d-zero-keeps-3d-function; `output-contains`
- [XFORM-06] (MAJOR) Parsing keeps the grammar: unitless non-zero lengths stay invalid (no `px` repair), unitless `0` angles only inside functions, negative `perspective` invalid, `perspective(none)` kept.
  verify: probes values-numeric/unitless-translate-invalid, transform/sat-rotate-unitless-zero-stays-invalid; `src/values/length.rs`
- [XFORM-07] (MAJOR) `transform-origin`'s third value is always z, offset 3/4-value forms stay invalid, `perspective-origin` has no 3-value form, one-value shortening drops only `center`.
  verify: probes transform/transform-origin-keywords-z, transform/sat-*-origin-*; https://drafts.csswg.org/css-transforms-1/#transform-origin-property
- [XFORM-08] (MAJOR) f32 printing never makes an invertible matrix singular; small rotations and translations are read raw, not trusted to `noise`.
  verify: probe `matrix(1,1,1,1.0000001,0,0)`; values in `lcr show`
- [XFORM-09] (MAJOR) Handlers keep order with `var()`: `Unparsed` flushes buffered values, a `var()` transform gets one `-webkit-` copy (not one per pass), PrefixHandler never moves a later value before an intervening `var()`.
  verify: probe rule-merging/prefix-handler-in-place-update-reorders-unparsed; three distinct values; `safari 8` second pass
- [XFORM-10] (MAJOR) Prefixed copies print first, different-valued prefixed/unprefixed pairs keep order, an equal authored prefix is dropped only if no target needs it, every `@keyframes` copy is prefixed.
  verify: `safari 8` targets, `output-contains`; mutations prefixed-sibling, retarget-legacy, retarget-none
- [XFORM-11] (MAJOR) Individual transforms are lowered into `transform` only as a stated maintainer decision, gated by a compat key counting full support only.
  verify: engine-legacy-2021; `scripts/build-prefixes.js` partial-support filter
- [XFORM-12] (MAJOR) Motion path and `will-change` pass through verbatim: `offset` order and resets, `offset-position: normal` ≠ `auto`, `offset-rotate: auto` ≠ `0deg`.
  verify: probe transform/sat-motion-offset-shorthand-passthrough; `dom:` stacking probe if typed
