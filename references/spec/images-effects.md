# Spec digest: images, backgrounds, borders, masking, effects

`images-4#x` = `https://drafts.csswg.org/css-images-4/#x` (any shortname); full URLs in analysis.json. Legacy
gradients: cite `https://www.w3.org/TR/2011/WD-css3-images-20110217/#linear-gradient-syntax`.

## Cross-cutting

- Handlers buffer until `finalize()`; a property the handler does not own (newer longhand, alias, prefixed-only or
  unknown name, `Unparsed`) is pushed at once, so it lands before a deferred shorthand that resets it. Engine-visible:
  `-webkit-mask-composite` (Blink), `-webkit-background-size/-origin` (all), `mask-position-x/-y` (Firefox),
  `-webkit-mask-source-type` (WebKit). Spec-only (no oracle engine resets it): `background-blend-mode`, `corner*`.
- Invalid made valid: a parser laxer than the grammar turns a declaration browsers drop into one that wins dedupe over
  the earlier valid fallback.
- `FallbackHandler` (filter, backdrop-filter) overwrites the earlier slot with its own prefix; `PrefixHandler`
  (clip-path) updates in place (`src/properties/prefix_handler.rs`).
- `<position>`: 3 values only in `background-position` (values-4#position). `Position` also serves mask-position,
  gradient/shape `at`, transform-origin.
- A bare `0` where `<number>` and `<length>` are both valid is a `<number>` (values-4#lengths): keep the unit.

## Gradients and images

- Linear default `to bottom`; sides = 0/90/180/270deg; corners depend on the box (`to bottom right` ≠ `135deg` off-square). images-3#linear-gradient-syntax
- Radial: one `<length>` implies circle, else ellipse. Conic `from` cannot fold into stops. images-4#radial-size
- Fixup: first → 0%, last → 100%, a position below an earlier one is raised, unpositioned runs spaced evenly; an interior position is omittable only if equal to its fixup value. images-3#color-stop-fixup
- Reversing stops (the `to top`/`0deg` flip) is exact only for positions non-decreasing after fixup and hints at midpoints.
- A hint is a no-op only at the midpoint of its neighbours' resolved positions, not whenever it reads `50%`. images-4#color-transition-hint
- `c p1 p2` ≡ `c p1, c p2`; a single stop ≡ `c, c`; repeat period = last − first. images-3#color-stop-syntax, images-3#repeating-gradients
- Interpolation: the given method, else Oklab, but sRGB when every stop is legacy syntax (hex, named, rgb/hsl/hwb), so a
  stop rewritten across legacy/non-legacy switches the space. `in srgb` is redundant iff all stops are legacy, `in oklab`
  iff any is not. color-4#interpolation-space, images-4#serialization
- In polar spaces a transparent stop keeps its hue (`rgb(255 0 0/0)` ≠ `transparent`); `none` is interpolation-visible. color-4#interpolation-alpha
- `-webkit-/-moz-/-o-*-gradient()` use 2011 syntax: keyword = start side (`top` = `to bottom`), `legacy = (90deg − std)
  mod 360`, default `top`, no `to`, radial `<position>, <shape> <size>` (no `at`). Standard shortcuts do not apply.
- `-webkit-gradient()` sorts stops: exact only for monotonic percentage stops, no hints.
- lab/oklch → rgb stop fallbacks interpolate in sRGB: inherent, not a defect.
- `image-set()` option order and duplicates matter; print an explicit `1x` (older engines reject an omitted resolution)
  and only `x` (Safari). `type()` options the UA lacks are dropped. images-4#image-set-notation
- `url(<string> <url-modifier>*) | <url-token> | src()`: the unquoted form takes no modifiers and escapes `( ) ' "` and
  whitespace; `url("")` is invalid, not `none`; `url(#id)` is document-local. values-4#urls, values-4#url-empty

## Backgrounds

- Color only in the final layer; `background` resets every layer longhand, color and `background-blend-mode`. backgrounds-3#background, compositing-1#background-blend-mode
- Lists align by index; layer count = `background-image` items; `none` is a layer; `background-size: X` = `X auto`. backgrounds-3#layering
- One box sets origin and clip, two set origin then clip; L4 clip-only `text`/`border-area` set origin `border-box`
  (Chrome: initial `padding-box`); `border` is not a clip keyword. backgrounds-4#typedef-bg-clip

## Borders and outline

- Only `border` resets `border-image`; side and `border-width/-style/-color` shorthands do not. backgrounds-3#border-shorthands
- `border-image` slice `[<number>|<percentage>]{1,4} && fill?` (initial 100%), width `[<lp>|<number>|auto]` (initial 1 =
  ×border-width), outset `[<length>|<number>]` (initial 0); all-initial prints `none`; width-omitted form keeps `//`;
  slice `0%` and `0` interpolate differently. backgrounds-3#border-image
- `border:5px none` keeps width 5px for a later `border-style`; `border:none` ≠ `border:0`. backgrounds-3#border-width
- Radius longhand `a b` = horizontal/vertical; shorthand per corner TL TR BR BL, `/` splits axes. `corner*` reset radii,
  `border-radius` does not reset `corner-shape`. backgrounds-3#border-radius, borders-4#corner-shorthands
- `outline-style` has `auto`, no `hidden`; `outline-color` initial `auto` = accent color under `outline-style:auto`. ui-4#outline-color
- Longhands with CSS-wide keywords never collapse into a shorthand that resets more.

## Masking, filters, shapes, shadows

- `mask` resets every `mask-border-*`. masking-1#the-mask
- `mask-clip/-origin` take `<coord-box>` (no `margin-box`); `<box> no-clip` sets clip `no-clip`. masking-1#the-mask-clip
- `none` mask layers take part in compositing; the bottom layer's `mask-composite` is ignored. masking-1#the-mask-image
- add/subtract/intersect/exclude = `-webkit-mask-composite` source-over/source-out/source-in/xor; Blink stores both in one
  slot and both shorthands reset it. masking-1#the-mask-composite
- Initials differ: `mask-border` slice 0, width auto; Blink `-webkit-mask-box-image` slice `0 fill`, width auto;
  `-webkit-border-image` implies `fill` once a slice is given. `mask-mode` lowers to `-webkit-mask-source-type` (WebKit
  only); `mask-border-mode: luminance` has no prefixed form. masking-1#the-mask-border-slice
- Filters apply in order, never merge; an identity list ≠ `none` (non-none = stacking context, containing block, backdrop
  root); omitted amount 1, hue-rotate 0deg (no modulo), drop-shadow color currentcolor; only grayscale/invert/opacity/
  sepia clamp to 1; drop-shadow blur is a std deviation, no spread. filter-effects-1#supported-filter-functions
- Empty or partly invalid filter lists are invalid; Chrome and Firefox never supported `-webkit-backdrop-filter`. filter-effects-2#BackdropFilterProperty
- Box defaults: clip-path border-box, shape-outside margin-box; `border-box` ≠ `inset(0)` (radii), `inset(0)` ≠ `none`
  (stacking); `rect()/xywh()` compute to `inset()`; polygon points are not deduped; `clip: rect()` ≠ `inset()`. shapes-1#basic-shape-computed-values
- `plus-darker` is Safari-only, not a `<blend-mode>`. compositing-2#mix-blend-mode
- box-shadow: front to back, `none` ≠ zero shadows, blur ≥ 0, spread signed. `opacity` < 1 is a stacking context. backgrounds-3#box-shadow

## Engine divergences (O9)

- Prefix aliases: WebKit links `backdrop-filter`/`-webkit-backdrop-filter`, Firefox rejects legacy `-webkit-mask-composite`
  keywords; both report equivalent: judge by Chromium.
- Chromium accepts a 3-value position inside `mask` only (a quirk, not grammar). Unprefixed `mask-border`: WebKit only.

## Oracle notes

- Computed gradient strings are no equivalence oracle: judge by O6 pixels. Computed `background`, `mask`, `border-image`
  shorthand strings are engine-specific: compare longhands.
- Interpolation effects (zero units, hints, `hue-rotate`) show only in paused animations; stacking effects need a `dom:`
  line with a `z-index:-1` or `position:fixed` child.
- `engine-legacy-2021/-2023` need `-webkit-image-set`, `-webkit-mask*`, `-webkit-background-clip:text`, lack
  lab/oklch and `in <space>`. None renders 2011 prefixed gradients, `-webkit-gradient()`, `-webkit-filter` or
  `-webkit-clip-path`: use output assertions.
