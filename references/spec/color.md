# Spec digest: color (CSS Color 4/5/6, Color Adjust 1, Color HDR 1)

Areas: `color` (`src/values/color.rs`, `src/values/alpha.rs`) and the color paths they drive in `ui-misc`
(`color-scheme`, `src/properties/ui.rs`), `custom-properties` (colors and `light-dark()` in token lists,
`src/properties/custom.rs`) and `prefixing-compat` (fallback ladder). Sources: research `spec-color` (master build +
headless Chrome 156), issue/PR records, the code. `file:line` at `cbeaf83` (`color.rs` = `src/values/color.rs`);
"verified" = seen on a master build; `#N` = LightningCSS, `Issue N` = w3c/csswg-drafts. Probe ids without a prefix
are `color/<slug>`. Checklist: `references/checklists/color.md`.

## 0. Specs read (drafts.csswg.org, 2026-10-25)

| Spec | Status | For |
|---|---|---|
| css-color-4 | ED 2026-10-20 (last CRD 2025-04-24, `#changes-from-20250424`) | `<color>`, `none`, powerless, interpolation, gamut mapping, serialization |
| css-color-5 | ED 2026-08-19 (WD 2026-06-05); `@color-profile`, custom spaces, `device-cmyk()`, `alpha()` at risk | `color-mix()`, relative colors (RCS), `alpha()`, `light-dark()`, `contrast-color()` |
| css-color-6 | ED 2026-10-08, "Not Ready For Implementation" | `contrast-color()` long form, `color-layers()` |
| css-color-adjust-1 | CR Snapshot 2026-05-07 (served at the ED URL) | `color-scheme`, `print-color-adjust`, `forced-color-adjust` |
| css-color-hdr-1 | ED 2026-10-08 | `dynamic-range-limit`, `color-hdr()`, ictcp/jzazbz/jzczhz, rec2100-* |
| css-values-5 §6 | ED 2026-09-04 | `#normalize-mix-percentages` (used by `color-mix()`) |

## 1. Known defects on master (verified)

Pre-existing: never count them against a PR; credit a PR that fixes one (`fixed`, A2).

