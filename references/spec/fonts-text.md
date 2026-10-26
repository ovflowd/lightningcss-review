# Spec digest: fonts, text, decoration, writing modes, logical (+ lists, counters, content)

Areas: `font` (§2), `text` (§3), `logical` (§4), lists/counters/content of `ui-misc` (§5), oracle/WPT gaps (§6). Sources:
research `spec-fonts-text`, `arch-*`, `browser-compat`, `ecosystem-minifiers`, issue/PR records. `file:line` at `cbeaf83`;
"verified" = re-run on a CLI built from `cbeaf83` (2026-10-26). **FAIL** = fails on master; "by design" = documented
deviation (never the PR's fault); UNVERIFIED = engine behavior nobody measured.

## 0. Specs read

Anchor shorthand: `fonts-4#x` = `https://drafts.csswg.org/css-fonts-4/#x` (A3 needs full URLs).

| Spec | Latest TR | ED read | For |
|---|---|---|---|
| css-fonts-4 / -5 | WD 2026-10-22 / WD 2026-09-13 | same dates | `font`, longhands, font at-rules; size-adjust |
| css-text-3 / -4 | CRD / WD 2026-08-14 | 2026-08-14 | white-space, text-wrap, text-align, tab-size, spacing |
| css-text-decor-3 / -4 | CRD 2022-05-05 / WD 2022-05-04 | 2025-12-16 / 2026-08-17 | decoration, emphasis, shadow |
| css-inline-3 | WD 2024-12-18 | 2026-10-14 | line-height, vertical-align, text-box |
| css-writing-modes-4 | CR 2019-07-30 | 2026-01-20 | logical-to-physical, SVG values |
| css-logical-1 | WD 2025-12-04 | 2025-12-12 | groups; ED open issues 1282 (`logical` keyword), 3029 (inheritance), 3030 (shorthands) |
| css-lists-3, counter-styles-3, content-3, ruby-1 | WD 2020-11-17, CRS 2021-07-27, WD 2025-12-04, WD 2022-12-31 | 2026 | §5 |

Typed grammars follow old drafts (`src/properties/mod.rs`): css-text-3 CRD 2021 (`:1484`), css-text-decor-4 WD 2020
(`:1500`), css-writing-modes-3 (`:1516`, only direction/unicode-bidi), css-lists-3 WD 2020 (`:1533`).
`fonts-4#family-name-syntax` is not an ED anchor: cite `fonts-4#font-family-name-syntax`.

## 1. Rules that cut across this cluster

1. **Typed + dedupe deletes fallbacks (class A).** A parser that accepts browser-invalid input yields a typed value; the
   handler keeps the last one (FontHandler, TextDecorationHandler) or FallbackHandler overwrites the earlier slot
   (`prefix_handler.rs:116-121`; `Unparsed` always overwrites, `:148-155`), deleting the valid declaration before it.
   Typed→`Unparsed` pairs survive (`white-space:pre-wrap;white-space:preserve nowrap`).
2. **Buffered handlers reorder (class B).** Unowned properties are pushed at once, owned ones at flush/finalize
   (`declaration.rs:246-253`, `:695-731`). FontHandler owns `font` + 7 longhands; other longhands `font` resets, and
   unknown aliases (`font-width`, `-webkit-margin-start`, `-webkit-logical-width`), jump ahead.
3. **In-place overwrite crosses `var()` (class C).** PrefixHandler (`prefix_handler.rs:21-52`; tab-size, hyphens,
   text-align-last, text-decoration-skip-ink, text-overflow, text-size-adjust) has no `Unparsed` arm:
   `tab-size:4;tab-size:var(--t,2);tab-size:8` → `tab-size:8;tab-size:var(--t,2)` (verified).
4. **Zero lengths lose the unit** outside calc (`values/length.rs:493`); unitless numbers parse as px (`:145-148`,
   #1199/#682): `letter-spacing:20` → `20px` (verified).
5. **Ranges** (`css-values-4#calc-range`): out-of-range literals are invalid, out-of-range calc() clamps. #1329
   (`b0939ab`, unreleased) added `NonNegative<T>`, not [1,1000] or [-90deg,90deg]. Test idiom `property_range_test`
   (`src/lib.rs:102`; `None` = must stay `Unparsed`).
6. **Never fold context-dependent values** (`from-font`, `font-size: math`, `palette-mix()`, fill-only emphasis style).
7. **Typing is the risk.** Post-2023 syntax passes through unparsed (safe); typing adds a handler and a grammar that
   must match the current ED (WPT `value-coverage-gap`/`invalid-typed`, O7).

## 2. Fonts (`font`)

### 2.1 Grammar essentials
- `font` (`fonts-4#font-prop`) = `[ [ <'font-style'> || <font-variant-css2> || <'font-weight'> || <font-width-css3> ]?
  <'font-size'> [ / <'line-height'> ]? <'font-family'># ] | <system-font-family-name>`: caps normal | small-caps, width
  keywords only, **no %** (`#font-width-css3-values`). **Resets 13 reset-only longhands**: font-feature-settings,
  -kerning, -language-override, -optical-sizing, -size-adjust, -variant-alternates/-caps (CSS3)/-east-asian/-emoji/
  -ligatures/-numeric/-position, -variation-settings (not font-palette, font-synthesis-*). System fonts (`caption`,
  `menu`, …) only as the whole value.
- `font-family` (`#font-family-name-syntax`): `<string> | <custom-ident>+` joined by one space; no identifier may be a
  pre-defined keyword or CSS-wide keyword (per identifier: `Serif Gothic` unquoted is invalid); a quoted generic is a
  family name.
- `font-weight` `<number [1,1000]>` | keywords; `font-width` = `font-stretch` (alias, `#font-stretch-prop`) normal |
  `<percentage [0,∞]>` | keyword; `font-style` normal | italic | left | right | `oblique <angle [-90deg,90deg]>?`
  (bare = 14deg); `font-variant` (`#font-variant-prop`) resets its 7 sub-properties, not feature/variation-settings.
  Feature tags are case-sensitive; dedupe/sort only at computed time.
- `line-height` (`inline-3#line-height-property`): a number inherits as a factor, %/length as a length; `0` ≠ `0px`.
- `@font-face` (`#font-face-src-parsing`): an `src` with no supported entry is invalid, so an **earlier `src` wins**.
- `@font-feature-values` (`#font-feature-values-syntax`): a generic family in the prelude invalidates the rule; the
  block takes feature at-rules and **`font-display`** (`#font-display-font-feature-values`, still in the ED; Devon
  dropped it in #840 as "being removed from spec"). Values are non-negative integers (exactly 1 for @swash/@ornaments/
  @stylistic/@annotation, 1-2 @character-variant); an invalid declaration "must be ignored"; (family, block, name) is
  last-defined-wins across the document. **Spec conflict**: grammar bounds @styleset to [0,20] and @character-variant
  to [0,99], prose says values > 99 "do not generate a syntax error".
- `@font-palette-values` (`#descdef-font-palette-values-font-family`): `font-family: <font-family-name>#` (required), indexes
  `<integer [0,∞]>`, absolute `override-colors` (Issue 9555); last same-name rule wins (Issue 12981).

### 2.2 Invariants (master status, probes)
- **INV-FONT-001** Fold longhands into `font` only if each reset-only longhand is set later or initial everywhere
  (`#font-prop`). **FAIL**: the 7 longhands → `font:400 12px serif` (verified). Probe
  `font/arch-props-values-font-longhands-merge-resets-variant-numeric`.
- **INV-FONT-002** A reset-only longhand after `font` stays after it, typed or not. **FAIL** #1207 (cf. #1084/#572 transition/animation; PR #1209:
  untyped only): `font:12px serif;font-variant-numeric:oldstyle-nums` → longhand first (verified). Probe
  `font/font-shorthand-reset-only-longhands-keep-order`.
- **INV-FONT-003** font-variant longhands before `font-variant` stay before it. **FAIL** (verified;
  `font/sft-font-variant-shorthand-after-caps`).
- **INV-FONT-004** `font` holds only CSS2 caps and keyword widths. Caps PASS (`font.rs:952-964`); width **FAIL** #1140:
  `font:condensed 12px serif` → `font:75% 12px serif` (verified). Probe `font/issues-important-font-shorthand-stretch-keyword`.
- **INV-FONT-005** Out-of-range values (`#font-weight-prop` [1,1000], `#font-style-prop` [-90deg,90deg]) stay invalid
  and never delete the previous declaration. **FAIL**: `font-weight:100;font-weight:0` → `font-weight:0`;
  `italic;oblique 100deg` → `oblique 100deg` (verified). Probe `font/sft-font-weight-zero-keeps-fallback`.
- **INV-FONT-006** Out-of-range calc() clamps before unwrapping. **FAIL**: `oblique calc(100deg)` → `oblique 100deg`,
  `calc(1001)` → `1001` (verified). Probe `font/sft-oblique-calc-out-of-range-clamped`.
- **INV-FONT-007** A CSS-wide keyword in a family list invalidates it; `font-family: inherit` never folds into `font`.
  **FAIL**: CSS-wide keywords are `GenericFontFamily` variants (`font.rs:312-325`): `foo, inherit` is typed,
  `font:12px inherit` accepted, `font:12px serif;font-family:inherit` → `font:12px inherit` (cf. #1214 transition; verified).
  Probe `font/sft-font-family-css-wide-in-list-keeps-fallback`.
- **INV-FONT-008** Unquote only when the identifiers re-join to the same string and none is a generic, system-font or
  CSS-wide word. **FAIL** for `" lead"`, `"trail "`, `"Serif Gothic"`, `"inherit test"`, `"revert-rule"` (verified;
  whole-string check `:423`, `revert-rule` missing, EM-70); double spaces fixed by #1064 (`:425`). Probe
  `font/sft-font-family-leading-space-stays-quoted`.
- **INV-FONT-009** Duplicate families can be load-bearing: lone `monospace` selects the 13px default size
  (`#generic-font-families`). **FAIL** #1221 (`:926-931`, 41dfaa4 v1.13.0; PR #1250;
  `font/font-family-monospace-monospace-kept`).
- **INV-FONT-010** System font keywords only as the whole `font` (`font: 12px menu` = family "menu"). PASS (`font:menu`
  stays `Unparsed`). Probe `font/sft-system-font-keyword-as-family`.
- **INV-FONT-011** line-height number ≠ %/length; `0px` ≠ `0`. `100%` PASS; `0px` → `0` **FAIL** (also in @keyframes).
  Probe `values-numeric/ssv-line-height-zero-interpolation`.
- **INV-FONT-012** `@font-face` descriptors are not deduped; repeated `src` is a fallback chain. PASS
  (`font/sft-font-face-src-fallback-kept`). **INV-FONT-013** unicode-range normalization keeps the code point set. PASS.
- **INV-FONT-014** `@font-feature-values` accepts `font-display`. **FAIL**: `parse_declarations` is false
  (`rules/font_feature_values.rs:145`), so without errorRecovery the whole stylesheet fails (CLI panics at
  `src/main.rs:196`, verified). Probe `font/sft-font-feature-values-font-display`.
- **INV-FONT-015** Invalid feature values (negative, wrong count) are ignored, not stored over a valid one. **FAIL**:
  any integer list is stored (`:294-306`): `flowing:2;flowing:-1` → `flowing:-1` (verified). Probe
  `font/sft-font-feature-values-negative-index-ignored`.
- **INV-FONT-016** Merge `@font-feature-values` only across identical family lists with nothing overlapping between.
  **FAIL** (`rules/mod.rs:950-961`): `Foo{x:1} Foo,Bar{x:2} Foo{x:3}` → `Foo{x:3} Foo,Bar{x:2}` (verified). Probe
  `font/sft-font-feature-values-merge-keeps-cross-family-order`.
- **INV-FONT-017** A generic family in the prelude invalidates the rule. **FAIL** (`serif` printed `"serif"`, verified).
- **INV-FONT-018** `@font-palette-values` font-family is a list; indexes are unbounded. **FAIL**: single family
  (`rules/font_palette_values.rs:110`, `A, B` dropped); `u16` (`:77`, `:89`, casts `:191`, `:230`): `70000` → `4464`
  (verified). Probe `font/sft-font-palette-values-large-integers`.
- **INV-FONT-019** `override-colors` stay absolute, fallbacks in the right space. **FAIL**: LAB branch reuses P3
  (`:280-281`; safari 15: `color(display-p3 …)` there, `lab(…)` in `color`, verified); `light-dark()` → `var()`.
- **INV-FONT-020** `from-font`, `font-size: math`, `palette-mix()` never folded; **INV-FONT-021** feature tags keep
  quoting and case. Both untyped.

### 2.3 Conformance on master (T typed, P partial, U passthrough)
| Item | Status | Deviations |
|---|---|---|
| `font` | T `font.rs:660-801`; FontHandler `:818-995` | folds when all 7 are set (`:934-964`); mid-block flush only for an incompatible new value (`:839-845`) or an `Unparsed` font property (`:881-887`) |
| family / weight / style / stretch | T `:383`+`:414-448` / `:68-75` / `:469` / `:242-279` | dedupe `:926-931`; no ranges; `normal`/`bold` → `400`/`700` when minifying; `oblique 14deg` → `oblique`; stretch keyword → % when minifying (`:269-272`) |
| caps, line-height, size / vertical-align, font-palette | T `:542`, `:596`, `:159` / P `:653`, `mod.rs:1449` | `math`, L3 vertical-align, `light/dark`, `palette-mix()` U |
| other font-* longhands, font-width | U | pushed at once: reordered before a buffered `font`/`font-stretch` (#1207, #1234) |
| `@font-face` | T `rules/font_face.rs:449-486` | an `src` with an unparsable entry stays raw (forgiving); unknown descriptor names written raw (`:570-573`, EM-04: `fake\7d name` → `fake}name` closes the block) |

### 2.4 Engine divergences (oracle)
- `font-family` read-back quoting differs per engine (WebKit ≤ 16.4 prints `"serif"` bare): compare name lists, keep a
  quoted generic distinct (L3, `references/browsers.md` G1). `oblique 14deg` → `oblique` (Firefox/WebKit), `italic`
  (Chromium ≤ 110) (G6). Chrome lists `font-stretch`, Firefox 157/WebKit 27.2 `font-width`.
- The WPT container sets `font:16px serif` (`oracle/engine-runner.cjs:258`), hiding the monospace quirk: only probes see #1221.
- WPE renders `-apple-system`/`system-ui` as the fontconfig fallback (L4): assert on output.
- Compat (chrome/firefox/safari): font-stretch % 62/61/11.1; width keywords in `font` 60/43/11; system-ui 56/92/11;
  font-width ✗/155/18.4; `@font-feature-values` 111/34/9.1 (its `font-display`: none).

### 2.5 Lowering semantics
- Stretch keyword → % in minify mode for every target: never needed, invalid inside `font`, rejected by Chrome < 62
  (`font-stretch:condensed`, chrome 60 → `75%`, verified). An exact fallback keeps the keyword.
- `system-ui` gets `-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Noto Sans,Ubuntu,Cantarell,Helvetica Neue` after
  it when `FontFamilySystemUi` must be compiled, once per block (`:916-918`, `:999-1033`), then the list is deduped
  (history: FONT-04).
- `@font-palette-values`: RGB/P3 copies of `override-colors` before the final list (`:261-287`).
- Not lowered: `font-width` ↔ `font-stretch` (#1234), font-variant-* → font-feature-settings.

### 2.6 Spec changes since 2023 that LightningCSS lags
fonts-4: `font-style: left|right` (9392), `oblique-only` (9390), `khmer-mul`, `palette-mix()` list (14452), last
`@font-palette-values` wins (12981), absolute override-colors (9555), `font-width`. fonts-5: font-size-adjust metrics +
`from-font`, 2-value metric overrides (2nd defaults to `normal`), sup/sub overrides (2nd = 1st), `avar2` (10599).

## 3. Text and decoration (`text`)

### 3.1 Grammar essentials
- `white-space` (`text-4#white-space-property`) = legacy keywords | collapse || wrap-mode || trim; `text-wrap`
  (`#text-wrap-shorthand`) = mode || style: text-wrap-mode belongs to **both**, so their order matters.
- `text-align` (`#text-align-property`) is a shorthand resetting text-align-last. `tab-size` `<number> | <length>`.
- `text-decoration-line` (`text-decor-4#text-decoration-line-property`) = `none | [ underline || overline ||
  line-through || blink ] | spelling-error | grammar-error`.
- `text-decoration` (`#text-decoration-property`) = line || thickness || style || color (L3: no thickness); omitted
  line = `none` (`dotted red` is valid); thickness `%` is of 1em. `text-underline-position: left` implies `auto`.
- `text-emphasis-style` (`#text-emphasis-style-property`): fill without shape = circle (horizontal) or sesame
  (vertical). `text-emphasis-position` `[over|under] && [right|left]?`, omitted side = right (one-keyword form: Firefox
  108; older engines UNVERIFIED).
- `text-shadow` (`#text-shadow-property`) L4 adds spread and `inset`; no engine supports either.
- `text-box` (`inline-3#text-box-shorthand`): omitted trim = trim-both, so `none` is significant.

### 3.2 Invariants (master status, probes)
- **INV-TEXT-001** `text-decoration` prints every non-initial component, also with line `none`/omitted. **FAIL**:
  `ToCss` returns after an empty line (`text.rs:780-783`): `none red`, `dotted red`, `from-font`, `10px` → `none`
  (verified). Merges keep the color (`none red;text-decoration-line:underline` → `underline red`); the loss shows in
  the computed color/style/thickness. Probe `text/arch-props-values-text-decoration-none-drops-color`.
- **INV-TEXT-002** `text-emphasis` keeps the (inherited) color with style `none`. **FAIL** (`text.rs:998`). Probe
  `text/sft-text-emphasis-none-keeps-color`.
- **INV-TEXT-003** Line keywords once each; `none`/error values alone. **FAIL**: bitflag OR (`text.rs:495-532`), `ToCss`
  `:543-549`: `none underline`, `underline underline` → `underline`, `spelling-error underline` → `spelling-error`, each
  deleting the earlier declaration (verified; WPT invalid-became-valid ×5). Probe
  `text/sft-text-decoration-line-none-combo-keeps-fallback`.
- **INV-TEXT-004** A value no target parses never replaces one it does. **FAIL**: typed spread (`:1389-1399`) and
  `Unparsed` `inset` overwrite the earlier text-shadow (verified). Probe `text/sft-text-shadow-spread-keeps-fallback`.
- **INV-TEXT-005** Thickness enters the shorthand only if every target supports it. PASS (`:1237`; probe
  `text/sft-text-decoration-thickness-shorthand-old-safari`).
- **INV-TEXT-006** No shape added to a fill-only emphasis style. PASS (`text/sft-text-emphasis-style-fill-only`).
- **INV-TEXT-007** white-space / text-wrap / text-wrap-mode keep their order. PASS, untyped (`text/sft-white-space-text-wrap-order`).
- **INV-TEXT-008** `tab-size: 0px` stays a length. **FAIL** (`length.rs:493`). Probe `text/sft-tab-size-zero-length-stays-length`.
- **INV-TEXT-009** text-align resets text-align-last: keep their order (not observable yet).
- **INV-TEXT-010** `text-box: none …` keeps `none`. PASS, untyped (`text/sft-text-box-none-trim-kept`).
- **INV-TEXT-011** `text-emphasis-position: over` ≡ `over right` only where one keyword parses. Master always shortens
  (`:1086-1098`; firefox 78 → `over`, verified). No probe.
- Also (class A, verified): `text-transform:` → `none` (`:167-197`; probe
  `text/arch-props-values-empty-text-transform-becomes-none`); `text-decoration:` → `none`, deleting an earlier
  `text-decoration:underline` (zero components accepted, `:740-773`). #981: a non-px zero blur/spread is printed
  (`!= NonNegative::zero()`, `:1438-1446`), giving a 4-length shadow Chrome rejects.

### 3.3 Conformance on master
| Item | Status | Deviations |
|---|---|---|
| text-transform / white-space | T (empty accepted) / P `text.rs:220-236` (L3) | `math-auto`, L4 white-space, text-wrap* U |
| tab-size, hyphens, text-align-last, text-size-adjust, skip-ink, text-overflow | T, PrefixHandler (class C) | `0px` → `0`; `-webkit-text-size-adjust` only for ios_saf (#934) |
| text-align / spacing / text-indent | P `:1174-1195` / P `:361` / T `:378` | `<string>`, `%` U; unitless repaired |
| text-decoration(-*) | T (+ -webkit-/-moz-), handler `:1100-1357` | merges only when line, thickness, style, color are all set (`:1229`); merged prefix = **union** (`:1232`): `-webkit-text-decoration-line:underline` + unprefixed initial thickness/style/color → `-webkit-text-decoration:underline;text-decoration:underline`; a non-initial style/color drops `-webkit-` unless a target needs it (verified; engine effect UNVERIFIED) |
| text-emphasis* | T (+ -webkit-) | prefix dropped unless side = `right` (`:1346-1353`): `over left`, chrome 90 → unprefixed only (verified) |
| text-shadow | T `:1369-1455` (`inset` → U), FallbackHandler | `.unwrap()` on `to_rgb/to_p3/to_lab` (`:1502`, `:1513`, `:1522`): oklch + currentColor, safari 14 panics at `:1502` (verified; box-shadow sibling fixed by #722/#801, gradients: open PR #1311) |
| `Unparsed` decoration/emphasis | `:1196-1207` | prefixed copies pushed next to an authored one: #872 (a58ea6f v1.19.0) grows per pass (PR #1334) |
| underline-position/-offset, text-box, initial-letter, hyphenate-*, `-webkit-text-fill-color` (#1008) | U | |

### 3.4 Engine divergences (oracle)
- `text-emphasis: filled` reads back `dot` (Chrome, WebKit 16.4), `circle` (Firefox, WebKit 27.2), `filled dot` (WebKit 15.4).
- `-webkit-text-decoration` is a WebKit alias only; Safari < 26.2 parses style/color in the shorthand only prefixed
  (legacy WebKit 15.4/16.4 also lack % and thickness in the shorthand).
- `-webkit-hyphens`: WebKit only; `-moz-tab-size`: Firefox alias; `-webkit-text-size-adjust`: rejected by WPE (L4).
- Thickness `%` lowering changes the computed value (`10%` vs `calc(1em/10)`), not rendering.
- Compat (chrome/firefox/safari): style/color in shorthand 57/6/26.2; thickness in shorthand 87/70/26.2; thickness %
  87/74/17.4; spelling/grammar-error 121/137/26.2; text-emphasis unprefixed 99/46/7.

### 3.5 Lowering semantics (prefix ranges: `src/prefixes.rs`)
- `-webkit-text-decoration` + unprefixed for Safari/iOS 8-26.1 when style/color is non-initial; longhands `-webkit-`
  (Safari ≤ 12), `-moz-` (Firefox ≤ 35). Thickness split out without `TextDecorationThicknessShorthand`; `%` →
  `calc(1em/N)` without `TextDecorationThicknessPercent` (`text.rs:1303-1318`). No L3 fallback (#1153): chrome 50 gets
  `underline dotted red;text-decoration-thickness:2px`, which Chrome < 57 drops whole (verified).
- `-webkit-text-emphasis*` Chrome/Edge ≤ 98, Safari 6.1-7; `-webkit-hyphens` Safari/iOS ≤ 16.6, `-moz-` Firefox ≤ 42;
  `-moz-tab-size` Firefox ≤ 90; `-moz-text-align-last` Firefox ≤ 48; `-moz-text-size-adjust` every Firefox, `-webkit-`
  iOS ≥ 5 only.
- `text-align: start|end`: only IE is lowered, to `:not(:is(:lang(…)))` rules IE cannot parse (verified).
- Not lowered: white-space L4 → L3, text-wrap → white-space, `initial-letter` → `-webkit-initial-letter` (Safari's only
  form; check `initial-letter: 3 drop`, which `-webkit-` lacks).

### 3.6 Spec changes since 2023 that LightningCSS lags
text-4: `avoid-short-last-line` (11283), `trim-both` (10161), `math-auto` (5386), white-space fully a shorthand.
decor-4: `text-decoration-inset`, `<line-width>` thickness, shadow spread/inset, skip shorthand. inline-3: two-value
`<text-edge>` (10703), vertical-align includes baseline-source.

## 4. Writing modes and logical (`logical`)

### 4.1 Model
- `writing-modes-4#logical-to-physical`: horizontal-tb: block-start top, inline-start left (ltr) / right (rtl);
  vertical-rl: block-start right, inline-start top (ltr); vertical-lr: block-start left.
- `logical-1#box`: paired properties "share a computed value … determined by cascading the declarations of both
  properties together as one", paired by the element's **own** writing mode, so order decides:
  `margin-inline-start:1px; margin-left:2px; margin-inline-end:3px` → margin-left 2px (ltr), 3px (rtl). Logical
  longhand inheritance is open (Issue 3029). float/clear `inline-*` use the containing block (`#float-clear`),
  caption-side the table wrapper (`#caption-side`).
- `:dir()` (`selectors-4#the-dir-pseudo`) follows `dir`, not language.

### 4.2 Invariants (master status, probes)
- **INV-LOGICAL-001** Lowering uses the element's writing mode (`logical-1#position-properties`). **FAIL by design**:
  `writing-mode:vertical-rl;inset-block-start:5px` (chrome 80) → `top:5px`; `block-size` → `height` at chrome 50 (verified); EM-67
  (postcss-logical has options; LightningCSS documents nothing). Probe `logical/sft-vertical-writing-mode-inset-block-lowering`.
- **INV-LOGICAL-002** Direction comes from `dir`, not language. **FAIL by design** (19-language `:lang()` heuristic,
  `website/pages/transpilation.md:412-430`). Probe `logical/sft-dir-attribute-without-lang`.
- **INV-LOGICAL-003** Pairs keep order, specificity, `!important`. **FAIL**: order #1179 (the example above gives
  margin-left 1px in ltr, verified), specificity #1018, `!important` dropped (`context.rs:84-87`, `:111`; verified).
  Probe `logical/dir-fallback-preserves-declaration-order`.
- **INV-LOGICAL-004** A logical `inherit` inherits the parent's logical value; master emits `margin-left: inherit`
  (verified), which differs when directions differ (engines UNVERIFIED). **INV-LOGICAL-005** float/clear `inline-*`
  lowering needs the containing block (not lowered). **INV-LOGICAL-006** SVG legacy `writing-mode` values and the
  `tb; vertical-rl` fallback pair survive (`writing-modes-4#svg-writing-mode-css`; PASS, untyped, verified).

### 4.3 How LightningCSS lowers (master)
- Decision: `should_compile_logical(Feature::Logical*)` (`context.rs:74-82`, flag `LogicalProperties`), never in style
  attributes (`:77`). Thresholds (chrome/firefox/safari, `compat.rs`): Margin/Padding/Borders 69/41/12.1, Size
  57/41/12.1, Inset 87/63/14.1, *Shorthand 87/66/14.1, BorderRadius 89/66/15, TextAlign 18/4/3.1 (IE); DirSelector
  120/49/16.4; LangSelectorList Safari ≥ 10.1 only (`build-prefixes.js:461-465`). scroll-margin/-padding have no
  feature (never lowered).
- `side_handler!` (`margin_padding.rs:170-415`): flush on logical↔physical change (`:190-199`) and before a repeated
  `Unparsed` logical value (`:210-221`); block axis → physical in place as horizontal-tb (`:377-378`, `size.rs:591-596`);
  inline start == end → left/right in the base rule (`:384-386`), else `add_logical_rule`. var() longhands keep the var()
  (`with_property_id`); var() logical shorthands are pushed verbatim (`:279-282`; #927, #1070).
- `get_additional_rules` (`context.rs:93-156`) appends `:dir(ltr|rtl)` to each selector (before a pseudo-element),
  **normal declarations only** (`:111`), +(0,1,0) (TODO `:94`); emitted after the base rule, re-minified
  (`rules/mod.rs:821-823`, `:892-896`), before a clone with the nested rules (`:843-862`, e66d99c v1.21.1).
- `:dir()` lowering (`selector.rs:2126-2137`, `:2206-2224`): rtl → `:lang(ae,ar,arc,bcc,bqi,ckb,dv,fa,glk,he,ku,mzn,
  nqo,pnb,ps,sd,ug,ur,yi)` (`:2108-2111`), ltr → `:not(:lang(…))`; without LangSelectorList one `:lang()` per language
  in `:is()`/`:not()`, plus `:-webkit-any()` copies for Chrome < 88 (one rule per prefix, verified).
- `NestedDeclarationsRule::minify` (`rules/nesting.rs:73-84`) fills the side lists; only the `CssRule::Style` arm drains
  them (not `rules/mod.rs:928-932`): dropped (#1023, #1049) or attached to the next sibling (#1246: `.p{.c{}
  margin-inline-start:1px; .d{}}` → `.p .d:not(:lang(…))`, verified). 6c465c1 (v1.30.0); open PRs #1123 (Devon: order
  of rules → declarations → rules?), #1386.
- Not lowered: float/clear `inline-*`, caption-side, overflow-inline/-block (#540). Reordered (class B, verified):
  `overflow` vs `overflow-inline` (N8); `-webkit-margin-start`/`-webkit-logical-width` before the buffered logical
  property; `direction`/`unicode-bidi` vs a later `var()` (#1225, d7aeff3 v1.25.0; PR #1387).
- History: #131 replaced PR #30's custom-property toggles (IACVT; `[dir]` breaks nested directions).

### 4.4 Engine divergences (oracle)
- Oracle page = `<html lang="en">`, no `dir` (`oracle/engine-runner.cjs:22`): only LTR horizontal-tb runs unless a probe
  has `dom: <div dir="rtl" lang="ar" class="t">x</div>` or sets `writing-mode`.
- `:dir()` → `:lang()` is never equivalent for `dir=rtl` without an RTL lang (or `lang=ar` with `dir=ltr`): classify
  against the documented heuristic unless the PR changed it.
- Chromium 156 rejects `:lang()` lists and quoted ranges (Firefox, WebKit accept); Safari-only targets get the list
  form, which Chromium (outside the targets) drops. `:-webkit-any()` has pseudo-class specificity. WebKit 15.4 parses
  `:dir()` but never matches it.
- Legacy profiles (Chromium 97/110, Firefox 93/108, WebKit 15.4/16.4) all support logical properties, so
  `engine-legacy-*` never runs the `:lang()` fallback: check lowered rules in current engines (O1).

### 4.5 What an exact logical fallback must preserve
In ltr and rtl: (1) the winner in declaration order (#1179); (2) specificity against other rules (#1018; no
specificity-neutral form exists for those targets); (3) importance (N5); (4) the subject (nothing dropped, moved after
nested rules or attached to a sibling); (5) var() shorthands untouched unless provably one component (PR #1227 copies
`inset: 0 var(--x)` into each longhand); (6) `transition-property: inline-size` → `width` in both directions.

## 5. Lists, counters, content, ruby (`ui-misc` overlap)
- **INV-LISTS-001** `list-style` (`lists-3#list-style-property`) re-parses to the same parts; a counter style may be named
  `inside`/`outside`. **FAIL** (default position omitted, `list.rs:414-447`): `outside outside` → `outside`,
  `outside inside` → `inside`, also from longhands (verified). Probe
  `ui-misc/sft-list-style-type-named-like-position`. **INV-LISTS-002** `none` ambiguity PASS since e3b1e88 (#890,
  regression 97891d8 v1.29.0). Probe `ui-misc/issues-b0-list-style-none-ambiguity`.
- **INV-LISTS-003** Counter duplicates are meaningful (`a a` = +2), `reversed(x)` ≠ `reversed(x) 0`
  (`lists-3#propdef-counter-increment`). PASS, untyped (`ui-misc/sft-counter-duplicates-and-reversed`).
- PASS on master: **INV-COUNTER-001** same-name `@counter-style` rules replace atomically, custom names are
  case-sensitive (`counter-styles-3#the-counter-style-rule`); **INV-COUNTER-002** a hex escape in `symbols` eats one
  space; **INV-CONTENT-001** `content` alt text (`/ ""`) and repeated fallbacks survive (`content-3#alt`);
  **INV-RUBY-001** `ruby-position: over` ≠ `alternate over` (`ruby-1#rubypos`, untyped).

## 6. Oracle and WPT coverage
WPT oracle (1.33.0, Chrome, #1328 check, `minify`; 2,184 cases), known noise: css-fonts 1 computed-difference (oblique
14deg, benign) + 5 valid-became-invalid (calc range); css-text tab-size 0px + 2 invalid-became-valid (unitless);
css-text-decor 3 computed-difference (no line) + 8 invalid-became-valid; css-logical 11 unitless sizes; css-lists 1.

Gaps, fill with probes: (1) the fallback check transforms the invalid declaration alone, so class A deletion is
invisible (write `prop: <valid>; prop: <invalid>`); (2) shorthand resets are seeded in the browser only (ordering needs
multi-declaration probes); (3) the font at-rules and `@counter-style` are probe-only; (4) no computed-value cases
(number vs length needs a child via `dom:`); (5) no `dir`/`lang`/`writing-mode`. lcr WPT `print`/`minify` cases use the
`property` adapter kind (no logical lowering); `lower-minify` wraps them in `.t{}` (`lib/lcr/corpus.py:95-103`), LTR
only; `var-before`/`var-after` reuse the fallback value, so read reorders in `lcr show`.
