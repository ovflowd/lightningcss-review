# Spec digest: images, gradients, backgrounds, borders, masking, filters, compositing, shapes

Areas: `gradient-image` (IMG), `background` (BG), `border-outline` (BORDER), `effects-masking` (FX). Source: research
`spec-images-effects` (Chrome 156.0.8078.47 pixel/CSSOM/animation checks), arch, compat, issue agents. `file:line` =
master `cbeaf83`; Firefox/WebKit claims are BCD unless marked. `images-4#x` = `https://drafts.csswg.org/css-images-4/#x`
(same for other shortnames; full URLs in analysis.json). A3 rejects `compat.spec.whatwg.org`; for legacy gradients cite
`https://www.w3.org/TR/2011/WD-css3-images-20110217/#linear-gradient-syntax`.

## 0. Specs read (fetched 2026-10-25)

css-images-3/-4 ED 2026-10-08, css-images-5 ED 2026-10-23; css-backgrounds-3 ED 2025-12-16, css-backgrounds-4 FPWD
2026-08-03; css-borders-4 WD 2026-10-15; css-masking-1 ED 2026-08-18; filter-effects-1/-2 ED 2026-09-22/2026-10-02
(drafts.csswg.org); compositing-1/-2 ED 2026-10-08/2025-12-13; css-shapes-1/-2 ED 2026-10-08/2026-05-06; css-values-4
ED 2026-08-24; css-color-4 §13 ED 2026-10-20; css-ui-4 WD 2026-10-15; WHATWG Compat §3.3-3.4 LS 2026-10-19; css3-images
WD 2011-02-17.

## 1. Known defects on master (a PR must not widen them; it may fix them)

All verified on master (cbeaf83). "no" = no issue filed.

