# Browsers: compat data, vendor prefixes, engine behavior

Read when a PR touches `scripts/build-prefixes.js`, generated `src/compat.rs`/`src/prefixes.rs`, `src/targets.rs`,
`node/browserslistToTargets.js` or prefixing/lowering code, or when `lcr show` has engine diffs to explain. Master
`cbeaf83`; pins BCD 8.0.7, caniuse-lite 1.0.30001806, autoprefixer 10.5.4 (`package.json:51-54`). **(m)** = measured in
the `lcr-browsers` images (§6) via `page.setContent()`; **master** = run on a `cbeaf83` build. C/F/W =
Chromium/Firefox/WebKit, C110 = Chromium 110. Oracle lines: skill files of 2026-10-26.

## 1. How `compat.rs` and `prefixes.rs` are generated

### 1.1 Pipeline (`scripts/build-prefixes.js`, run by hand)

| Input | Feeds |
|---|---|
| `autoprefixer/data/prefixes` | `src/prefixes.rs` ranges `[min,max]` (`:81-147`); tag `2009` → `is_flex_2009()`, `old` on gradients → `is_webkit_gradient()` (`:120-145`, `prefixes.rs:2248-2294`) |
| `caniuse-lite` agents | `Browsers` fields, prefixes (`-o-` for Opera ≤12.1 via `prefix_exceptions`), `latestBrowserVersions` (`:34-43`) |
| `caniuse-lite` features | 32 selector/misc keys (`:165-253`) |
| BCD | 189 `mdnFeatures` keys (`:258-422`) |
| hand-written | `p3Colors`, `LangSelectorList` = Safari 10.1 / iOS 10.3; `TargetCurrent` 135, `TargetBeforeAfter` 142 (Chrome/Edge/Android); `custom-media-queries` = never (`:256`, `:455-477`) |

