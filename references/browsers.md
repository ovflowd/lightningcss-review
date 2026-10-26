# Browsers: compat data, vendor prefixes, engine behavior

C/F/W = Chromium/Firefox/WebKit.

## 1. Compat data

`build-prefixes.js` (run by hand) turns autoprefixer data into `prefixes.rs` ranges (tag `2009` → `is_flex_2009`,
gradient `old` → `is_webkit_gradient`), caniuse-lite + BCD into `compat.rs` minimums, and splices `targets.rs`
`Browsers`/`Features`, `node/targets.d.ts`, `node/flags.js`. Locked packages regenerate them byte for byte, so a
generated-file edit without a script or lockfile change is a hand edit: reject it.

How sources are read:
- caniuse: only an exact `y` counts (not `a`, `y #n`, `y x`, `d`); lowest over desktop and mobile keys.
- BCD: `prefix` and `partial_implementation` **count as support** (few keys filter them); `version_removed` is
  ignored; `false`/`preview` = never compatible; `alternative_name` skipped except the `stretch` aliases.
- autoprefixer `old` outside gradients is ignored: `:-ms-input-placeholder` becomes a plain prefix need.

| id | Mechanism | Effect, probe |
|---|---|---|
| D1 | BCD mobile keys overwrite desktop: `opera` gets `opera_android` numbers | desktop Opera thresholds too low: `lab()`, media range, `dvh` not lowered (`prefixing-compat/opera-desktop-*`, `box-model-size/opera-desktop-dvh-fallback-kept`) |
| D2 | prefixed/partial entries count as support | `image-set(type())` loses its `url()` fallback; `color(rec2020 …)` gets none where only p3 shipped (`color/lowering-rec2020-needs-fallback-for-safari14`); Partial must not imply full |
| D3 | a range stays open only if its newest entry equals the script's latest version | autoprefixer on another caniuse-lite: the newest browser loses the prefix |
| D4 | ranges store their start (`13.4-13.7` → 13.4) | a later version in the range loses a needed prefix |
| D5 | caniuse squashes Android WebView to old + latest | `android <latest>` gets no caniuse prefixes and over-lowers (`prefixing-compat/android-webview-mask-prefix`) |
| D6 | hard-coded overrides go stale | `selectors/marker-list-not-split-safari` |
| D8 | `P3Colors`, `LangSelectorList` are Safari-only | C/F get an sRGB fallback, split `:lang(a, b)`: valid |
| D9 | autoprefixer hacks LightningCSS lacks | nonexistent `-moz-print-color-adjust` (`prefixing-compat/print-color-adjust-no-moz-prefix`) |

How `src/targets.rs` uses it:
- `Feature::is_compatible` is false if a target is below the minimum **or has no data**; empty map = never.
  `is_partially_compatible` (any one target) only prunes Lab/P3 fallbacks.
- No browsers: nothing lowered, authored fallbacks collapse (`color:red;color:lab(..)` → `lab()`). `targets: {}`
  also lowers nothing but strips authored prefixes; undefined keeps authored prefix pairs.
- `should_compile` = included, or (not excluded and not compatible). Excluding one selector bit disables all
  selector compat work.
- `prefixes()` acts only on sets with the unprefixed form and **replaces** them: an authored prefix no target
  needs is removed.
- JS `browserslistToTargets` ignores `and_chr`/`and_ff`/`op_mob`, Rust `from_distribs` folds them in.
  `Features` bits are public API: new bits only.

Data PRs: probe `android`, `ios_saf` vs `safari`, desktop `opera`, `samsung`, targets undefined/`{}`/real with
`output-contains` (§4: most run no engine).

## 2. Prefixes whose semantics differ

Prefixes are added only to unprefixed declarations, but legacy syntax **inside prefixed values is rewritten**
(gradients, 2009 flexbox, mask-composite): that is where the bugs are. Prefixed copies print first, and modern
engines ignore a prefixed copy before the standard one, so the oracle is blind: assert the output text.

