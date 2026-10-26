# Checklist: box-model-size (prefix BOX)
SizeHandler (`src/properties/size.rs`), `side_handler!` (`margin_padding.rs`: margin, padding, scroll-*, inset), unitless lengths (`src/values/length.rs`), box-sizing. Spec: `spec/layout.md` §Sizing. FAIL only when head introduces or widens a violation.

- [BOX-01] (BLOCKER) A typed size, side or inset value keeps source order against an Unparsed one (`var()`, unknown function) of the same property in both orders: the handler flushes before it pushes the Unparsed declaration.
  verify: var-before, var-after, reverse-decls; `box-model-size/*order*`; read every new `handle_property` arm for a flush before an immediate push.
- [BOX-02] (MAJOR) Unknown aliases (`-webkit-margin-start`, `-webkit-padding-start`, `-webkit-logical-width`/`-height`, sizing-4 `size`) are pushed at once, so the buffered standard property prints after them; the later declaration must stay last. Chromium/WebKit alias these names, Firefox does not (O9 split).
  verify: probe `margin-inline-start:10px;-webkit-margin-start:20px`; reverse-decls.
- [BOX-03] (BLOCKER) An earlier declaration is dropped only when the later one is typed and compatible with every target; an Unparsed or newer later value (calc-size(), anchor-size(), stretch(), a new unit) keeps it as fallback, and `100vh` before `100dvh` survives for every target lacking the unit (desktop Opera included).
  verify: duplicate-nonadjacent, retarget-legacy; `box-model-size/*fallback*`; https://drafts.csswg.org/css-sizing-4/#sizing-values.
- [BOX-04] (MAJOR) Sizing-keyword ladders with targets: `stretch` gets `-webkit-fill-available` and `-moz-available`, `fit-content` gets `-moz-fit-content`, and a fallback before `contain` survives. No targets = collapse by design.
  verify: retarget-none, retarget-modern, retarget-legacy (Firefox rejects `width:stretch` but accepts both prefixed forms).
- [BOX-05] (BLOCKER) Every `VendorPrefix` arm of `Size`/`MaxSize::to_css` and `SizeFallback` is handled: `include: VendorPrefixes` makes `targets.prefixes()` return all four prefixes, so `-o-`/`-ms-` reach code that assumes webkit/moz.
  verify: a Rust test with `Features::VendorPrefixes` on `height:stretch` (probes cannot set `include`); grep the diff for `unreachable!()`/`unwrap()`.
- [BOX-06] (MAJOR) Invalid stays invalid and never replaces an earlier valid value: unitless non-zero numbers in standards mode (`width:3`), `%`/`auto` in `scroll-margin` (`<length>` only), negative literals in non-negative properties.
  verify: `P:valid;P:invalid` probes (the one-declaration WPT lane cannot see this); `values-numeric/unitless-*`, `box-model-size/scroll-margin-*`; https://drafts.csswg.org/css-scroll-snap-1/#propdef-scroll-margin.
- [BOX-07] (MAJOR) A resolvable negative calc() in a non-negative property clamps (never prints a negative literal), an unresolvable one stays calc(), and a `0%` term stays in calc() where the percentage basis can be indefinite (height, flex-basis).
  verify: `calc-math/negative-calc-*`, `calc-math/zero-percentage-dropped-from-calc`; https://drafts.csswg.org/css-values-4/#calc-range.
- [BOX-08] (MAJOR) Sides fold into margin/padding/scroll-*/inset only when all four are set, of one importance, not CSS-wide keywords and not mixed with `var()`; `inset` (and logical shorthands) only when every target supports that shorthand, not just the logical longhands.
  verify: important, var-before, upper-props; `box-model-size/inset-not-merged-for-old-targets` (legacy engines all support `inset`: assert output).
- [BOX-09] (MAJOR) `box-sizing` (PrefixHandler) keeps cascade order around `var()`: no write-back of a later value into the first slot, and differing author-prefixed values survive.
  verify: `rule-merging/prefix-handler-in-place-update-reorders-unparsed`; var-before, var-after, prefixed-sibling.
- [BOX-10] (MAJOR) Logical sizes and sides lower only through `should_compile_logical`, keep `!important`, and stay overridden by a later physical declaration.
  verify: `logical/physical-after-logical-wins`, `logical/important-*`; important with targets; `logical.md`.
- [BOX-11] (MINOR) Newer values pass through byte-equivalent (stretch(), fit-content(), calc-size(), anchor-size(), `contain-intrinsic-size: auto <length>`, degenerate `aspect-ratio`); a PR typing one accepts every engine-valid form and enforces `[0,∞]`.
  verify: minify round trips; O3; https://drafts.csswg.org/css-sizing-4/#propdef-contain-intrinsic-size.