| # | Defect | Where | Tracked | Probe |
|---|---|---|---|---|
| D1 | `-webkit-mask-composite` after `-webkit-mask`/`mask` hoisted before the deferred shorthand that resets it in Blink (gradient-border pattern: filled box) | masking.rs:663-749 (no arm); parsed as unknown (mod.rs:216-229) | no | effects-masking/sie-webkit-mask-composite-not-hoisted |
| D2 | `border:var(--b)` does not reset the deferred border-image; nor do sides collapsed into `border` after a flushed one | border.rs:710-728 | no | border-outline/sie-border-var-shorthand-resets-border-image |
| D3 | `mask-border` written before `mask` is printed after it | masking.rs:763-772 | no | effects-masking/arch-props-values-mask-shorthand-must-reset-mask-border |
| D4 | `MaskMode` = `MaskBorderSource` = `1 << 7`: a `mask` flush suppresses later mask-border fallbacks and vice versa | masking.rs:566,569; checks :838, :1035, :1086 | no | effects-masking/sie-mask-border-fallback-not-suppressed |
| D5 | Invalid made valid, then deduped over the valid one: 3-value `<position>` outside bg-position; `background-clip:border`; `mask-clip/-origin:margin-box`; color in a non-final layer; empty `filter:`/`background:`; `outline-style:hidden`; unitless px (`background:333333`) | position.rs:59-140; background.rs:236, :364; masking.rs:83-99; effects.rs:332-344; outline.rs:27-32; length.rs:145-148 | #682 (unitless) | `*/sie-*-invalid`, `*/*invalid*`, `values-numeric/*unitless*` |
| D6 | `to top`/`0deg` flip reverses stops without fixup and mirrors hints (curve asymmetric) | gradient.rs:282-319 | #1220 (unordered stops) | gradient-image/sie-to-top-flip-asymmetric-hint |
| D7 | Every `Hint(50%)` dropped, also off-midpoint (linear, radial, conic) | gradient.rs:1038-1041 | no | gradient-image/sie-conic-hint-50pct-not-midpoint |
| D8 | Stops `rgb(from red r g b)` → `red`, `color-mix(in srgb,red,blue)` → `purple`: Oklab → sRGB (maxdiff 84/37) | color resolution | no | gradient-image/sie-gradient-relative-color-stays-nonlegacy |
| D9 | Prefixed linear gradients printed with standard rules: minify maps `left`→`270deg`, flips `top`; `bottom`/`180deg` dropped even unminified; since #936 (v1.30.0) minified generated fallbacks flip | gradient.rs:268-330, 501-543 | #1107 (#918 fixed by #936) | `gradient-image/*legacy*`, `*/*prefixed-gradient*` |
| D10 | Standard → legacy angle is `abs(450-d) mod 360`: wrong above 450deg (`540deg` → `90deg`, not `270deg`) | gradient.rs:597-602 | no | gradient-image/sie-legacy-angle-over-450deg |
| D11 | Generated `-webkit-radial-gradient(circle at …)` uses modern syntax that every engine rejects | gradient.rs:368-417 | no | gradient-image/browser-compat-webkit-radial-gradient-legacy-position |
| D12 | The `-webkit-gradient()` fallback keeps non-monotonic stops (WebKit sorts) | gradient.rs:1495-1525 | no | gradient-image/sie-webkit-gradient-nonmonotonic-stops |
| D13 | image-set: `url()` fallback dropped before `image-set(… type())` for Chrome 25-112, Safari 6-16 (BCD partial counted); unprefixed options printed as strings (Safari 10.1-13.1 need `url()`); `x` → `dppx` in token lists | image.rs:390-395, 447-485; custom.rs:442; build-prefixes.js:434-436 | #1286 (dppx; dcbb9b8, v1.17.0; PR #1384) | gradient-image/sie-image-set-type-fallback-kept |
| D14 | `url("a" cross-origin(anonymous))` is a hard parse error, also in custom/unparsed properties | url.rs:33-38, custom.rs:383 | no | gradient-image/ssv-url-request-modifier |
| D15 | `border-image:none` (also `mask-border`, `-webkit-mask-box-image`) prints empty; the shared serializer applies border-image defaults to all three (INV-MASK-007; drops the `-webkit-border-image` slice that implies `fill`) | border_image.rs:295-335 | #1146 (dup #1052; PR #1336 approved) | border-outline/issues-b3-border-image-none-not-empty |
| D16 | `border-image-width/-outset: 0px` → `0` (`<number>`): Chrome animates `0→10px` as 10px at 50%, not 5px | zero printing (length.rs:493) | no | border-outline/sie-border-image-width-zero-length-stays-length |
| D17 | FallbackHandler: a later `-webkit-(backdrop-)filter` overwrites the unprefixed slot (lost in Chrome/Firefox); a later `filter` overwrites an author fallback (`is_compatible` = `true`) | prefix_handler.rs:116-121; effects.rs:410-414 | #695 #1086 #1229 #1327 #977 #1360 (2694a18, v1.21.0; PRs #1259 #1284 #1364) | effects-masking/issues-b5-backdrop-filter-unprefixed-kept |
| D18 | `-webkit-mask-image:var(--a);mask-image:var(--a)` gains another prefixed copy each pass | masking.rs:700-707 | #969 (PRs #1295, #1339) | prefixing-compat/issues-b1-mask-image-var-duplicate |
| D19 | Color fallback panics on `currentColor` (gradients, border-color, text-shadow) | color.rs:517-519, text.rs | PR #1311 | color/pr1311-currentcolor-gradient-fallback |
| D20 | Logical border-radius after a nested rule dropped or moved to the next sibling | nesting.rs:73-84 | #1049, #1246 (6c465c1, v1.30.0) | nesting/issues-important-nested-decl-logical-* |
| D21 | `background:-webkit-linear-gradient(…)` then an unprefixed `background`: re-appended at finalize after a later `background-image:var(…)` | background.rs:818-831, 915-923 | no | background/arch-props-values-prefixed-gradient-decl-moved-after-var |
| D22 | An unparsed `box-shadow` (incl. `none`, never typed) sets `flushed`: a later typed one gets no fallback | box_shadow.rs:177-183, 258 | no | none |
| D23 | With targets, a compat flush prints an earlier `border-image` before the pending `border` (Chrome 50); `-webkit-border-image:url(a) 30;border-image:url(b) 30` → both `b` | border_image.rs:416-443 | no | none |
| D24 | Filter default arguments omitted (`brightness(1)` → `brightness()`): wrong in old Chrome (CEF 49) | effects.rs:119-203 | #251 (PR #1121) | none |
| D25 | `opacity:0.9999999` → `1` (stacking context lost) | number printing | no | color/spec-color-opacity-below-one-not-rounded-to-one |

## 2. Cross-cutting