| Form | Differs from the standard | Check |
|---|---|---|
| 2009 flexbox (`-webkit-box`, `box-orient/-direction/-pack/-align/-flex`) | `box-pack` follows `box-direction`; `box-flex` = grow only; no `baseline` | `flex-direction` must not erase authored `box-orient` (line-clamp); Firefox also needs `display:-moz-box` (`flex-grid-align/webkit-box-*`, `firefox-2009-display-moz-box`) |
| `-webkit-box-ordinal-group` | initial 1, positive integers | must be `order + 1` (`flex-grid-align/box-ordinal-group-offset-by-one`) |
| `-webkit-/-moz-/-o-linear-gradient` | a keyword names the **start** side; `0deg` = east, counter-clockwise | authored keywords not reversed, generated angles right (`gradient-image/legacy-prefix-direction-inverted`, `*legacy*keyword*`) |
| `-webkit-radial-gradient` | `[<position> \|\| <angle>,]? [<shape> \|\| <size>,]?`, no `at` | `at` inside the prefix is rejected (`gradient-image/webkit-radial-gradient-legacy-position`) |
| `-webkit-image-set()` | `url()` + `x` only | keep `url()` (`gradient-image/image-set-url-kept-for-safari-13`, `image-set-type-fallback-kept`) |
| `:-webkit-any()`, `:-moz-any()` | compounds only; one pseudo-class's specificity | `selectors/webkit-any-fallback-specificity`; F rejects `-webkit-` |
| `:-moz-placeholder`, `:-ms-input-placeholder` | **pseudo-classes** | `selectors/*ms-input-placeholder*` |
| `-webkit-mask-composite` | `source-over/-out/-in`, `xor` = add/subtract/intersect/exclude | `effects-masking/mask-composite-porter-duff-mapping` |
| `-webkit-backdrop-filter` | alias Safari needs | fallback survives merging in both orders (`prefixing-compat/backdrop-filter-*`) |
| `-webkit-user-select` | W: separate, inherited; IE `element` ≈ `contain` | every Safari/iOS keeps it; no `-ms-user-select: all` |
| `-webkit-text-size-adjust` | iOS only | desktop targets keep an authored copy (`prefixing-compat/text-size-adjust-webkit-ios`) |
| `-webkit-fill-available`, `-moz-available` | `stretch`, support differs | F rejects `stretch`, takes both prefixes; C/W reject `-moz-available` |

## 3. Engine divergences in oracle results

Resolved values (https://drafts.csswg.org/cssom/#resolved-values) are used values for colors, `line-height`,
box sizes/margins/padding/inset, `grid-template-*`, `transform` (`matrix()`). One context only (800px root,
16px serif, black, ltr, light): `50%`↔`400px`, `1em`↔`16px`, `currentcolor`↔black, `inherit` rewrites are
invisible. `border-*-width` reads `0px` when the style is `none`.

| id | Pattern | Ruling |
|---|---|---|
| G1 | `font-family` quoting only (F keeps author quotes, W never quotes) | equal if the list is unchanged; quoted generic → bare is real (https://drafts.csswg.org/css-fonts-4/#font-family-name-syntax) |
| G2 | prefixed longhand only in the output | the prefix took effect: do targets need it? Real only if a standard longhand changed |
| G3 | `steps(n,jump-start)`↔`start`, `jump-end`↔`end` | equal (https://drafts.csswg.org/css-easing-1/#step-easing-functions) |
| G4 | `50%` midpoint hint removed | equal (https://drafts.csswg.org/css-images-4/#color-transition-hint) |
| G5 | `0%`↔`0` in positions | equal; not in `flex-basis`/`calc()` |
| G6 | `oblique 14deg`↔`oblique` | equal (https://drafts.csswg.org/css-fonts-4/#font-style-prop) |
| G7 | `none` component → number (W shows it) | real (https://drafts.csswg.org/css-color-4/#missing) |
| G8 | legacy↔modern color outside gradients | equal at rest, not in transitions (L5) |
| G9 | gradient stop legacy↔modern | real only if "all stops legacy" flips without `in <space>` (https://drafts.csswg.org/css-color-4/#interpolation-space) |
| G10 | lowering: alpha `0.123456` → `0.12` | 8-bit quantization: equal |
| G11 | legacy W uses the `lab()`/p3 fallback, reference gamut-mapped | equal if the output is the exact conversion |
| G12 | custom-property token drift | judge consumers; `1.0`→`1` reads equal yet changes `<integer>` validity (`printer-serialization/token-number-type-flag-kept`) |
| G13 | relative `url()` reads `about:invalid` (F) / `url("")` (old C) | L7: trust C/W, assert text |
| G14 | legacy engine reads `''` for a renamed property | touched, nothing compared: no coverage |
| G15 | sub-tolerance noise | hides `1ms`→`0s`, `opacity:.001`→`0`, `z-index` ±1, `gray`→`grey`: read raw values |

Precision differs (F alpha quantized, W `1e-7` → `0`, lengths 1/64 vs 1/60 px; old engines print doubles, L3):
compare base with head.

## 4. Playwright WebKit and legacy engines

- WebKit trunk (WPE) is not Safari: Apple-only CSS (`-webkit-touch-callout`, `-webkit-overflow-scrolling`,
  `-webkit-text-size-adjust`, `-apple-*`) is rejected, `(color-gamut: p3)` false, `env(safe-area-*)` 0. Trust it
  for parsing, cascade, computed values; not text metrics or form controls.
- Labels lie: the legacy WebKit "15.4" lacks `:has()`, `oklch()`, `dvh`, `:focus-visible` and never matches
  `:dir()`. A `safari 15.4` target runs it on unlowered output (L4): use `safari 15.5`+ or ≤ `15.3`.
- A legacy engine runs only when targets name its family (`chrome`/`firefox`/`safari`) at a version ≤ its label,
  and reads only what the reference engine saw the input touch. Gaps: `config/engines.json`.
  `lower-baseline` runs C110 and W16.4, `lower-modern` none; `ios_saf`/`opera`/`android` select none.
