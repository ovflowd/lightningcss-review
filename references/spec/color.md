# Spec digest: color (CSS Color 4/5, Color Adjust 1)

Covers `color` and the color paths of `ui-misc` (`color-scheme`), `custom-properties` (token lists) and
`prefixing-compat` (fallback ladder). Anchors are css-color-4 unless noted. Checklist: `checklists/color.md`.

## Grammar that decides correctness

```
modern  rgb()/hsl()/hwb()/lab()/lch()/oklab()/oklch()/color(): [from <color>]? <3 channels|none> [/ <alpha>|none]?
legacy  rgb(<number>#{3}|<percentage>#{3}, <alpha>?)  hsl(<hue>, <percentage>, <percentage>, <alpha>?)
        rgba()/hsla() same; no none, no `from`; no comma form for other functions
alpha(from <color> / [<alpha-value> | none])          the `/ …` part is required
color-mix(<color-interpolation-method>?, [<color> && <percentage [0,100]>?]#)    1..N colors, default in oklab
```

| form | parse-time clamping | powerless hue when (conversion only) |
|---|---|---|
| rgb() | r,g,b [0,255]; alpha [0,1] | - |
| hsl() | only S<0 → 0 | S ≤ 0.001 |
| hwb() | none | W+B ≥ 99.999 |
| lab()/lch() | L [0,100]; C<0 → 0 | lch: C ≤ 0.0015 |
| oklab()/oklch() | L [0,1]; C<0 → 0 | oklch: C ≤ 0.000004 |
| color(), relative-color channels | none (alpha clamped) | - |

## Rules a minifier or lowering can break