- **INV-GEN-001** Handlers defer; unowned properties are pushed at once (`declaration.rs:583-611`; finalize order
  `:695-731`: background, border(+image,+radius), outline, …, box-shadow, mask, …, fallback (filter, backdrop-filter),
  prefix (clip-path)), so an unowned property a deferred shorthand resets jumps before it. Visible: `-webkit-mask-composite`
  (D1, Blink), `-webkit-background-size/-origin` (all 3 engines), `mask-position-x/-y` (Firefox),
  `-webkit-mask-source-type` (WebKit). Spec-only (no engine resets it): `background-blend-mode`, `corner*`, two-corner
  radius shorthands, `background-tbd`. Benign: `mask-type`, `outline-offset`, `isolation`, `corner-shape`.
- **INV-GEN-002** Invalid made valid (D5): a parser laxer than the grammar lets dedupe delete a valid fallback.
- Unparsed (`var()` or any parse failure) flushes handlers and always overrides (IACVT); FallbackHandler overwrites the
  earlier slot **with its prefix**, PrefixHandler (clip-path) updates in place (prefix_handler.rs:22-46).
- `<position>` (values-4#position): 1/2/4-value; 3-value only in `background-position`. `Position::to_css`
  (position.rs:161-300, reworked by #1124) serves bg-position, mask-position, gradient and shape `at`.
- A bare `0` that may be `<number>` or `<length>` is a `<number>` (values-4#lengths).

## 3. gradient-image (`src/values/gradient.rs`, `image.rs`, `url.rs`)

Grammar: linear `[ [ <angle> | <zero> | to <side-or-corner> ] || <color-interpolation-method> ]? , <color-stop-list>`
(default `to bottom`; sides = `0|90|180|270deg`; corners box-dependent). Radial `[ <radial-shape> || <radial-size> ]?
[ at <position> ]?` (L3 size `<radial-extent> | <length> | <length-percentage>{2}`; L4 `<radial-extent>{1,2} |
<length-percentage>{1,2}`, not in Chrome 156; default `ellipse farthest-corner at center`; one `<length>` implies circle).
Conic `[ from [ <angle> | <zero> ] ]? [ at <position> ]?`, stops `[ <angle-percentage> | <zero> ]{1,2}`, 100% = 1turn.
One stop is valid (Issue 10092). Fixup (images-3#color-stop-fixup): first → 0%, last → 100%, a position below an earlier
maximum is raised (order dependent), unpositioned runs spaced evenly. Hint weight `C = P^(log_H 0.5)`
(images-4#coloring-gradient-line). Interpolation (color-4#interpolation-space): the given method, else **Oklab**, but
sRGB when every stop is legacy syntax (hex, named, rgb/hsl/hwb); premultiplied; hue `shorter`. `image-set( [ <image> |
<string> ] [ <resolution> || type(<string>) ]? # )`: drop unsupported `type()`, then repeated resolutions, then UA choice
(images-4#image-set-notation). Serialization (images-4#serialization, WPT gradient-interpolation-method-computed.html):
omit `in srgb` iff all stops legacy, `in oklab` iff any non-legacy, `shorter hue` always; `xyz` = `xyz-d65`.

Invariants (failing probes in §1; guards named here):
- **INV-GRAD-001** Side keywords = fixed angles; corners are not (`to bottom right` ≠ `135deg` off-square, Chrome 42/255). Guard `sie-corner-direction-not-angle`. images-3#linear-gradient-syntax
- **INV-GRAD-002** Unitless `0` only for linear direction, conic `from`, conic stops/hints (post-2023), `hue-rotate()`.
  Master leaves `0` conic stops unparsed (safe). Guard `sie-conic-unitless-zero-stop`. images-4#typedef-color-stop-angle
- **INV-GRAD-003** First `0%`/last `100%` omittable; an interior position only if it equals its fixup value in the same units. images-3#color-stop-fixup
- **INV-GRAD-004/005** Reversing stops is exact only for positions non-decreasing after fixup and no off-midpoint hint (D6). images-3#color-stop-fixup
- **INV-GRAD-006** A hint is a no-op only at the midpoint of its neighbours' resolved positions, not when it reads `50%` (D7). images-4#color-transition-hint
- **INV-GRAD-007** `c p1 p2` ≡ `c p1, c p2`, but stop count is interpolation-visible; never merge across a hint. images-3#color-stop-syntax
- **INV-GRAD-008/009** Legacy ↔ non-legacy stop rewrites switch sRGB ↔ Oklab (D8); `in srgb`/`in oklab` redundant only as
  above. Guards `sie-in-oklab-kept-for-legacy-stops`, `sie-in-srgb-kept-for-nonlegacy-stops` (for #1272). color-4#interpolation-space
- **INV-GRAD-010** Under `in oklch` a transparent stop keeps its hue: `rgb(255 0 0/0)` ≠ `transparent` (maxdiff 88; equal in rectangular spaces). Guard `sie-oklch-transparent-stop-hue-matters`. color-4#interpolation-alpha
- **INV-GRAD-011** A single stop ≡ `c, c` ≡ `image(c)`, never `background-color`. images-3#color-stop-syntax
- **INV-GRAD-012/013/014** `circle` is not the default; `from` cannot fold into stops; repeat period = last − first. images-4#radial-size, #conic-gradient-examples, images-3#repeating-gradients
- **INV-GRAD-015** `-webkit-/-moz-/-o-*-gradient()` = 2011 syntax: keyword = start side (`top` = `to bottom`), angles
  `legacy = (90deg − std) mod 360`, default `top`; no standard minify rules (D9-D11). WD-css3-images-20110217#linear-gradient-syntax
- **INV-GRAD-016** `-webkit-gradient()` sorts stops; exact only for monotonic percentage stops, no hints, default space (D12).
- **INV-GRAD-017** CSSOM gradient strings are no equivalence oracle (Chrome keeps the first `0%`, drops `in srgb`): use O6 pixels.
- **INV-IMG-001** `image-set()` option order and duplicates are semantic. Guard `sie-image-set-option-order-preserved`. images-4#image-set-notation
- **INV-IMG-002** Omitted resolution ≠ `1x` in the spec, but Chrome 104 and Safari 14.1 rejected the omission (#262, #264): master always prints `1x`.
- **INV-IMG-003** A lowering that cannot express the value keeps the author's earlier fallback (D13; #252, fixed cb69f33, covered only the no-image-set case).
- **INV-IMG-004** `cross-fade()` and `-webkit-cross-fade()` differ; never convert without remapping; percentage always serialized. images-4#cross-fade-function
- **INV-URL-001** `url(<string> <url-modifier>*) | <url-token> | src(…)`: unquoted takes no modifiers, escapes `( ) ' "` and whitespace; keep modifiers and `src()` (D14). Minify picks the shorter form (url.rs:66-83), pretty keeps quotes (#160). values-4#urls, #url-modifiers
- **INV-URL-002** `url(#id)` is document-local, not a bundler dependency (url.rs:105-118, f6f1673, #1055). **INV-URL-003** `url("")` ≠ `none`. values-4#local-urls, #url-empty

Conformance (unparsed = token list; colors/units inside still minified):

| Item | Status | Where | Gaps |
|---|---|---|---|
| `<image>` | partial | image.rs:32-42 | `cross-fade()`, `element()`, `image()`, `paint()`, `filter()` unparsed |
| `url()` | partial | url.rs:33-92 | modifiers hard error (D14); `src()` unparsed |
| `image-set()` | partial | image.rs:312-498 | omitted resolution printed `1x`; `x` forced (:475-483); unprefixed strings, prefixed `url()` (:447-470) |
| linear / radial / conic | partial | gradient.rs:238-874 | no `in <space>` (#1272: value unparsed); L4 radial, `<zero>` conic stops unparsed |
| stops / hints | partial | gradient.rs:884-1076 | double positions split at parse, merged at print if supported (:1043-1065, printer targets) |
| prefixed, `-webkit-gradient()` | partial | gradient.rs:175-186, 545-602, 1078-1525 | D9-D12; `-webkit-gradient` for Chrome 4-9, Safari 4-6 (prefixes.rs:2272-2294) |

Divergences: Chrome 156 animates gradients discretely; single stop since Chrome 135, Firefox 136, Safari 18.4; no
unprefixed `cross-fade()` in Chrome; unprefixed `image-set` Chrome 113, Firefox 89, Safari 17 (14-16 no `type()`);
Firefox turns `-webkit-gradient()` into `linear-gradient()`.

Lowering (an exact fallback preserves): prefixed linear (Chrome 4-25, Safari 4-6, Firefox 3.6-15): inverted keywords,
`(90 − std) mod 360` angles, legacy printing (no `to`, default `top`, no flip); corners inexact off-square (fine: the
unprefixed declaration follows). `-webkit-gradient()` only when exact. Color fallbacks (lab/oklch → hex) interpolate in
sRGB (inherent); `oklch` → `lab` stays Oklab; the double-position split is exact. Not lowered (a decision): single stop
(exact as `c, c`), hints/methods, conic. `image-set` prefix (Chrome 21-112, Safari 6-9.1, iOS 6-9.3): `url()`/`x` only,
no `type()`/gradients; keep the author's fallback on partial support.
Lags: `in <space>` (#1272), single-stop lowering, L4 radial, `<zero>` conic stops, new `cross-fade()`, `image()`, url
modifiers (Chrome 150, Safari 26.2), `src()`, image-set invalid when all options drop (Issue 8266).

## 4. background (`src/properties/background.rs`, `src/values/position.rs`)

Grammar: `<bg-layer>#? , <final-bg-layer>` (color only in the final layer); resets per layer image, position, size,
repeat, attachment, origin, clip, plus color and `background-blend-mode` (compositing-1#background-blend-mode). One
`<visual-box>` = origin + clip, two = origin then clip; L4: a clip-only value (`text`, `border-area`) sets clip and
origin `border-box`. `background-size: X` = `X auto`; layer count = `background-image` items (backgrounds-3#layering).
L4: `background-position-x/-y/-inline/-block`, `background-repeat-x/-y`, `repeat-block/-inline`, `border-area`.

Invariants:
- **INV-BG-001** `background` resets every layer longhand, color and blend-mode (no oracle engine resets blend-mode). backgrounds-3#background
- **INV-BG-002** Color in a non-final layer = invalid declaration (D5). **INV-BG-007** `background-clip:border` invalid (D5). backgrounds-4#typedef-bg-clip
- **INV-BG-003** `(padding-box, text)` → `text` is Chrome-correct (origin stays `padding-box`), spec-wrong; `(padding-box, border-area)` → `border-area` is wrong everywhere. backgrounds-4#background
- **INV-BG-004/005** Lists align by index (unequal lengths: exact longhands); `none` layers are real layers. backgrounds-3#layering
- **INV-BG-006** 3-value positions only here (D5 elsewhere). **INV-BG-008** side-relative `background-position-x: right 10px` needs Chrome ≥ 144. values-4#position
- **INV-BG-009** Unowned overlapping properties keep source order (INV-GEN-001; D21: prefixed images).
- `background:none` → `0 0` (background.rs:517-525): computed `background-position` `0% 0%` vs `0px 0px` is render- and
  interpolation-equivalent (EM-46).

Conformance: longhands typed (mod.rs:1203-1212); `background-clip` partial (`Border` variant; `border-area` unparsed;
`text` prefixed for Chrome 4-119, Safari 3.2-13, iOS 4-13, prefixes.rs:786-825); shorthand only when all list lengths
match (:974-983); blend-mode, `background-tbd`, L4 longhands unparsed or unknown. Divergences: `border-area` (Chrome
150, Safari 18.2) sets origin `border-box`; Firefox's computed `background` keeps relative URLs. Lowering:
`-webkit-background-clip:text` after the shorthand (exact); Android WebView 5+ gets no caniuse-derived prefix (residual
of #1180); build-prefixes.js overrides are generated data (B11). Lags: `border-area`, L4 longhands, `background-tbd`,
`plus-lighter` in background-blend-mode.

## 5. border-outline (`src/properties/border.rs`, `border_image.rs`, `border_radius.rs`, `outline.rs`)

Grammar: `<line-width>` = `<length [0,∞]> | hairline | thin | medium | thick` (1/3/5px; width 0 for none/hidden is a
resolved-value effect, Issue 11494); `border`, `border-<side>`: `<line-width> || <line-style> || <color>`; **only `border`
resets `border-image`** (backgrounds-3#border-shorthands). Radius longhand `a b` = horizontal/vertical; shorthand
`<lp>{1,4} [ / <lp>{1,4} ]?` per corner TL TR BR BL; L4: `a / b` longhands, two-corner shorthands, `corner-*-shape`
(round 1, squircle 2, square ∞, bevel 0, scoop −1, notch −∞), `corner`/`corner-*` (reset radii; `border-radius` does
not reset shapes), `border-shape`. `border-image: <source> || <slice> [ / <width> | / <width>? / <outset> ]? || <repeat>`;
slice `[<number>|<percentage>]{1,4} && fill?` (initial 100%), width `[<lp>|<number>|auto]{1,4}` (initial 1 = multiple of
border-width), outset `[<length>|<number>]{1,4}` (initial 0). `outline-style: auto | <outline-line-style>` (no `hidden`);
`outline-color` initial `auto` = accent color under `outline-style:auto`, else currentcolor (ui-4#outline-color).

Invariants:
- **INV-BORDER-001** `border` resets border-image, also as `border:var()` (D2). Guard `sie-border-shorthand-resets-border-image`. History #103 (28bf5af), #187 (957b1cd). backgrounds-3#border-shorthands
- **INV-BORDER-002** In border-image-width/-outset and mask-border-*, `<number>` multiplies border-width: never strip units (D16). values-4#lengths, backgrounds-3#border-image-width
- **INV-BORDER-003** border-image-slice `0` vs `0%` interpolate differently (Chrome discrete); `fill` anywhere. Master keeps `0%`. backgrounds-3#border-image-slice
- **INV-BORDER-004/005** All-initial border-image prints `none`, never empty (D15, #1146); width-omitted form keeps `//`. backgrounds-3#border-image
- **INV-BORDER-006** `border:5px none` keeps computed width 5px (a later `border-style:solid` shows it); `hairline` not convertible. backgrounds-3#border-width, borders-4#typedef-line-width
- **INV-BORDER-007** Longhand `a b` = h/v, shorthand `a b` = per corner (#308 swapped BL/BR; its test encoded the bug). borders-4#typedef-border-radius
- **INV-BORDER-008** corner-shape keywords ≡ superellipse values; master emits unknown `corner:` before a deferred `border-radius` (spec-wrong once shipped; Chrome 156 lacks `corner`). borders-4#corner-shorthands
- **INV-UI-001** `outline-style:hidden` invalid (D5). **INV-UI-002** `outline-style:auto` + explicit `outline-color:currentcolor` collapsed into `outline:auto` (master: `outline:3px auto`) moves the color to `auto` (spec-only: no engine accepts `outline-color:auto`). ui-4#outline-color
- CSS-wide: `border-width/style/color: inherit` must not become `border: inherit` (also inherits border-image). Guard `rule-merging/css-wide-longhands-not-collapsed-into-shorthand`.

Conformance: sides, logical and shorthands typed (mod.rs:1255-1323; no `hairline`, `<image-1D>`); radius typed, L4
forms unparsed, prefix merge overwrites the value once that prefix is stored (border_radius.rs:119-133); border-image
typed with prefixes, `fill` disables prefixing (border_image.rs:522); corner*, `border-shape` unparsed; outline typed
(`hidden` accepted), `outline-offset` unknown (#1048); negative widths/radii unparsed (#1329, unreleased).
Divergences: computed `border-top-width` is `0px` with style none (even `thick`), `outline-width: medium` reads `3px`;
corner-shape Chrome 139. Lowering: border-image gradient fallbacks only in the matching-prefix property
(border_image.rs:522-530); logical borders/radii → physical (block axis) or `:dir()`/`:lang()` rules (inline axis) that
raise specificity, drop `!important` (arch-core N5) and get lost or misplaced after nested rules (D20).
Lags: `hairline`, slash longhands, two-corner shorthands, `corner`, `border-shape`, `<image-1D>`, box-shadow longhands.

## 6. effects-masking (`src/properties/masking.rs`, `effects.rs`, `box_shadow.rs`, `src/values/shape.rs`)

Grammar (masking-1): `<mask-layer> = <mask-reference> || <position> [ / <bg-size> ]? || <repeat-style> ||
<geometry-box> || [ <geometry-box> | no-clip ] || <compositing-operator> || <masking-mode>`; **`mask` also resets the six
`mask-border-*`** (#the-mask). `mask-clip: [ <coord-box> | no-clip ]#`, `mask-origin: <coord-box>#` (no margin-box);
`mask-position: <position>#`; bottom-layer composite ignored; `none` = transparent-black layer. `mask-border` initials:
slice **0**, width **auto**, mode alpha. `clip-path: <clip-source> | [ <basic-shape> || <geometry-box> ] | none` (box
default border-box). Filters `none | [ <filter-function> | <url> ]+`: omitted amounts 1, blur 0px, hue-rotate 0deg,
drop-shadow color = `color`; negatives invalid; non-none = stacking context + containing block + Backdrop Root.
`mix-blend-mode: <blend-mode> | plus-lighter`. Shapes `inset()`, `xywh()/rect()` (compute to `inset()`),
`circle()/ellipse( <radial-size>? [ at <position> ]? )`, `polygon()`, `path()`, `shape()`; `shape-outside` box defaults
to margin-box. box-shadow `<color>? && <length>{2} [ <length [0,∞]> <length>? ]? && inset?`, front to back.

Invariants:
- **INV-MASK-001** `mask` resets mask-border; one written after `mask` stays after (D3). masking-1#the-mask
- **INV-MASK-002** Blink: `-webkit-mask-composite` = `mask-composite` with legacy keywords, reset by `mask`/`-webkit-mask` (D1). masking-1#the-mask, compat#propdef--webkit-mask-composite
- **INV-MASK-003** mask-clip/origin take `<coord-box>`; clip-path `<geometry-box>` (D5). **INV-MASK-004** box keyword rules as background, plus `<box> no-clip`. masking-1#the-mask-clip
- **INV-MASK-005** `none` layers participate in compositing. Guard `sie-mask-image-none-layer-kept`. masking-1#the-mask-image
- **INV-MASK-006** add/subtract/intersect/exclude = source-over/source-out/source-in/xor. Guard `sie-mask-composite-porter-duff-mapping`. masking-1#the-mask-composite
- **INV-MASK-007** mask-border, `-webkit-mask-box-image` (Blink initial `0 fill`, auto) and border-image defaults all differ (D15). masking-1#the-mask-border-slice
- **INV-MASK-008** mask and mask-border fallbacks never depend on each other's flush (D4). **INV-MASK-009** `mask-mode` lowers only for Safari; `mask-border-mode:luminance` has no prefixed form. masking-1#the-mask-mode
- **INV-CLIP-001** `clip-path:border-box` ≠ `inset(0)` (corners); `inset(0)` ≠ `none` (stacking, ink overflow). Guard `sie-clip-path-border-box-not-inset`. masking-1#the-clip-path
- **INV-CLIP-002..005** `rect()/xywh()` → `inset()` exact; circle/ellipse defaults omittable, keyword radii do not interpolate, 3-value `at` invalid (D5); polygon points never deduped; `clip: rect()` ≠ `inset()`. shapes-1#basic-shape-computed-values
- **INV-FILTER-001** Functions apply in order, never merge (`brightness(2) brightness(.5)` ≠ identity). filter-effects-1#FilterProperty
- **INV-FILTER-002** An identity list never becomes `none`. Guard `sie-filter-identity-not-none`.
- **INV-FILTER-003** `grayscale()` = `grayscale(1)`, `drop-shadow(… currentcolor)` = `drop-shadow(…)`; old Chrome mis-defaulted (#251, D24). Guard `sie-drop-shadow-default-color-currentcolor`. filter-effects-1#supported-filter-functions
- **INV-FILTER-004/005/006** grayscale/invert/opacity/sepia clamp to 1; `hue-rotate()` not normalized (guard `sie-hue-rotate-not-normalized`); drop-shadow blur is a std deviation, no spread. filter-effects-1#funcdef-filter-hue-rotate, #funcdef-filter-drop-shadow
- **INV-FILTER-007** Chrome/Firefox never supported `-webkit-backdrop-filter`: never drop the unprefixed one (D17). filter-effects-2#BackdropFilterProperty
- **INV-FILTER-008** Empty or partly invalid filter lists are invalid and must not replace an earlier one (D5). filter-effects-1#typedef-filter-value-list
- **INV-BLEND-001/002** `plus-darker` never wins a dedupe over a standard value; `background-blend-mode` is layer-aligned; `isolation:isolate` ≠ `auto`. compositing-2#mix-blend-mode, compositing-1#isolation
- **INV-SHAPE-001** shape-outside defaults ≠ clip-path defaults; threshold clamps to [0,1]; `shape-margin` ≥ 0. shapes-1#shape-outside-property
- **INV-BORDER-009** (box-shadow) front-to-back order; `none` ≠ zero shadows; default currentcolor; a rejected blur never becomes spread (backgrounds-3#box-shadow). **opacity** < 1 never prints `1` (D25, color-4#transparency).

Conformance: clip-path partial (masking.rs:372-452; inset/circle/ellipse/polygon only, shape.rs:26-35; `rect()`,
`xywh()`, `path()` (PR #868), `shape()`, `polygon(round)`, radial extents (#1168, #1169) unparsed; PrefixHandler); mask
longhands typed, shared `GeometryBox` (incl. MarginBox); `mask-position-x/-y`, `mask-type` unowned; the prefixed flush
emits `-webkit-mask-composite`/`-webkit-mask-source-type` (masking.rs:957-1005); mask-border typed with border-image
defaults; filter/backdrop-filter typed (FallbackHandler; D17, D24); mix-blend-mode typed (#1148, has `plus-darker`, no
handler); `clip` (#688), isolation, background-blend-mode, shape-* unparsed; box-shadow typed (`none` unparsed).

Divergences (O9):

| Topic | Chrome 156 | Firefox / WebKit |
|---|---|---|
| `-webkit-mask-composite` | legacy keywords only; shares storage with `mask-composite`; reset by both shorthands | Firefox: standard alias, rejects `xor`; WebKit: maps legacy keywords both ways |
| 3-value position | invalid in `<position>` slots, **valid inside `mask`** | WPT: invalid |
| `margin-box` in mask-clip/origin | invalid (also in `mask`) | no support; spec grammar inconsistent |
| `mask-border` | unsupported (only `-webkit-mask-box-image`) | WebKit 17.2 unprefixed; Firefox none |
| `-webkit-backdrop-filter` | rejected | Firefox rejects; WebKit links both names (last wins) |
| `plus-darker` / `grayscale(1.5)` | unsupported / clamped at parse | Safari only / — |

Lowering: masks (Chrome 4-119, Safari 4-15.2, iOS 3.2-15.2; prefixes.rs:1438-1489) → `-webkit-mask` +
`-webkit-mask-composite` + `-webkit-mask-source-type` (Safari only; Chrome cannot lower `mask-mode`), in order with an
author `-webkit-mask-composite`. `mask-border` → `-webkit-mask-box-image` must spell out slice (0, no fill) and `width
auto`. `backdrop-filter` (Safari 9-17.6, Edge 17-18 via the ms→webkit override) → prefixed copy plus the unprefixed one.
`clip-path` (Chrome 24-54, Safari 7-9; caniuse#6209 override) and `filter` (Chrome 18-52, Safari 6-9) are plain aliases.
Default-argument omission (#251) is spec-correct; workarounds only behind targets (#1121; #101 rejected).
Lags: `rect()/xywh()/shape()/path()`, `polygon(round)`, shape radial extents, `half-border-box`, `filter()`.

## 7. Oracle notes for these areas

- Gradient-only deltas: decide with the O6 screenshot hash (INV-GRAD-017); a legacy ↔ non-legacy stop switch is
  `different` by design. Compare longhands: computed `background`, `mask`, `border-image`, `mask-border` strings are
  engine-specific or empty; `url()` targets never load (L7).
- Interpolation effects (D16, `hue-rotate()`, hints) show only in paused animations (`animation: k 1s linear -0.5s
  paused`, as in the `sie-*` probes); stacking effects (identity filter or `inset(0)` → `none`, `opacity` → `1`) need a
  `dom:` line with a dependent child (z-index:-1 or position:fixed).
- O9 misfires on prefix aliases: WebKit links `backdrop-filter`/`-webkit-backdrop-filter`, Firefox rejects legacy
  `-webkit-mask-composite` keywords; both report equivalent while Chromium shows the real regression.
- Chromium 97/110 (`engine-legacy-2021/-2023`) need `-webkit-image-set`, `-webkit-mask*`, `-webkit-background-clip:text`,
  lack lab/oklch and `in <space>` (O4 sees those lowerings). No engine renders prefixed gradients (Chrome ≤ 25),
  `-webkit-gradient()`, `-webkit-filter` or `-webkit-clip-path`: use output assertions.