| # | Input → master output | Where | Tracked | Probe |
|---|---|---|---|---|
| C1 | `light-dark(currentcolor, oklch(.5 .1 200))`, chrome 90 → **panic** (`color`/`fill` :585, `border-color` :517, `--x` :519) | `color.rs:511-521`, `:579-597` | no (new) | none yet |
| C2 | `rgb(none 0 0)` → `#000`; `--c:hsl(none 50% 50%)` → `#bf4040` (also in print mode) | `color.rs:701-705` | no | `gradient-rgb-none-not-zeroed`, `color/hsl-none-hue-lost-in-hsl-gradient` |
| C3 | `color-mix(in hsl, lch(none none 180), hsl(11 33 44))` → `#4b2d26` (WPT `#95594b`) | `color.rs:3534-3556` | #1368, PR #1376 | `color/color-mix-none-cross-space` |
| C4 | `color-mix(in oklch, oklch(.5 .2 120/0), oklch(.7 .1 240/0))` → `oklch(none none 180/0)` | `color.rs:3659-3666` | #1194 | `color/color-mix-polar-zero-alpha-not-none` |
| C5 | `color-mix(in srgb, red, blue)` → `purple`; `rgb(from red r g b)` → `red` | `rgb!` `color.rs:3193-3208` | no | `gradient-color-mix-result-is-not-legacy`, `gradient-rcs-result-is-not-legacy` |
| C6 | 54 of 834 WPT invalid values become colors: `color-mix(… 150% …)` (40), `calc(h + 1deg)` (4), `hsl(0, 50, 30%)`, `hsla(…, none)`, `rgb(255, 255, 255, none)` (8), `alpha(from red)` (2) | `color.rs:3413-3431`, `:1370-1489`, `:782-949`, `:1251-1287` | no | `mix-percent-over-100-stays-invalid`, `rcs-hue-keyword-is-a-number` |
| C7 | `color:red;color:foo` → `color:foo`; `color:red;color:device-cmyk(0 1 1 0)` → `device-cmyk` only | `prefix_handler.rs:124-156` | no | `rule-merging/invalid-color-replaces-valid`, `fallback-kept-before-device-cmyk` |
| C8 | `color:lab(50% 20 30);color:lab(60% -20 30)`, chrome 90 → second gets no fallback | `prefix_handler.rs:101-121` | no | `color/second-lab-declaration-gets-no-fallback` |
| C9 | `color-mix(in hsl, white, blue)` → `#8080ff` (WPT `color(srgb .625 .625 .875)`); `color-mix(in oklab, oklab(1.5 0 0), black)` → `oklab(75% 0 0)` (.5) | `color.rs:3670-3786`, `:1205`, `:1237` | no | `mix-*-not-powerless`, `mix-lightness-clamped-at-parse-time` |
| C10 | unclamped L converted: `oklch(1.2 .1 30)`, chrome 90 → final `lab(122.343% …)` (engines clamp L: ΔE_OK ≈ 0.007, `near`); `oklab(.5 0 -2)` → `lab(-2132.44% …)` (L → 0: another color) | `color.rs:579-597` | no | none (WPT lower lane, 15 cases) |
| C11 | `opacity:0.9999999` → `opacity:1` (stacking context lost) | number printing | no | `opacity-below-one-not-rounded-to-one` |
| C12 | `color-scheme: dark light` → `light dark` | `ui.rs:474-507` (bitflags) | no | `color-scheme-keyword-order-preserved` |
| C13 | light-dark lowering: `color-scheme:… !important` → non-important dark `@media` rule (N5); `light dark foo` → no toggles (#1152, 1.32.0); `@property initial-value` → `var()` (EM-36); toggles duplicated on merge (EM-132); dark rule dropped after a nested rule (#1049 cause) | `ui.rs:554-587`, `context.rs:89-153` | #1049 | `color/light-dark-color-scheme-custom-ident`, `custom-properties/light-dark-not-lowered-in-property-initial-value`, `ui-misc/color-scheme-lowering-idempotent` |
| C14 | `color(rec2020 …)`/`color(xyz …)`, safari 14 → no fallback | `build-prefixes.js:434`, `compat.rs:2386-2395` | no | `lowering-rec2020-needs-fallback-for-safari14` |
| C15 | `hsl(calc(infinity) 100% 50%)` → `#000` (spec: red); `calc(NaN)` component → `none`; `lab(calc(infinity) 0 0)` → `lab(3.40282e38% 0 0)`, re-minified `lab(2147483647% 0 0)` | `color.rs:2800-2805`, `:1205`; `percentage.rs:58` | #1093 (debug panic) | `infinite-hue-normalizes-to-zero`, `calc-nan-component-is-zero-not-none` |
| C16 | `lab(50% 20 30)` with `opera 90` → no fallback (Opera Android numbering, N7); inside anonymous `@layer {}` → no fallback (N6) | `build-prefixes.js:449-450`; `rules/mod.rs:716-741`, `:986-1044` | no | `prefixing-compat/opera-desktop-lab-fallback`, `cascade-layers-scope/anonymous-layer-contents-lowered` |

C1: `get_necessary_fallbacks` is non-empty for the LightDark, then `to_rgb()/to_lab()` recurse into the
unconvertible arm and `.unwrap()` fails (`box-shadow` survives via `unwrap_or_else` but prints itself twice; #1311 is
the gradient sibling). C6 corrects research INV-029 ("legacy syntax passes through"), true only for mixed rgb() and
comma hwb(). Fixed on master since v1.33.0 (unreleased): #1323 (gamut mapping), #1343 (RCS omitted alpha), #1329.

## 2. Grammar essentials

```
<color> = <color-base> | currentColor | <system-color> | <contrast-color()> | <device-cmyk()> | <light-dark-color>
<color-base> = <hex-color> | <color-function> | <named-color> | <color-mix()> | transparent
modern  rgb([from <color>]? [<number>|<percentage>|none]{3} [/ [<alpha-value>|none]]?)
        hsl()/hwb(): [from]? [<hue>|none] [<percentage>|<number>|none]{2} [/ …]?
legacy  rgb(<percentage>#{3}, <alpha-value>?) | rgb(<number>#{3}, <alpha-value>?)
        hsl(<hue>, <percentage>, <percentage>, <alpha-value>?)      rgba()/hsla() identical; no none, no `from`;
        no comma form for hwb/lab/lch/oklab/oklch/color
lab()/oklab() [from]? [<percentage>|<number>|none]{3} [/ …]?     lch()/oklch() [from]? […]{2} [<hue>|none] [/ …]?
color([from <color>]? <colorspace-params> [/ [<alpha-value>|none]]?)
  <predefined-rgb> = srgb | srgb-linear | display-p3 | display-p3-linear | a98-rgb | prophoto-rgb | rec2020
  <xyz-space> = xyz | xyz-d50 | xyz-d65      <custom-params> = <dashed-ident> [<number>|<percentage>|none]+
alpha(from <color> / [<alpha-value> | none])                          the `/ …` part is required
color-mix(<color-interpolation-method>?, [<color> && <percentage [0,100]>?]#)   1..N colors, default `in oklab`
<color-interpolation-method> = in [<rectangular-color-space> | <polar-color-space> <hue-interpolation-method>? | <custom-color-space>]
<rectangular-color-space> = srgb | srgb-linear | display-p3 | display-p3-linear | a98-rgb | prophoto-rgb | rec2020 | lab | oklab | <xyz-space>
<polar-color-space> = hsl | hwb | lch | oklch   <hue-interpolation-method> = [shorter | longer | increasing | decreasing] hue
light-dark(<color>, <color>) | light-dark([<image>|none], [<image>|none])        contrast-color(<color>)
device-cmyk(<number>#{4}) | device-cmyk([<number>|<percentage>|none]{4} [/ …]?)
```

Hex 3/4/6/8 digits, case-insensitive (#hex-notation). 148 named colors + `transparent`. System colors
(#css-system-colors): 19 current, 23 deprecated ones compute to a mapped one. Quirky hex (`color: ff0000`) is
quirks-mode only, 7 longhands, never shorthands or functions (#quirky-color; request #1006).

| form | 100% = | parse-time clamping | powerless hue when (conversion only) |
|---|---|---|---|
| rgb() | 255 (alpha 1) | r,g,b [0,255] in both syntaxes; alpha [0,1] | - |
| hsl() | S,L 100 | only S<0 → 0; L, S>100 not clamped | S ≤ 0.001 |
| hwb() | W,B 100 | none (W+B ≥ 100 → gray) | W+B ≥ 99.999 |
| lab()/lch() | L 100; a,b 125; C 150 | L [0,100]; C<0 → 0 | lch: C ≤ 0.0015 |
| oklab()/oklch() | L 1; a,b 0.4; C 0.4 | L [0,1]; C<0 → 0 | oklch: C ≤ 0.000004 |
| color() predefined | 1 | none (gamut mapped at actual-value time) | - |
| relative color | as the function | channels not clamped; alpha clamped | - |

Properties: `opacity: <number>|<percentage>` keeps out-of-range specified values (computed clamps to [0,1]),
percentages serialize as numbers, < 1 creates a stacking context (#transparency). `color-scheme: normal | [light |
dark | <custom-ident>]+ && only?`: ordered, repeats allowed, `only` first or last (#color-scheme-prop).
`print-color-adjust: economy | exact` (alias `-webkit-print-color-adjust`; Firefox < 97 used `color-adjust`).
`forced-color-adjust`, `dynamic-range-limit`, `@color-profile` (last rule with a name wins): pass-through only.

Algorithms (css-color-4 unless noted):
- `#missing`: missing = 0 for rendering and conversion; serialized as `none` except in legacy forms. `#powerless`:
  only produced by conversion; a hue made missing forces chroma/saturation to 0 (Issue 14133). Conversion results
  are not clamped (`#color-convert-algorithm`); gamut mapping happens only for physical output.
- `#interpolation`: carry forward missing analogous components and sets (Issue 10210), powerless → missing only if
  converting, convert, re-insert, fill missing from the other color, hue fix-up (#hue-interpolation), premultiply
  (polar: not hue), interpolate, un-premultiply (skip at alpha 0/none). Default Oklab, shorter hue; all-legacy sRGB
  colors (hex, named, rgb(), hsl(), hwb()) interpolate in gamma-encoded sRGB (#interpolation-space, Issue 7949).
- `color-mix()` (css-color-5 #color-mix-result, css-values-5 #normalize-mix-percentages): omitted percentages share
  the remainder; sum > 100% scales down; sum < 100% scales up and the sum becomes an alpha multiplier; all 0% → 50/50
  at alpha 0; 1 color = itself in the mixing space; N colors fold left to right.
- RCS (css-color-5 #rcs-intro, #relative-syntax): processing space = the function's (origin's for `alpha()`);
  channel keywords are `<number>`; omitted alpha = origin alpha; channels not clamped; missing components carried
  forward; `calc()` on `none` treats it as 0.
- `#serializing-color-values`: modern alpha ≥ 16-bit, legacy 8-bit; `rgb()` with `none` → `color(srgb …)`,
  `hsl()/hwb()` with `none` keep their modern form (Issue 10254); color-mix()/RCS results serialize in the mixing
  space (`color(srgb …)` for srgb/hsl/hwb); with currentcolor inside → declared form (css-color-5 #serial-color-mix).

## 3. Invariants (ids from research `spec-color`; F = master fails the probe, P = passes)

- **INV-COLOR-001 `none` is not 0.** Missing = 0 only for direct rendering; interpolation takes the other color's
  value (#missing, #interpolation-missing). `gradient-rgb-none-not-zeroed` F (31/255 px), `oklch-none-preserved` P.
- **INV-COLOR-002 Legacy vs non-legacy form selects the interpolation space.** Any non-legacy color (color(),
  lab()…oklch(), color-mix()/RCS/alpha() results) in a gradient or transition → Oklab; all legacy → sRGB
  (#interpolation-space). `gradient-color-mix-result-is-not-legacy` F (20/255), `gradient-rcs-result-is-not-legacy`
  F (44/255), `gradient-color-srgb-stop-stays-non-legacy` P, `gradient-legacy-stops-stay-legacy` P.
- **INV-COLOR-003 color-mix()/RCS results keep out-of-gamut values** (css-color-5 #rcs-intro; WPT
  color-mix-out-of-gamut 18/18 everywhere): no gamut mapping of operands or origin, no 8-bit storage.
  `mix-out-of-gamut-not-mapped-before-mixing` F, `rcs-origin-not-gamut-mapped` F.
- **INV-COLOR-004 Invalid stays invalid.** color-mix `<percentage [0,100]>` is a parse-time range; hue methods are
  only shorter|longer|increasing|decreasing (#typedef-hue-interpolation-method); RCS keywords are `<number>`.
  Evaluating an invalid function kills the author's fallback. `mix-percent-over-100-stays-invalid`,
  `mix-negative-percent-stays-invalid`, `hue-method-specified-is-invalid`, `rcs-hue-keyword-is-a-number`: all F (WPT
  invalid files pass 141/141 and 161/161 in all engines). Legacy-syntax cases: C6.
- **INV-COLOR-005 Current powerless rules**: hues only (thresholds §2), only on conversion, chroma/saturation then 0;
  Lab/Oklab have none; L = 0/100% makes nothing powerless (#powerless). `mix-hsl-white-saturation-not-powerless`,
  `mix-oklch-black-chroma-not-powerless`, `mix-oklab-black-ab-not-powerless`: F (`color.rs:3670-3786` = old rules).
- **INV-COLOR-006 Same-space operands are not converted**: in `color-mix(in hsl, hsl(0 100% 100%), blue)` the operand
  keeps hue 0 / S 100. Broken by hsl()/hwb() → 8-bit RGBA at parse time (`color.rs:1138-1157`).
  `mix-hsl-keeps-hsl-identity` F. Gradient stops compute to sRGB, so hsl → hex inside `linear-gradient(in hsl, …)` is
  safe (pixel-identical).
- **INV-COLOR-007 Analogous components and sets carry forward** (#analogous-components): `lab(50% none none)` →
  `lch(50% none none)`, `rgb(none none none / 50%)` → `oklab(none none none / 50%)`.
  `mix-cross-space-none-carried-forward` F (#1368), `color/color-mix-analogous-set`.
- **INV-COLOR-008 Hue fix-up**: `longer` with Δ = 0 adds 360 (WPT `color-mix(in oklch longer hue, red, white)` → hue
  209.23); normalize to [0,360) first (#hue-longer). `mix-longer-hue-equal-hues-full-turn` F (`color.rs:3807-3813`).
- **INV-COLOR-009 Premultiplication**: before mixing (not hue in polar), with carried-forward alpha; skip
  un-premultiply at alpha 0/none (#interpolation-alpha). C4 probe F (#1194);
  `color-mix(in srgb, transparent, blue)` = blue at alpha .5 (master correct).
- **INV-COLOR-010 Mix percentage normalization** (§2): `30%, 30%` is not an opaque 50/50 mix; `0%, 0%` is valid.
  Master: 2 colors only, alpha multiplier correct (`30%,30%` → `#80008099`), `0%,0%` → unparsed (safe).
- **INV-COLOR-011 Parse-time clamping before computation** (alpha, L, C, hsl S, rgb; not color(), HSL L, HWB, XYZ,
  RCS channels; #specifying-lab-lch, #specifying-oklab-oklch, #the-hsl-notation, #rgb-functions).
  `mix-lightness-clamped-at-parse-time` F (`color.rs:1205,1237` clamp only at 0). Printing `lab(150% 20 30)` unchanged
  is fine; converting the unclamped value is not (C10).
- **INV-COLOR-012 calc() special values**: infinite hue → 0deg, `calc(NaN)` → 0 (never `none`), sRGB ±∞/NaN →
  255/0/0 (#hue-syntax, #resolving-sRGB-values; WPT `oklch(.5 .1 calc(NaN))` → `oklch(.5 .1 0)`).
  `infinite-hue-normalizes-to-zero` F, `calc-nan-component-is-zero-not-none` F.
- **INV-COLOR-013 currentcolor computes to itself and inherits as a keyword**; color-mix()/RCS/contrast-color() with
  it compute to the function (#resolving-other-colors, css-color-5 #resolving-mix, #resolving-rcs).
  `currentcolor-inherits-as-keyword` P, `color-mix-currentcolor-not-precomputed` P.
- **INV-COLOR-014 System colors, light-dark(), contrast-color() depend on scheme/forced colors**: never resolved at
  build time, except `light-dark(x, x)` → `x` (#css-system-colors, #light-dark, #contrast-color).
  `system-colors-not-precomputed` P, `light-dark-equal-arms-collapse` P (fixed-by #1183).
- **INV-COLOR-015 light-dark() is evaluated where it is used**, by the element's used color scheme (#light-dark,
  css-color-adjust-1 #color-scheme-resolution; `prefers-color-scheme` reports the page scheme): in an unregistered
  custom property it is tokens resolved on the substituting element, so definition-site lowering is not equivalent.
  `light-dark-lowering-in-custom-property` F (#821), `light-dark-lowering-without-color-scheme` F (documented
  requirement; #1196 closed), `light-dark-lowering-with-color-scheme` P.
- **INV-COLOR-016 color-scheme is an ordered list**: `dark light` ≠ `light dark` (computed value); custom idents
  kept; duplicates may drop (CSSOM); `only` may move (#color-scheme-prop). `color-scheme-keyword-order-preserved` F.
- **INV-COLOR-017 Earlier declarations are fallbacks for unsupported later values**: UAs ignore what they cannot
  parse, so `color: red; color: <newer syntax>` keeps `red` unless every target supports the later value; only
  var()/env() values are always parse-valid. Not universal: `device-cmyk()`, variadic/1-arg/method-less
  `color-mix()`, `contrast-color()`, `display-p3-linear`. `fallback-kept-before-device-cmyk` F,
  `fallback-kept-before-variadic-color-mix` F (Chrome).
- **INV-COLOR-018 Hex shortening**: `#rrggbbaa` → `#rgba` only if every pair repeats; 4/8-digit hex needs
  HexAlphaColors in the targets (#hex-notation). `hex-alpha-shortening` P.
- **INV-COLOR-019 Serialized precision** (#predefined-precision-table: srgb/p3/a98 10 bits, linear spaces/prophoto/
  rec2020 12, xyz 16; modern alpha 16): non-legacy → hex loses precision. Legacy alpha at 1/255 (`rgb(255 0 0 /
  .123)` → `#ff00001f`) reads back as 0.12 in all engines: accepted.
- **INV-COLOR-020 opacity < 1 is not 1** (stacking context, #transparency). `opacity-below-one-not-rounded-to-one` F
  (255/255 px). Out-of-range (1.5) may be kept or clamped.
- **INV-COLOR-021 Fully transparent colors are not interchangeable**: polar hue is not premultiplied and
  `transparent` has a missing hue after conversion (#interpolation-alpha), so `rgb(255 0 0 / 0)` ≠ `transparent`.
  `transparent-colors-keep-hue-in-polar-gradients` P (master keeps `#f000`).
- **INV-COLOR-022 CSSOM-visible spellings**: named/hex/rgb rewrites show only in declared values (style attribute,
  CSSOM, custom properties), not computed ones (#serializing-sRGB-values).
- **INV-COLOR-023 Gamut-mapped fallbacks are approximations with fixed endpoints** (#css-gamut-mapping: binary
  search with local MINDE, ΔE_OK, JND 0.02, ε 0.0001, or EdgeSeeker/Ray Trace): OkLCh L ≥ 1 → white, L ≤ 0 → black
  (`lch(100% 110 60)` → `#fff` conforms; #1162 asks to deviate); in-gamut colors unchanged. Never write
  `output-equals` for a gamut-mapped hex.
- **INV-COLOR-024 Partial compat data is not support**: Safari 10.1–14.x support only `color(display-p3|srgb)`.
  `lowering-rec2020-needs-fallback-for-safari14` F (output-contains).
- **INV-COLOR-025 The branch modern engines take keeps the authored semantics** (final declaration or `@supports`
  copy): missing components and polar hue survive (#missing). `lowering-unparsed-gradient-keeps-none` F (231/255 px:
  the `@supports (color: lab(0% 0 0))` copy has lab() stops), `lowering-color-function-final-decl-unchanged` P.
- **INV-COLOR-026 rec2020 transfer changed** to pure gamma 2.4 (Issue 12574); all three engines still use the BT.2020
  OETF (WPT rec2020 RCS subtests fail everywhere). Switching `color.rs:2660-2757` moves every rec2020 fallback
  (ΔE_OK ≈ 0.06, ≤ 0.12) away from shipping engines: maintainer decision.
- **INV-COLOR-027 Quirky hex is quirks-mode only** (#quirky-color).
- **INV-COLOR-028 Pure spellings are safe**: `xyz-d65` ↔ `xyz`, `oklab(50% 25% 25%)` ↔ `oklab(.5 .1 .1)`.
- **INV-COLOR-029 Legacy syntax rules**: comma syntax only for rgb()/rgba()/hsl()/hsla(); rgb all numbers or all
  percentages; hsl S/L percentages; no `none`; RCS modern only (#color-syntax-legacy). Master keeps `rgb(255, 0%, 0)`
  and `hwb(120, 0%, 0%)` (safe) but resolves the hsl and `none` cases (C6).

## 4. LightningCSS conformance map (master `cbeaf83`)

typed = Rust value; unparsed = tokens. Inside token lists, rgb/rgba/hsl/hsla/hwb/lab/lch/oklab/oklch/color/
color-mix/light-dark/alpha functions and hash tokens are still re-parsed and re-printed (`try_parse_color_token`,
`custom.rs:467-481`).

| item | status | where | deviations beyond §1 |
|---|---|---|---|
| `CssColor` | typed: CurrentColor, RGBA(u8), LAB(f32), Predefined, Float (rgb/hsl/hwb with `none`), LightDark, System | parse `color.rs:606-631`, print `:633-726` | - |
| hex / named / transparent | typed RGBA | `:611-619`; print `:640-694`; names `:742-780` | without HexAlphaColors: `#rrggbbaa` → `rgba()` 2–3 decimals, all-zero → `transparent` (minify only), decided with printer targets (`:654-680`) |
| rgb()/hsl()/hwb() | typed → RGBA u8 unless `none` | `:1138-1157`, `parse_rgb` `:1412-1489` | rounded/clamped (`:1474-1475`: `rgb(127.5 0 0)` → `maroon`); hsl S/L clamped [0,100] (`:1400,1404`) |
| lab/lch/oklab/oklch | typed f32 | `:1194-1246` | `none` kept; L printed as % |
| color() | typed: srgb, srgb-linear, display-p3, a98-rgb, prophoto-rgb, rec2020, xyz(-d50/-d65) | `:1290-1365`, print `:1587-1620` | display-p3-linear missing (#1161); custom/rec2100 → unparsed (`:1337-1339`); `xyz-d65` printed `xyz` |
| conversions | f32 | `:2001-2010` polar, `:2759-2831` sRGB → HSL/HWB | no ε/chroma → 0 (Issue 14133): `oklch(from white l c h)` → `oklch(100% 5.96046e-8 90)`; sRGB → HSL/HWB gamut maps first |
| color-mix() | partial | `parse_color_mix` `:3393-3454`, `interpolate` `:3494-3579` | requires `in` and exactly 2 colors (#1224); spaces display-p3(-linear)/a98/prophoto/rec2020/custom → unparsed (`ColorSpaceName` `:250-263`); `specified` accepted (`:278`); operands gamut-mapped (`:3537-3543`); `0%+0%` → unparsed |
| relative colors, alpha() | partial | `parse_relative` `:972-1018`, `RelativeComponentParser` `:782-949`, alpha() `:1251-1287` (#1266), `with_alpha` `:359-405` | origin `resolve()` = none → 0 + gamut map (`:1011-1013`); rgb results rounded to [0,255]; alpha() over RGBA prints hex (8-bit alpha), `/ none` → 0; currentcolor/var()/system origins → unparsed |
| light-dark() | typed | `:1167-1185`, print `:707-725`; tokens: `UnresolvedColor::LightDark` `custom.rs:1460-1625` | `light-dark(x,x)` → x at parse time (structural equality, #1183); lowered to `var(--lightningcss-light, a) var(--lightningcss-dark, b)` (LightDark C123/F120/S17.5, `compat.rs:3442-3480`); distributes over color-mix/RCS (`:1003-1009`, `:3518-3527`) |
| gamut mapping | typed | `map_gamut` `:3325-3391` (#1323) | per #pseudo-binsearch; separate `LIGHTNESS_EPSILON` 1e-5 for white/black cut-offs (`:3331-3350`) |
| fallback ladder | | `get_possible_fallbacks` `:437-500`, `get_fallback` `:511-521`, `FallbackValues` `:579-597` | RGB → P3 → LAB; P3 dropped unless some target supports it; oklab/oklch → lab() as final when OklabColors must compile (`:592-594`); `.unwrap()` on conversions |
| FallbackHandler (color, fill, stroke, caret-color, caret, text-shadow, filter, backdrop-filter) | | `prefix_handler.rs:79-181` | fallbacks only for the first occurrence (`:101`); later compatible values overwrite in place (`:116-121`); Unparsed always overwrites (`:148`) |
| custom properties / unparsed | `@supports` side rules | `custom.rs:1052-1088`, `context.rs:158-226` | lowest fallback replaces the value; P3/LAB copies only in `DeclarationContext::StyleRule`; drained only by the `CssRule::Style` arm (`rules/mod.rs:822-841`) |
| opacity, fill-/stroke-opacity | typed `AlphaValue` | `alpha.rs` | % → number; out-of-range kept |
| color-scheme | partial | `ui.rs:433-507`, handler `:554-587` | custom idents/CSS-wide → unparsed (no toggles); lone `only` accepted |
| print-color-adjust | typed, PrefixHandler | `ui.rs:589-597` | `-webkit-` for Safari ≤ 15.2 (15.3 none) / Chrome ≤ 135; invents `-moz-print-color-adjust` for Firefox 48–96 (probe `prefixing-compat/print-color-adjust-no-moz-prefix`) |
| contrast-color(), device-cmyk(), color-layers(), HDR, `@color-profile`, forced-color-adjust, dynamic-range-limit, color-adjust | unparsed / unknown at-rule | - | passed through; an author fallback before them is deleted (INV-017) |
| gradients with `in <space>` | unparsed (#1272) | `gradient.rs` | colors inside still minified and lowered |

## 5. Engine divergences that affect the oracle

wpt.fyi stable runs 2026-10-24/25, subtests passed (Chrome 156.0.8078.47 / Firefox 158.0.1 / Safari 27.0):

| test (css/css-color/…) | Chrome | Firefox | Safari |
|---|---|---|---|
| parsing/color-computed-color-mix-function | 935/974 | 906/974 | 962/974 |
| parsing/color-computed-relative-color | 1077/1170 | 1077/1170 | 1081/1170 |
| parsing/color-computed-none | 245/678 | 291/678 | 410/678 |
| parsing/color-computed-powerless | 240/570 | 358/570 | 386/570 |
| parsing/alpha-color-computed | 16/33 | 31/33 | 8/33 |
| parsing/relative-color-out-of-gamut | 12/27 | 27/27 | 27/27 |
| parsing/color-invalid-color-mix-function, -relative-color | 141/141, 161/161 | same | same |
| css-images/…/gradient-none-interpolation | PASS | FAIL | FAIL |
| RCS rec2020↔srgb subtests (gamma 2.4) | FAIL | FAIL | FAIL |

- `none` in gradients is interpolated per spec only by Chromium: a `none` → 0 change is a pixel diff (O6) there and
  invisible elsewhere. Only WebKit serializes `none` in legacy forms (`color(srgb none 0 0)`, `hsl(none 50% 50%)`),
  so oracle reason `missing-component-changed` comes from WebKit.
- The newest none/powerless/analogous-set rules are partly implemented, so engines split (O9): decide by the ED and
  WPT (references/oracle.md: Firefox treats cross-space `none` as 0 in #1376's cases).
- `color-mix()` results differ in the 4th digit between engines: compare within one engine. System colors are
  engine-specific. Legacy alpha is 8-bit everywhere (`0.123` → `0.12`).
- Chromium 156: `alpha(from red / .5)` computes to legacy `rgba(255, 0, 0, 0.5)`; variadic and 1-argument
  `color-mix()` invalid (Firefox ≥ 150, Safari 27 accept them); `color-scheme: only light` → `light only`.
- BCD: alpha() C152/F155/S27; display-p3-linear C144/F146/S26.2; contrast-color C147/F146/S26; light-dark() image
  form C150/F150/S27; RCS from currentcolor C131/F133/S18; color() full C111/F113/S15; print-color-adjust C136/F97/S15.4.
- Harness legacy engines: legacy-2023 (Chromium 110, Firefox 108, WebKit 16.4): no Color 4 in Chromium/Firefox, no
  light-dark(); WebKit 16.4 has lab/oklch/color-mix. legacy-2021 (Chromium 97, Firefox 93, WebKit 15.4): no
  color-mix(); lab()/color() only in WebKit.
- The harness WPT lane extracts only `test_valid_value`/`test_invalid_value`/`test_shorthand_value`
  (`oracle/wpt/extract.mjs:15-19`), not `fuzzy_test_computed_color` (~2,400 call sites): static color-mix()/RCS evaluation
  is checked only by probes and mutations through the browser oracle.

## 6. Lowering semantics (what an exact fallback must preserve)

1. Gamut: anything outside sRGB is lossy in an RGB fallback; P3 is emitted only when some target supports it
   (`color.rs:484-497`); the authored value stays last for modern engines. oklab/oklch → lab() is the same color only
   for in-range input (C10) and loses `none`/polar semantics (INV-025).
2. Acceptable in fallbacks only, never in the final declaration: 8-bit precision, lost `none`, sRGB interpolation
   of legacy stops in old engines. rec2020 fallbacks use the BT.2020 OETF (as engines do).
3. `light-dark()`: `--lightningcss-light: initial; --lightningcss-dark: ;` toggles where `color-scheme` is declared,
   plus `@media (prefers-color-scheme: dark)` for `light dark` (`ui.rs:564-578`). Exact only if (a) a CSS
   `color-scheme` declaration covers the element (not `<meta name=color-scheme>`, website/pages/transpilation.md:336),
   (b) it is not inside a custom property defined on an ancestor with another scheme (#821, #873), (c)
   `prefers-color-scheme` equals the user preference, (d) no `only`/forced-colors semantics are needed. Toggles are
   emitted even with no `light-dark()` in the file. `Features.LightDark` can be excluded.
4. `#rrggbbaa` → `rgba()` 2–3 decimals (exact at 8 bits); space-separated `rgb()/hsl()` with `var()` alpha →
   `rgba()/hsla()` (#178); `#0000` → `transparent`.
5. No fallback (passed through): color-mix()/RCS/contrast-color() with var(), currentcolor or system colors;
   display-p3-linear, device-cmyk(), custom spaces, HDR.
6. Inside `@supports (color: lab(…))` no fallbacks are generated (`TargetsWithSupportsScope`, #878, d398c1b).

Safe minifications: hex lowercasing/shortening; named ↔ hex for legacy colors; legacy rgb()/hsl()/hwb() → hex;
`transparent` ↔ `#0000`; percent → number spellings; `xyz-d65` ↔ `xyz`; dropping `/ 1`; `light-dark(x, x)` → `x`;
omitting the default `currentcolor` in shadows; dropping repeated color-scheme keywords. Unsafe: INV-001..007, 011,
012, 016, 017, 020, 021, 025.

## 7. Spec changes since 2023 that LightningCSS lags

csswg-drafts issue numbers in parentheses; `#N` = LightningCSS.
- css-color-4: display-p3-linear (11250; #1161); rec2020 gamma 2.4 (12574); all-legacy colors interpolate in sRGB
  (7949); analogous sets (10210); chroma → 0 for powerless hues with an ε table (14133); unclamped conversion
  intermediates (9484); 16-bit modern alpha (13994); sRGB serialization form chosen by `none` (10254).
- css-color-5: color-mix() method optional (default oklab, 10484), 1..N colors, 0%-sum and 100% rules (14014, 14013,
  13320): #1224; alpha() (10689; #1266); light-dark() image form and `none` (12513, 13897); RCS processing space and
  serialization (13394, 13392, 13992); contrast-color() simplified to white/black (2024; PRs #808, #1160 open).
- css-color-adjust-1: page vs element color scheme (13857, 13377, 7213); forced colors on all `<color>` components
  (11857). css-color-hdr-1: dynamic-range-limit (11698, 11694), color-hdr() (11616). css-color-6: not ready.