- **`none` is not 0** (#missing, #interpolation-missing): 0 only for rendering/conversion; interpolation takes
  the other color's value. Kept in modern forms; `rgb()` with `none` serializes as `color(srgb …)`.
- **Legacy form selects the interpolation space** (#interpolation-space): all-legacy colors (hex, named, rgb(),
  hsl(), hwb()) interpolate in gamma sRGB, any other in Oklab. color-mix(), relative-color and alpha() results
  are non-legacy (`color(srgb …)` for srgb/hsl/hwb).
- **Powerless** (#powerless): hue only, only on conversion; Lab/Oklab have none; L 0/100% makes nothing
  powerless; a hue made missing forces chroma/saturation to 0.
- **No clamping or gamut mapping of intermediates** (#color-convert-algorithm, css-color-5 #rcs-intro): mix
  operands and relative-color origins keep out-of-gamut values and full precision.
- **Interpolation** (#interpolation): carry forward missing analogous components and sets
  (#analogous-components: `rgb(none none none / 50%)` → `oklab(none none none / 50%)`); operands already in the
  mixing space are not converted; hue fix-up normalizes to [0,360), `longer` with Δ = 0 adds 360
  (#hue-interpolation); premultiply except polar hue, skip un-premultiply at alpha 0 (#interpolation-alpha).
- **Mix percentages** (css-values-5 #normalize-mix-percentages): omitted share the remainder; sum > 100% scales
  down; sum < 100% scales up and becomes an alpha multiplier; all 0% → 50/50 at alpha 0; N colors fold left to right.
- **Relative colors** (css-color-5 #relative-syntax): channel keywords are `<number>`; omitted alpha = origin
  alpha; channels unclamped; `calc()` on `none` uses 0; `alpha()` works in the origin's space.
- **Invalid stays invalid**: mix percentages outside [0,100]; `specified hue` (only shorter/longer/increasing/decreasing); `calc(h + 1deg)`; legacy commas
  with numbers for hsl S/L or with `none` (#color-syntax-legacy); `alpha(from red)`; quirky hex outside quirks
  mode (#quirky-color). Evaluating one deletes the author's earlier fallback.
- **calc() special values** (#hue-syntax, #resolving-sRGB-values): infinite hue → 0deg, `NaN` → 0 (never `none`).
- **Context-dependent colors** (#resolving-other-colors, #css-system-colors, css-color-5 #resolving-mix,
  #light-dark): `currentcolor` computes to itself and inherits as a keyword; functions containing it compute to
  the function; system colors and `light-dark()` follow the used scheme. Only `light-dark(x, x)` → `x` is static.
- **light-dark() resolves where used** (css-color-adjust-1 #color-scheme-resolution): in an unregistered custom
  property it is tokens resolved on the substituting element.
- **color-scheme** (css-color-adjust-1 #color-scheme-prop): ordered (`dark light` ≠ `light dark`), custom idents
  kept, repeats may drop, `only` first or last.
- **Earlier declarations are fallbacks**: UAs drop what they cannot parse, so `color: red; color: <newer>` keeps
  `red` unless every target parses the later value; only `var()`/`env()` values always parse.
- **opacity** (#transparency): < 1 creates a stacking context; % → number.
- **Transparent colors differ** (#interpolation-alpha): polar hue is not premultiplied, `transparent` has a
  missing hue, so `rgb(255 0 0 / 0)` ≠ `transparent` in polar interpolation.
- **Hex** (#hex-notation): shorten only if every pair repeats; 4/8 digits need HexAlphaColors in all targets.
- **Precision** (#serializing-color-values): modern alpha ≥ 16 bits, legacy 8 (accepted); non-legacy → hex is lossy.
- **Gamut mapping** (#css-gamut-mapping, #pseudo-binsearch): clip check first, local MINDE, ΔE_OK JND 0.02,
  ε 0.0001; OkLCh L ≥ 1 → white, L ≤ 0 → black; in-gamut unchanged. Approximate: never expect an exact hex.
- **rec2020**: spec transfer is gamma 2.4, engines use the BT.2020 OETF; switching is a maintainer decision.

## Lightning CSS mechanisms behind failures

- hex/named/rgb()/hsl()/hwb() become u8 RGBA at parse time: rounding and lost hsl/hwb identity (matters in
  `color-mix(in hsl|hwb, …)`); `none` needs the Float variant and is lost on any hex print path.
- Fallback ladder (`color.rs` `get_possible_fallbacks`/`get_fallback`): RGB → P3 → LAB, P3 only if a target supports P3
  and none Lab, oklab/oklch → lab() as final when OklabColors must compile; `to_rgb()/to_p3()/to_lab()` results
  are unwrapped.
- `light-dark()` lowering (no LightDark: Chrome < 123, Firefox < 120, Safari < 17.5):
  `var(--lightningcss-light, a) var(--lightningcss-dark, b)` plus toggles from `ColorSchemeHandler` (`ui.rs`)
  where `color-scheme` is declared, keyed on its typed value. Exact only if a CSS `color-scheme` declaration
  (not `<meta>`) covers the element and it is not in a custom property defined under another scheme.
- Untyped, no fallbacks: `display-p3-linear`, method-less/1/3+ color `color-mix()`, mixing in non-sRGB RGB or
  custom spaces, `contrast-color()`, `device-cmyk()`, `color(--custom …)`, HDR.

## Engine divergences that matter for the oracle

- Only Chromium interpolates `none` in gradients per spec (a `none` → 0 change is a pixel diff only there); only
  WebKit serializes `none` in legacy forms (source of reason `missing-component-changed`).
- The newest none/powerless/analogous-set rules are partly implemented and engines split (O9): decide by the ED
  and WPT `css/css-color/parsing/color-computed-*.html`. Firefox treats cross-space `none` as 0.
- color-mix() results differ in the 4th digit between engines: compare within one. Chromium computes `alpha(from red / .5)` to legacy `rgba()` and rejects variadic and 1-color
  color-mix() (Firefox and Safari accept).
- The WPT lane skips `fuzzy_test_computed_color`: static mix/relative-color evaluation is probe-checked only.
- legacy-2023 (Chromium 110, Firefox 108, WebKit 16.4): no Color 4 in Chromium/Firefox, no light-dark(); WebKit
  has lab/oklch/color-mix. legacy-2021: no color-mix(); lab()/color() only in WebKit. Safari 10.1-14.x support
  only `color(display-p3|srgb)`: BCD partial support is not support.

## What lowering cannot preserve

Fallbacks only, never the final declaration or the `@supports` copy modern engines take: out-of-sRGB gamut,
8-bit precision, lost `none`/polar hue. oklab/oklch → lab() is exact only after clamping L (`oklab(.5 0 -2)`
unclamped gives a negative lab L, read as 0). No fallback exists for color-mix()/relative colors with `var()`,
`currentcolor` or system colors. Safe: hex lowercasing/shortening, legacy colors ↔ hex (not inside
`color-mix(in hsl|hwb)`), `transparent` ↔ all-zero hex, percent → number, `xyz-d65` ↔ `xyz`, dropping `/ 1`, omitting default
`currentcolor` in shadows, dropping repeated color-scheme keywords.