Outputs: `prefixes.rs`, `compat.rs`, the `Browsers`/`Features` blocks of `targets.rs` (regex splice, `:528-533`),
`node/targets.d.ts`, `node/flags.js`. The locked packages regenerate master's files byte for byte, so an edit
to `compat.rs`/`prefixes.rs` without a script or lockfile change is a hand edit: reject it (B11; open PR #1178 is one).

### 1.2 How source states are read

| State | Treated as |
|---|---|
| caniuse | only an exact `'y'` counts (`:237`), lowest such version over desktop and mobile keys (`:244`). `y #n`, `a`, `y x`, `d` = unsupported |
| autoprefixer `old` tag outside gradients | ignored (`:132`), so `ie 10 old` (`:-ms-input-placeholder`) becomes a plain `-ms-` need |
| BCD `version_added` | lowest entry without `alternative_name`/`flags` (`:433-436`); `[0]` throws if none is left |
| BCD `prefix`, `partial_implementation` | **counted as support**. Only `mediaIntervalSyntax` (`:266-278`) and `statePseudoClass` (`:347-360`) filter partials |
| BCD `version_removed` | ignored (a removed feature stays supported) |
| BCD `false` / `preview` | no entry: incompatible whenever that browser is targeted |
| BCD `alternative_name` | skipped, except the `width: stretch` aliases → `WebkitFillAvailableSize`, `MozAvailableSize` (`:416-422`, #630) |

### 1.3 Known data pitfalls

| id | Pitfall and mechanism | Effect | Status, probe |
|---|---|---|---|
| D1 | BCD mobile keys **overwrite** desktop ones (`:449-450`), so `opera` gets `opera_android` numbers | 151 `opera` thresholds too low (unsafe): lab 97→75, light-dark 109→82, media range 90→71, dvh 94→73. master: `opera 90` keeps bare `lab()`, `opera 80` drops `100vh`, `opera 74` keeps `(width>=600px)`. Chrome/Firefox Android overwrites only raise thresholds | unfiled. `prefixing-compat/opera-desktop-lab-fallback`, `prefixing-compat/opera-desktop-media-range-lowered`, `box-model-size/opera-desktop-dvh-fallback-kept` |
| D2 | prefixed/partial BCD entries count as support | master: `ImageSet` from Chrome 25 / Safari 6 (`compat.rs:2766`) drops the `url()` fallback of `image-set(… type())` up to Chrome 112 / Safari 16.6 and puts `type()` into `-webkit-image-set`. `ColorFunction` from Safari 10.1 (p3/srgb only): no fallback for `color(rec2020 …)` up to 14.1. `AnimationTimelineShorthand` takes Chrome 115 "reset-only" | #1283/#1342; PR #1306 filters partials for that key only (Devon: "partial support should not imply full support"). `gradient-image/image-set-type-fallback-kept`, `color/lowering-rec2020-needs-fallback-for-safari14` |
| D3 | a range stays open only if its newest entry equals `latestBrowserVersions` (`:96`, `:113-117`) | if autoprefixer resolves another caniuse-lite than the script, the newest browser loses the prefix (#325, #925) | clean today: both 1.0.30001806 (`yarn.lock:1514`, `:1662-1664`); re-check on every bump |
| D4 | ranges encode their start (`13.4-13.7` → 13.4) | `ios_saf 13.7` loses a prefix needed to 13.7; `is_flex_2009` ends at `android 4.2` | by design |
| D5 | caniuse squashes Android WebView to "2.1–4.4.4 + latest" | `android 95`: no caniuse prefixes (`-webkit-mask-*`, `background-clip:text`, image-set, …); 21 keys unsupported until `android 150` (over-lowers nesting, `:is()`) | #1180 fixed hex alpha only (#1198); rest unfiled. `prefixing-compat/android-webview-mask-prefix` |
| D6 | `css-marker-pseudo` override (`:210-220`) is dead: caniuse now says `'a #1'` | `.a,.a::marker` split for every Safari/iOS target (valid); #508 regressed | unfiled. `selectors/marker-list-not-split-safari` |
| D7 | mobile agents fold into desktop prefix ranges (`:97`, `:103-117`) | `-moz-text-size-adjust` for every Firefox (`prefixes.rs:1418-1421`); `-webkit-` `stretch`/`box-decoration-break`/`print-color-adjust` for Opera ≥15 | harmless |
| D8 | `P3Colors`/`LangSelectorList` Safari-only (`compat.rs:5790`) | Chrome/Firefox always get an sRGB fallback before `color(display-p3 …)` and a split `:lang(a, b)` (over-lowering; C156 does reject `:lang(a, b)` (m)) | NOTE |
| D9 | autoprefixer data says `moz` for Firefox 48–96 and its hack renames that to `color-adjust`; LightningCSS has no hack | nonexistent `-moz-print-color-adjust` for Firefox 48–96 | `prefixing-compat/print-color-adjust-no-moz-prefix` |

### 1.4 Hard-coded overrides (`build-prefixes.js`)

clip-path drops Safari ≥9.1 / iOS ≥9.3 (`:45-53`, Fyrd/caniuse#6209). `any-pseudo` is synthesized from BCD `:is()`
alternative names (`:55-72`: Chrome 12–87, Firefox 4–78, Safari 5–13). `background-clip: text` adds Safari 13 and iOS
4/13 (`:74-76`). backdrop-filter swaps `ms`→`webkit` (`:90-93`, autoprefixer hack): Edge 17–18 get `-webkit-`.
`:target-current` is Chrome-only (`:467-477`; F157/W27.2 reject it (m)).

### 1.5 What the code consumes

- `Feature::is_compatible` (`compat.rs:237`) is false if a targeted browser is below the minimum **or has no data**;
  empty maps (`CustomMediaQueries`, `FitContentFunctionSize`, `compat.rs:1600`) are always false.
  `is_partially_compatible` (`:5868`, "any one target") only drives Lab/P3 fallback pruning (`color.rs:475`, `:490`).
- No browsers (`targets.rs:226-228`): all supported, nothing lowered, authored fallbacks collapse
  (`color:red;color:lab(..)` → `lab()`), `@custom-media` stays (#1349).
- `should_compile` (`:230-232`) = `include ∋ flag ∨ (exclude ∌ flag ∧ ¬compatible)`. `should_compile_selectors`
  (`:238-241`): excluding one selector bit disables **all** selector compat work (#1375).
- `prefixes()` (`:243-253`) acts only on sets containing the unprefixed form. With browsers it **replaces** the set, so
  an authored prefixed copy no target needs is removed (#396); `include: VendorPrefixes` → `VendorPrefix::all()` (#1371).
- Modes (1.33.0): undefined `targets` keep authored prefix pairs but prune `-webkit-fill-available` (#826); `{}` (Vite
  `esnext`) strips every authored prefix and splits `.d,.d::-moz-selection`.

**Data PRs** (COMPAT-03/04/05/16/17): also probe `android 95`, `ios_saf` vs `safari` (#922, #934), `opera 74`/`90`,
`samsung`, a Firefox ESR, `targets` undefined/`{}`/real; assert with `output-contains` (most run no engine, §6.2).

## 2. `Browsers` encoding and browserslist mapping

- `major << 16 | minor << 8 | patch` per field `android, chrome, edge, firefox, ie, ios_saf, opera, safari, samsung`
  (`targets.rs:32-42`).
- Script (`:695-707`), JS (`node/browserslistToTargets.js:35-46`) and Rust (`targets.rs:133-149`) keep the range
  start and skip `TP`/`all`; only Rust masks each part `& 0xff` (`:144`).
- `Features` (`targets.rs:155-180`): bits 0–20; groups `Selectors` 0–4, `MediaQueries` 6–8, `Colors` 10–15+20.
  Nothing else can be included or excluded.

| Key | caniuse (`:9-21`) | BCD (`:23-32`) | JS `browserslistToTargets` | Rust `from_distribs` (`targets.rs:110-121`) |
|---|---|---|---|---|
| `and_chr` | chrome (min) | `chrome_android` overwrites chrome | kept as `and_chr`, ignored natively | chrome (min) |
| `and_ff` | firefox (min) | `firefox_android` overwrites | ignored | firefox (min) |
| `op_mob` | opera | `opera_android` overwrites, Android numbering (D1) | ignored | opera (min) |
| `ie_mob` | ie | – | ignored | dropped |
| `ios_saf` | ios_saf | `safari_ios`, then `webview_ios` overwrites | ios_saf | ios_saf |
| `and_qq`, `and_uc`, `baidu`, `bb`, `kaios`, `op_mini` | skipped | `oculus` skipped | skipped | skipped |

So JS and CLI/Rust differ for one query (#1088, open): for `defaults` the CLI gets `opera 80` (from `op_mob`), JS
`opera 127` plus an ignored `op_mob` (and BCD keys read `opera` in Android numbering, D1).

## 3. Vendor prefixes whose semantics differ from the standard

Prefixes are added only to unprefixed declarations, an unneeded authored duplicate is removed with targets
(#396), and no prefix becomes another; but legacy syntax inside prefixed values **is** rewritten (gradients, 2009 flexbox,
`mask-composite`), where the semantic bugs are (#918, #1107). Prefixed copies print first (`vendor_prefix.rs:22-33`).
Engine codes (m): A alias, S separate property, L linked (last wins), – rejected.

| Prefixed form | How it differs | LightningCSS | Risk, evidence |
|---|---|---|---|
| 2009 flexbox: `display:-webkit-box`, `-webkit-box-orient/-direction/-pack/-align/-flex` | other model: `box-pack` follows `box-direction`; `box-flex` = grow only | only if `is_flex_2009` (Chrome 4–20, Safari 3.1–6.0, Android 2.1–4.2). With targets, `flex-direction` erases authored `box-orient`/`box-direction` (`flex.rs:531-536`); `baseline` unmapped (`flex.rs:285-298`) | Firefox-only targets get `-moz-box-*` but no `display:-moz-box` (`flex-grid-align/firefox-2009-display-moz-box`); the line-clamp idiom loses `box-orient` (`flex-grid-align/webkit-box-orient-dropped-with-flex-direction`, #710). C/W S; F aliases to `-moz-box-*` |
| `-webkit-box-ordinal-group` (from `order`) | initial **1**, positive integers | copies the value (`flex.rs:353-358`) | off by one; `0` and negatives invalid; autoprefixer emits `order+1`. `flex-grid-align/box-ordinal-group-offset-by-one` |
| `-webkit-/-moz-/-o-linear-gradient` | 2011 WD: a keyword names the **start** side; `0deg` = east, counter-clockwise | `convert_to_legacy_direction` (#936, `gradient.rs:90-103`) | #1107 open: minifying authored keywords reverses them (`gradient-image/issues-*-legacy-*`); compact printing reverses generated ones too (master: `to right`, `chrome 20` → `270deg`). `to right` inside the prefix is rejected everywhere (m) |
| `-webkit-radial-gradient` | 2011 WD: `[<position> \|\| <angle>,]? [<shape> \|\| <size>,]?`, no `at` | `vendor_prefix` ignored by parse and print (`gradient.rs:368-415`) | master emits `-webkit-radial-gradient(circle at …)` (`chrome 20`), rejected by every engine in every profile (m). `gradient-image/webkit-radial-gradient-legacy-position` |
| `-webkit-image-set()` | `url()` + `x` only; no strings, `type()` or gradients | prefixed → `url()`, unprefixed → strings (`image.rs:448-470`); `x` forced (`:478-483`); TODO `:474-475` | unprefixed strings break Safari 10.1–13.1 (`gradient-image/image-set-url-kept-for-safari-13`); D2 drops the url fallback; #1286 `x`→`dppx` |
| `:-webkit-any()`/`:-moz-any()` | compound arguments only; specificity of one pseudo-class | only without combinators (`selector.rs:2152-2166`); `:where()` never lowered (#963) | `div:-webkit-any(#t)` loses to `.c.c.c` in C/W; F rejects `:-webkit-any`. `selectors/webkit-any-fallback-specificity` |
| `:-moz-placeholder`, `:-ms-input-placeholder` | **pseudo-classes** (Firefox 4–18, IE 10–11) | emits the three pseudo-elements; the `old` tag is ignored | #1351/#1281: parsed as `:placeholder-shown`, printed under nonexistent names, unprefixed copy added. `selectors/legacy-ms-input-placeholder`, `selectors/ms-input-placeholder-prefix` |
| `-webkit-mask-composite`, `-webkit-mask` | keywords source-over/-out/-in/xor = add/subtract/intersect/exclude | Chrome ≤119, Safari ≤15.2 (15.3 none, D4); `luminance` goes to Safari-only `-webkit-mask-source-type` (`masking.rs:970`) | C A, F –, W L. `effects-masking/mask-composite-porter-duff-mapping` |
| `-webkit-backdrop-filter` | alias | Safari ≤17.6, Edge 17–18 | fallback-slot bugs #537 #695 #1086 #1229 #1327 (`prefixing-compat/backdrop-filter-*`). W L; C/F – |
| `-webkit-text-decoration` | Safari's shorthand ignored thickness until 26.2 | Safari 8–26.1 with style/color | #872. W A; C/F – |
| `-webkit-user-select` (+ `-moz-`, `-ms-`) | WebKit: a **separate, inherited** property; IE `element` ≈ `contain` | all Safari/iOS (open), Chrome ≤53, Firefox ≤68, IE/Edge ≤18 | `contain` unmapped; `-ms-user-select: all` emitted. W S; W ≤16.4 lack the unprefixed form (m) |
| `-webkit-text-size-adjust` (+ `-moz-`, `-ms-`) | iOS text autosizing only | `-webkit-` iOS ≥5 only; `-moz-` any Firefox (D7) | #934: desktop-only targets strip an authored `-webkit-` (`prefixing-compat/text-size-adjust-webkit-ios`). W rejects both forms; F aliases `-webkit-` to `-moz-` |
| `-webkit-box-decoration-break` | WebKit has only this form | Chrome 22–129, Safari ≥6.1 (open) | W rejects the unprefixed form (m). Android 5+ missing (D5) |
| `-webkit-fill-available`, `-moz-available` (`stretch`) | same keyword, different support | `SizeFallback` (`size.rs:301-311`) | #826, #1371. F157 rejects `stretch`, accepts both prefixed forms; F ≤108 reject `-webkit-fill-available`; C/W reject `-moz-available` (m) |
| others | `-webkit-text-emphasis-position` has no horizontal keyword; `-ms-writing-mode` uses `tb-rl`; `position:-webkit-sticky` W only; `-webkit-print-color-adjust` C/W A, F – (m) | emphasis prefix dropped unless horizontal = `right` (`text.rs:1346-1353`; autoprefixer emits `over`); **no** `writing-mode`/`text-orientation`/`font-kerning` prefixing; `-moz-print-color-adjust` (D9) | `transition-animation/ms-keyframes-not-dropped` |

## 4. Engine divergences that matter for the oracle

### 4.1 Resolved values (https://drafts.csswg.org/cssom/#resolved-values)

- **Used** values: colors (`currentcolor` resolved), `line-height` (unless `normal`), sizes/margins/padding of
  rendered boxes, `inset` of positioned boxes, `grid-template-*` (`repeat(3,1fr)` → `100px 100px 100px`),
  `transform` (`matrix()`). `display:none` boxes return computed values (`50%`).
- One context only (800px root, 16px serif, black, ltr, light), so rewrites equal only there are invisible:
  `50%`↔`400px`, `1em`↔`16px`, `currentcolor`↔`#000`, `inherit`↔the parent's value, `100vw`↔`800px`.
- `border-*-width` reads `0px` whenever the style is `none`; `outline-width: medium` reads `3px` with style `none` (latest; legacy `0px`).

### 4.2 Serialization by engine (m)

| Value | C156 | F157 | W27.2 | Legacy drift (L3) |
|---|---|---|---|---|
| legacy colors | `rgb()`/`rgba()`, 8-bit channels and alpha (`.123456` → `0.12`) | same | same | same |
| modern colors | own space, 6 significant digits | same, but **alpha quantized** (`lab(50 20 30 / 0.12)`) | like C | W15.4 keeps `%` in `lab(50% …)` |
| `none` components | dropped in rgb/hsl/hwb | dropped | **kept**: `hsl(none 50% 50%)`; `rgb(none 0 0)` → `color(srgb none 0 0)` | rejected by F108 and all of legacy-2021 |
| `color-mix()`, system colors, registered `<color>: currentcolor` | `oklab(0.504777 …)`; keeps `currentcolor` | `oklab(0.504796 …)`; resolves | like F | compare within one engine |
| numbers (`1e-7`) | `1e-07` | `1e-7` | `0` | W15.4 prints doubles (`0.12345679104328156`) |
| used lengths | 1/64 px (`10.1094px`) | 1/60 px (`10.1167px`) | 1/64, 6 decimals; margins quantized (`1.234375px`) | W16.4 `1.234568px`, W15.4 doubles |
| `transform` | `matrix()`, 6 significant digits | same | 6 decimals (`0.066987`) | W15.4 doubles; `%` uses box heights that differ (18 vs 22px) |
| `font-family` | quotes multi-word names | **keeps the author's quoting** | never quotes, except `"serif"` | W ≤16.4 quote all multi-word names, print `"serif"` bare |
| `font-style` | `oblique 14deg` and `oblique` distinct | `oblique` | `oblique` | C110: both `italic`; C97: `oblique` → `italic`; W15.4 keeps `oblique 14deg` |
| `steps(2,jump-start)` vs `steps(2,start)` | distinct | distinct | distinct | same |
| gradients | double-position stops expanded (`red 0px, red 50%`), so that lowering is invisible; `50%` hint kept; default `in <space>` omitted | same | same | W15.4 prints authored stop colors (`red`) |
| `0%` vs `0` positions | `background-position: 0% 0%` (C enumerates no `-x/-y`) | `background-position-x: 0%` | like F | F93 enumerates all three |
| relative `url(a.png)` under `setContent` | `url("a.png")` | **`url("about:invalid")`** | `url("a.png")` | C97/C110 **`url("")`**; C ≤110 and legacy-2021: `url(#m)` → `url("about:blank#m")` |
| unregistered `--x` (registered: canonical) | verbatim, trimmed, comments removed | same | also `'s'` → `"s"`, escapes | C ≤110 re-serialize tokens; W ≤16.4 print `1.0` as `1` |

Only longhands are enumerated. master makes each rewrite the table exposes: unquoting (`Times New Roman,serif`),
`oblique 14deg`→`oblique`, `jump-start`→`start`, `red,50%,blue`→`red,#00f`, `0% 0%`→`0 0`, `hsl(none 50% 50%)`→`#bf4040`;
in custom properties `calc( 1px`→`calc(1px` and `1.0`→`1` (`custom.rs:544-546` drops the number type flag).

### 4.3 Prefixed and renamed longhands in the enumeration (m)

- Same-engine runs read **every** enumerated property (`engine-runner.cjs:50-52`), so a standalone prefixed longhand
  the output adds is a diff on the element (and descendants, if inherited) in base and head alike: `-webkit-box-orient`
  (C/W) and `-moz-box-orient` (F) for 2009 flexbox; `-webkit-user-select` `text`→`none` and `-webkit-box-decoration-break`
  (W); `-moz-text-size-adjust` (F). `--lightningcss-light/-dark` (`ui.rs:564-576`) are skipped (`compare.mjs:97`, `:107`).
- Renames: lowering reads the reference engine's names. F157/W27.2 enumerate `font-width`, which F ≤108/W ≤16.4 read
  as `''`; F157 enumerates `baseline-shift`/`alignment-baseline`/`baseline-source` for `vertical-align`.
  `compare.mjs:106` skips `''`, but the property still counts as touched (`:85`, `:115`): `equivalent`, nothing compared.

### 4.4 Triage: diffs that come from the oracle, not the PR

`normalize.mjs` merges only numeric noise, color ΔE-OK and custom-property drift (`custom-changed` = `near`); other
spelling changes are `different`. One-engine quirks become an engine split (**O9**), all-engine ones `regressed`
(**O1**/O2), legacy-only drift **O4**, sub-tolerance drift **O5**. Quirks hit base and head alike (`neutral` unless the
PR changes that spelling) but can hide a head regression in a `still-different` case: compare head's diffs with base's.
`ORACLE_NOISE` may cite only L1–L8 (L3 legacy drift, L4 Apple-only, L7 `url()`); other rows need a spec-cited
`ACCEPTABLE_SIDE_EFFECT`/`INTENDED` (A3).

| id | Pattern | Engines | Lands in | Ruling |
|---|---|---|---|---|
| G1 | `font-family` differs only in quoting/whitespace | F; W ≤16.4, F ≤108 lowering | O9; O4 | equal if the family list is unchanged (https://drafts.csswg.org/css-fonts-4/#font-family-name-syntax); quoted generic → bare is real |
| G2 | a §4.3 prefixed longhand only in the output | C/W/F, W, F | O1 or O9 | the prefix taking effect: do the targets need it (COMPAT-10)? Real only if a standard longhand changed too |
| G3 | `steps(n,jump-start)`↔`steps(n,start)`, `jump-end`↔`end` | all | O1 | equal (https://drafts.csswg.org/css-easing-1/#step-easing-functions) |
| G4 | midpoint hint removed (`red, 50%, blue`) | all | O1 | equal (https://drafts.csswg.org/css-images-4/#color-transition-hint) |
| G5 | `0%`↔`0px` in background/mask/object/gradient positions | all | O1 | equal there; **not** in `flex-basis` or `calc()` |
| G6 | `oblique 14deg`↔`oblique` | C156; C ≤110, W15.4 lowering | O9; O4 | equal (https://drafts.csswg.org/css-fonts-4/#font-style-prop) |
| G7 | `none` → number (`hsl(none 50% 50%)` → `#bf4040`) | W | O9 (`missing-component-changed`) | real: W follows https://drafts.csswg.org/css-color-4/#css-serialization-of-srgb; interpolation keeps `none` (INV-COLOR-001) |
| G8 | one color legacy↔modern, or modern → hex (ΔE ≈ 0.001), outside gradients | all | O5 | equal at rest; differs in transitions, hue-space mixing (L5) |
| G9 | a gradient stop switches legacy↔modern | all | O1 | real only if the stops' all-legacy status flips and no `in <space>` is given (https://drafts.csswg.org/css-color-4/#interpolation-space, `gradient-image/gradient-color-mix-stays-nonlegacy`); else over-reported (master: `oklch(…),color-mix(in srgb,red,blue)` → `…,purple`) |
| G10 | lowering: alpha `0.123456` → `0.12` | legacy | `near`, unreported | 8-bit quantization: equivalent |
| G11 | lowering: legacy W picks a `lab()`/`color(display-p3 …)` fallback, the reference is gamut-mapped to sRGB | W15.4, W16.4 | `near` (ΔE ≤ .02) or `different` (.086 for `color(display-p3 0 1 0)`): O4 | equal if the output is the input's exact conversion |
| G12 | custom-property drift (`calc( 1px`→`calc(1px`, `rgb(255,0,0)`→`red`) | all | O5 (`custom-changed`) | judge consumers. **`1.0`→`1` reads `equal`** yet validates `<integer>` uses (`printer-serialization/token-number-type-flag-kept`) |
| G13 | relative `url()` reads `about:invalid` (F) / `url("")` (C ≤110) | F; legacy C | F blind; O4 | L7: trust C156/W, assert with `output-contains` |
| G14 | legacy engine reads `''` for a renamed property (§4.3) | legacy F/W | `equivalent` | no coverage, not a pass: say so |
| G15 | ≤0.002 in s, deg, unitless, `matrix()`; ±1 on integers ≥ 10000; color-named idents | all | `noise` | hides `1ms`→`0s`, `opacity:.001`→`0`, < 0.1° rotations, `z-index:10000`→`10001`, `animation-name: gray`→`grey`: read raw values |

## 5. Playwright WebKit is not Safari

- WebKit trunk + Playwright patches; headless = WPE, headed = GTK, trunk feature flags. `browser.version()` is
  only a label.
- Apple-only CSS is rejected (m): `-webkit-touch-callout`, `-webkit-overflow-scrolling`, `-webkit-text-size-adjust`,
  `-apple-color-filter`, `-webkit-marquee-*`, `-apple-system-*` colors/fonts; `@supports (-webkit-touch-callout: none)` is
  false; `(color-gamut: p3)` false, `env(safe-area-inset-*)` 0px. `-apple-system` parses but renders as the fontconfig
  fallback; WPE form controls.
- Present only in W (m): `-webkit-initial-letter`, `mask-border`, complex `:-webkit-any(.a .b)`, `:matches()`; W and
  C: `-webkit-box-reflect`, `-webkit-mask-box-image`, `corner-shape`. Missing in W: unprefixed `box-decoration-break`,
  `display: list-item block` (C/F have them), unprefixed `initial-letter`, `interpolate-size` (C has them).
- playwright#42986 (WebKit screenshot hang); bundled codecs UNVERIFIED (they pick the `image-set(type())` candidate).

Use WebKit for parsing, cascade and computed values, never for text metrics, form controls or iOS-only properties
(#934 is data review only). Real Safari needs wpt.fyi results or `safaridriver` on macOS.

**Old labels lie (m).** legacy-2021's WebKit "15.4" (r1564, an Oct 2021 trunk) **lacks** `:has()`, `oklch()`/`oklab()`,
`dvh` and `:focus-visible`, which Safari 15.4 shipped and LightningCSS treats as supported there; it also parses
`:dir(rtl)` without ever matching it. Gating compares the label (`compare.mjs:240`), so a `safari 15.4` target runs this
engine on unlowered output and both sides read rejected/different (L4). Use `safari 15.5`+ (skips it) or ≤ `15.3`
(lowered). WebKit "16.4" (r1767) matched BCD's Safari 16.4 on every feature measured.

## 6. Engine profiles (`config/engines.json`)

### 6.1 What each profile lacks (m: CSSOM acceptance)

| Profile | Image | Engines (Node) | Lacks |
|---|---|---|---|
| `latest` (reference) | `lcr-browsers:pw-1.64.1-analysis` | Chromium 156.0.8078.4, Firefox 157.0, WebKit 27.2 (24) | **C:** `font-width`, `:lang(a, b)`, `-moz-available`. **F:** `width: stretch`, `animation-timeline`, `:-webkit-any()`, unprefixed `text-size-adjust`, `-webkit-box-decoration-break`, `-webkit-print-color-adjust`. **W:** unprefixed `box-decoration-break`, both `text-size-adjust` forms, `-moz-available`, `display: list-item block` |
| `legacy-2023` | `lcr-browsers:pw-1.30.0` | Chromium 110.0.5481.38, Firefox 108.0.2, WebKit 16.4 r1767 (16) | **all:** nesting, `light-dark()`, `@scope`, `@starting-style`, `text-wrap: balance`, `animation-timeline`, `width: stretch`. **C, F:** lab/lch/oklab/oklch, `color()`, `color-mix()`, relative color, gradient `in <space>`, `:nth-child(of S)`, `:lang(a, b)`, `round/mod/abs/sign/hypot`. **C:** `sin()`, `:dir()`, unprefixed `image-set()`/`mask-image`/`print-color-adjust`, `display: inline flex`. **F:** `none`, `:has()`, `@container`, `cqw`, `lh`, `@property`, `-webkit-fill-available`. **W:** unprefixed `user-select`/`backdrop-filter`/`box-decoration-break`, `%` and shorthand `text-decoration-thickness`, `image-set(type())` |
| `legacy-2021` | `lcr-browsers:pw-1.16.3` | Chromium 97.0.4666.0, Firefox 93.0, WebKit 15.4 r1564 (14) | all legacy-2023 gaps, plus **C:** `@layer`, `:has()`, `@container`, `dvh`, media range/interval/`not (…)`, `translate/rotate/scale`, `hwb()`, `:autofill`, `none`. **F:** `@layer`, `dvh`, media interval (range works), `hwb()`, `color-scheme`, `print-color-adjust`, `backdrop-filter`, `sin()`. **W:** oklab/oklch, `color-mix()`, relative color, gradient spaces, `none`, `:has()`, `:focus-visible`, `@container`, `@property`, `dvh`, media range/interval/`not (…)`, `overflow: clip`, unprefixed `mask-image`; `:dir()` parses, never matches |

`legacy-2020` (Playwright 1.4.2: C86, F80, W14) is optional, not buildable yet (bionic, Node 12). Prefixed fallbacks
the legacy engines exercise: C110/C97 `-webkit-mask-*`, `-webkit-image-set`, `-webkit-print-color-adjust`,
`-webkit-box-decoration-break`; W16.4/W15.4 `-webkit-user-select`, `-webkit-backdrop-filter`, `-webkit-text-decoration`
with thickness, `-webkit-box-decoration-break`; F108/F93 `-moz-available`.

### 6.2 When a legacy engine runs (`compare.mjs:236-243`)

Only cases with targets, and an engine only if the targets name its family (`chrome`/`firefox`/`safari`, `:42`) at a
version ≤ the engine's label (else `engine-not-in-targets` / `engine-older-than-targets`). It reads only the properties
its family's reference engine saw the input touch. Legacy `regressed` feeds O4; legacy `near` is not reported.

| Targets (`config/modes.json`) | Modes | Legacy engines that run |
|---|---|---|
| `legacy-2020`: chrome 80, edge 80, firefox 78, safari 13.1, ios_saf 13.4, samsung 12 | `lower`, `lower-minify` (also WPT) | all six |
| `baseline-2022`: chrome 109, firefox 115, safari 15.6, … | `lower-baseline` (real-world lane) | C110 and W16.4 (F108 < 115) |
| `modern`: chrome 120, firefox 121, safari 17.2, … | `lower-modern` | none |
| probe `targets:` | as declared | only `chrome`/`firefox`/`safari` select an engine (`ios_saf`, `opera`, … none) |

No profile shows old-engine semantics of 2009 flexbox, `-webkit-gradient()`, legacy gradient directions/positions,
`:-webkit-any` specificity, IE/old Edge or non-family targets (D1, D5, #918, #1107), and modern engines ignore a prefixed
copy before the standard one: use `output-contains`/`output-not-contains` probes.
