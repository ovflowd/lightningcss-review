# prefixing-compat checklist (COMPAT)

`src/properties/prefix_handler.rs`, `src/targets.rs`, `scripts/build-prefixes.js` (B11 decides regeneration). Probes cannot set include/exclude or `targets: {}`: use Rust or node tests.

- [COMPAT-01] (BLOCKER) Authored declarations a target needs survive in both orders, with and without targets: FallbackHandler overwrites its slot with the prefix, PrefixHandler merges on equal value or overlapping prefix, handlers clearing legacy longhands (`-webkit-box-orient`, prefixed `display`) keep what the standard property does not replace.
  verify: `reverse-decls` (`prefixed-sibling` is one order only), `retarget-none`; probes prefixing-compat/*backdrop-filter*, flex-grid-align/webkit-box-orient-dropped-*, flex-grid-align/display-flex-before-*.
- [COMPAT-02] (MAJOR) An earlier fallback is pruned only if every target supports the later value: `is_compatible` inspects every inner value (no stub `true`, as `FilterList` has).
  verify: probes prefixing-compat/overflow-clip-author-fallback-kept, effects-masking/filter-fallback-kept, gradient-image/image-set-type-fallback-kept; `retarget-legacy`.
- [COMPAT-03] (MAJOR) Prefixing `Property::Unparsed` values (`var()`, CSS-wide keywords) adds no second prefixed copy on a second pass.
  verify: `var-after` with `retarget-legacy`; probes prefixing-compat/mask-image-var-duplicate, text/text-decoration-prefixed-inherit-idempotent.
- [COMPAT-04] (MAJOR) New or re-sourced compat data skips BCD `partial_implementation`/`prefix`/`alternative_name`/`flags` entries unless the lowering emits that form; a data refresh comes with a per-browser decision diff (thresholds moving down are unsafe); overrides say why.
  verify: diff `node scripts/build-prefixes.js` tables of base and head; probes color/lowering-rec2020-needs-fallback-for-safari14, prefixing-compat/user-select-webkit-prefix-safari-18.
- [COMPAT-05] (BLOCKER) Legacy prefixed syntax keeps its semantics in the compact printer: `-webkit-linear-gradient` keywords name the start side and 0deg points east, `-webkit-box-ordinal-group` is `order + 1`, `-webkit-mask-composite` keeps its own keywords.
  verify: compact lowering tests; probes gradient-image/prefixed-gradient-*, flex-grid-align/box-ordinal-group-offset-by-one; `engine-legacy-2023`.
- [COMPAT-06] (MAJOR) Every name and construct a lowering emits exists in each targeted engine, also those the oracle lacks (old Safari/iOS): MQ4 `not`/`or`, string URLs in `image-set()`, `at <position>` in `-webkit-radial-gradient()`, prefixed names per BCD and autoprefixer `lib/hacks`.
  verify: probes media-queries/range-lowering-mq3-compatible, gradient-image/image-set-url-kept-for-safari-13, prefixing-compat/print-color-adjust-*; `engine-legacy-2021`.
- [COMPAT-07] (MAJOR) Target modes stay distinct: none (nothing lowered, prefixes kept), `{}` (nothing lowered, authored prefixes stripped, selector compat runs), real targets; no-targets output changes are a maintainer decision.
  verify: `retarget-none`, `retarget-modern`; `Browsers::default()` in a prefix_test.
- [COMPAT-08] (MAJOR) Each `Features` flag gates only its transform (`should_compile(feature, flag)`, not `intersects()` on a group), new flags are appended so no bit moves, and including one flag alone emits valid output.
  verify: tests with `Targets { include, exclude }`; node/flags.js values base vs head; probe media-queries/range-lowering-parens.
- [COMPAT-09] (BLOCKER) Every `match` on `VendorPrefix` handles all bits: `include: VendorPrefixes` yields `VendorPrefix::all()`.
  verify: grep prefix matches for `unreachable!()`; a test with `include: VendorPrefixes`.
- [COMPAT-10] (BLOCKER) `@supports` keeps authored prefixes and operators: operands merged under a prefix-less key in `src/rules/supports.rs` must not drop a prefix, print `and` as `or`, or expand prefixes inside `not (…)`.
  verify: probes supports-container/supports-*prefixed*; `wrap-supports`.
- [COMPAT-11] (MAJOR) Prefixed pseudo aliases round-trip when nothing is lowered and gain no unprefixed copy that makes a dead selector live.
  verify: probes selectors/*placeholder*, selectors/prefixed-any-inside-not-preserved-without-targets.
- [COMPAT-12] (MAJOR) JS `browserslistToTargets` and Rust `from_browserslist` agree, and mobile keys (`opera_android`) do not overwrite desktop thresholds.
  verify: both on `defaults`, `android >= 95` at base and head; probes prefixing-compat/opera-desktop-*, prefixing-compat/android-webview-mask-prefix.
