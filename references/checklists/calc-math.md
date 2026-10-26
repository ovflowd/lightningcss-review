# calc-math checklist (CALC)
Covers `src/values/calc.rs` (parse, simplification, `reduce_args`, `to_css`) and the math paths of `percentage.rs`, `length.rs`, `number.rs` (`NumericRange`), angle and time. Spec: `references/spec/syntax-values.md` §4.

- [CALC-01] (BLOCKER) Simplification terminates: every recursive step shrinks the tree, including sums of parenthesized sums with unlike units, repeated terms and nested min/max/clamp (`Calc::add` and `Length::add` call each other).
  verify: R1 (stack overflow shows as SIGSEGV); probes calc-math/*sum*, calc-math/deep-calc-no-crash, calc-math/calc-repeated-clamp-no-overflow.
- [CALC-02] (BLOCKER) No `unreachable!()`, `unwrap()` or `expect()` on a calc result is reachable: every math function parses or errors in every slot type (number, percentage, alpha, color channel, length, angle, time).
  verify: probes calc-math/*panic*, calc-math/number-math-in-percentage-slot, calc-math/clamp-number-args; grep the diff.
- [CALC-03] (BLOCKER) A top-level calc() is unwrapped only when the result is inside the property's literal range; otherwise it is clamped as at computed time or kept, and nested math never clamps (V4#calc-range).
  verify: probes calc-math/negative-calc-*, calc-math/calc-negative-length-clamped, calc-math/out-of-range-calc-font-weight; a property whose initial value differs from the clamped result.
- [CALC-04] (BLOCKER) Basis-relative values (percentages; em, viewport, container units vs px) are never compared or folded at parse time in min/max/clamp/round/mod/rem/abs/sign (V4#calc-simplification).
  verify: probes calc-math/min-percentages-negative-basis, calc-math/clamp-percentages-negative-basis.
- [CALC-05] (BLOCKER) A zero-valued term is dropped from a Sum only when another term has its unit: `calc(10px + 0%)` keeps `0%`.
  verify: probes calc-math/zero-percent-term-height, calc-math/zero-percentage-dropped-from-calc (`height`, not `width`).
- [CALC-06] (MAJOR) clamp/min/max reduce only when every comparison is known; MIN wins in clamp (V4#comp-func).
  verify: probes calc-math/clamp-incomparable-max, calc-math/clamp-number-args.
- [CALC-07] (MAJOR) Type errors are not repaired into typed values (`calc(0 + 5px)`, `calc(.25 + 25%)` in `opacity`), so the earlier valid declaration survives; typed division folds only absolute same-dimension units (V4#calc-type-checking).
  verify: probes calc-math/unitless-zero-in-calc-keeps-fallback, calc-math/typed-division-passthrough; mutation duplicate-nonadjacent.
- [CALC-08] (MAJOR) Math containing `var()`, `env()` or unknown functions is not reordered or folded, and whitespace is dropped only around `*`, `/`, `,` in a grammar-aware path.
  verify: mutations var-before, var-after; probe custom-properties/adjacent-var-whitespace-preserved.
- [CALC-09] (MAJOR) Build-time evaluation keeps IEEE semantics: top-level NaN -> 0, inf clamps, `round/mod/rem(x, 0)` is NaN, and NaN/inf never print as a finite number like `3.40282e38` (V4#calc-ieee).
  verify: probes calc-math/mod-zero-step-nan, calc-math/nan-must-be-censored-to-zero (passes only via clamping); output-not-contains `e38`.
- [CALC-10] (MAJOR) round() `nearest` ties toward +inf and each strategy matches V4#typedef-rounding-strategy; mod() takes the sign of B, rem() of A.
  verify: probe calc-math/round-nearest-tie-upward.
- [CALC-11] (MAJOR) Parse cost stays linear in depth: no `try_parse` alternatives that re-parse the same nested arguments per level (`atan2` tries every argument type at each level).
  verify: depth-18 and depth-22 probes (`expect: no-panic`) timed on base and head.
- [CALC-12] (MAJOR) Unmodelled functions (`sibling-index()`, `progress()`, `random()`, `calc-size()`, `clamp(none, …)`, `round(line-width, …)`) pass through verbatim.
  verify: probes calc-math/sibling-index-passthrough, custom-properties/if-passthrough; O7 `unsupported-input` where the engine lacks them.
- [CALC-13] (MAJOR) Lowering is exact and gated on its own compat feature with the same targets in MinifyOptions and PrinterOptions; without lowering, legacy engines drop the declaration.
  verify: probe calc-math/clamp-lowering; mutations retarget-none, retarget-legacy, wrap-supports; O4.
