# Ecosystem: downstream consumers, other minifiers, Sass

Snapshot 2026-10-25, master `cbeaf83` (v1.33.0 + 14; npm 1.33.0 = crate 1.0.0-alpha.72), from research
`ecosystem-consumers` (consumer code at pinned commits, npm releases on real CSS) and `ecosystem-minifiers` (118
bug classes from 8 tools run on master, Chrome 156 only). Read §1-§3 when the PR touches options, `Features`,
`ParserFlags`, errors, CSS-module exports, dependencies, output shape, `node/` or `package.json`; §5 for the printer,
handlers, nesting, prefixes; §7 for `r-*` deltas. Refs: `#n` = parcel-bundler/lightningcss;
`tw#` tailwindlabs/tailwindcss, `vite#` vitejs/vite, `next#` vercel/next.js, `rspack#`/`rsbuild#` web-infra-dev,
`bun#` oven-sh/bun, `esbuild#` evanw/esbuild. Consumer paths at Tailwind 8cc0551, Vite 82e7aa0, Next cbf49db, Rspack
8a3dc40, Parcel 5948485.

## 1. Reach

| Channel | lightningcss requirement | A merged PR arrives |
|---|---|---|
| Vite 8.2+ (127M dl/wk; Astro, Nuxt, SvelteKit and other Vite frameworks inherit it) | dependency `^1.33.0` (8.0 `^1.32.0`; <= 7 optional peer) | **next npm release** (Vite 8's default CSS minifier) |
| Tailwind v4 `@tailwindcss/node` (60M) | exact `1.32.0` (4.2.2-4.3.3); main `1.33.0` + pnpm patch | when Tailwind bumps |
| Next 16 Turbopack (45M), Rspack / Rsbuild / Docusaurus Faster (5M / 1M / 0.26M) | crate alpha.72, locked; Rspack `default-features = false` + `serde` | when they bump |
| Parcel 2.16 (0.5M), unplugin-lightningcss, @tsdown/css, Lume, postcss-lightningcss, lightningcss-loader | `^1.30.1` to `^1.33.0` | next npm release |
| Rust: styled_jsx, dioxus-cli, minify-html, cargo-leptos (160 reverse deps) | `^1.0.0-alpha.N` (trunk `=alpha.72`) | next alpha on `cargo update`; build breaks land unannounced (#1056) |

npm/crate: 1.30.2 = alpha.68, 1.31.0 = alpha.69, 1.32.0 = alpha.71, 1.33.0 = alpha.72. Unreleased on master (next to
reach Vite 8 users): #1388 (`engines.node >= 24`, C17), #1355 (module export order, C9), #1340, 32aecd9, #1263, 93b9e66.

## 2. Consumers

| Consumer | Call and exact options | Stresses | Must preserve (§3) |
|---|---|---|---|
| Tailwind v4 4.3.3 (`packages/@tailwindcss-node/src/optimize.ts:29-147`) | `transform` **twice**, only pass-1 warnings shown (regex filter L63-76): `drafts.customMedia`, `nonStandard.deepSelectorCombinator`, `include: Nesting\|MediaQueries`, `exclude: LogicalProperties\|DirSelector\|LightDark`, targets chrome 111, firefox 128, safari 16.4, ios_saf 16.4, `errorRecovery: true`; then `@media not (` -> `@media not all and (` (L128). Prod builds only (CLI, vite, postcss, webpack, turbopack) | nesting, media-queries, cascade-layers-scope, supports-container, color, custom-properties, selectors, prefixing-compat, calc-math | C2-C4, C14, C16, C18; `@property` polyfill `@supports` gate verbatim (`supports-container/tailwind-property-polyfill-gates`); the space in `var(--x, )` (tw#20373); prefixed duplicates must not grow per pass (#872, #969) |
| Vite 8 minifier 8.3.5 (`packages/vite/src/node/plugins/css.ts:2289-2368`) | `transform({...css.lightningcss, targets: convertTargets(build.cssTarget), minify: true})`, **strict** unless the user sets `errorRecovery`; targets chrome 111, edge 111, firefox 114, safari 16.4, ios_saf 16.4; empty targets -> `undefined` (L3662) | all user CSS | no new parse error on valid CSS (fails the build); C1, C6, C17 |
| Vite transformer (experimental, L3288-3519) | `bundleAsync` (resolver runs Sass/Less/Stylus), `analyzeDependencies.preserveImports`, `cssModules` for `*.module.*`, `transformStyleAttribute` | bundler, css-modules | C8, C9 |
| Next 16.4 Turbopack (`turbopack/crates/turbopack-css/src/process.rs`) | strip BOM; parse with `error_recovery: true`, modules `[hash]_[local]` with `dashed_idents/grid/container: false`, `CUSTOM_MEDIA` only if included; warnings -> issues by kind (L543-557); `minify(targets)` always, dev too; pure-selector lint (L719-740). `include = MediaRangeSyntax\|Nesting\|user`, `exclude` = user only (L84-89); default chrome 111, edge 111, firefox 111, safari 16.4 | css-modules, selectors, logical, color | C2, C5, C10-C13 |
| Next webpack (`useLightningcss`, `loader.ts:340-410`); styled-jsx (swc-project/plugins `transform_css_lightningcss.rs:37-160`) | webpack: vendored napi port, visitors for `url()`/`@import`/ICSS, `include = 1\|user`. styled-jsx: `ParserFlags::all()` + recovery; minify for chrome 64, edge 79, firefox 67, opera 51, safari 12 (`include: Nesting`, `exclude: IsSelector\|CustomMediaQueries\|VendorPrefixes`), re-parse, minify for user targets (`include: IsSelector`); `.expect()` panics on any `MinifyErrorKind` | visitor-api, nesting | visitor semantics; C3 (styled-jsx gets every new flag), C14; no new `MinifyErrorKind` |
| Rspack 2.x loader + minimizer (crates `rspack_loader_lightningcss`, `rspack_plugin_lightning_css_minimizer`); Rsbuild, Docusaurus Faster | `errorRecovery` default true, **warnings discarded** (loader L102, minimizer L188); include/exclude from a hand-copied enum without `LightDark` (`builtin-loader/lightningcss/index.ts:111-150`); `drafts` = customMedia only; minimizer targets default `'fully supports es6'`, `removeUnusedLocalIdents` -> `unusedSymbols`. Rsbuild: always recovery, chrome/edge >= 107, firefox >= 104, safari >= 16 | parser-syntax (recovery), css-modules, rule-merging | recovery never drops a valid rule silently; deterministic output (GEN-12); `unusedSymbols`; C2; B8 |
| Parcel 2.16.4 (`CSSTransformer.js:81-148`, `CSSOptimizer.js:164-171`) | `transform({cssModules, analyzeDependencies: {preserveImports: true}, drafts, pseudoClasses, errorRecovery: config?.errorRecovery \|\| false, targets})`, `transformStyleAttribute`; optimizer `{minify: true, unusedSymbols}`; browserslist default `> 0.25%` | css-modules, dependencies | C7, C8, wasm build, C17 |
| Astro, Nuxt | Astro: `transform({targets, minify: false})` when cssMinify is off (errors swallowed); `exclude \|= Nesting` per component for scoping. Nuxt: `transform({minify: true})` on inline head CSS | nesting | C1 |
| Rust crates | minify-html, trunk: default options, strict, no targets, keep the input on error; cargo-leptos `Bundler`; dioxus-cli recovery | bindings-api | Rust API (C11), B8 |

### 2.1 Regressions LightningCSS caused (LC ref: downstream; **bold** = still open)

- Tailwind: #1233 (tw#15185), #771/#899 (tw#15897, #17473), #915 (tw#16478), **#1103** (tw#16540, #19417), 32f1f52 +
  #1141/#1142 (tw#17615, #18923, #20371), #1147 (tw#17915), **#618** (tw#18591), **#1378** (tw#19716), #974 (tw#19931,
  fixed unreleased), `calc(infinity * 1px)` as `3.40282e38px` (tw#20125; `2147483647px` since #1200, tw#20381), #1238
  (tw#20275), **#982** (tw#20571), **#872/#969** (3x after two passes, 4x after Vite).
- Vite and frameworks: **#695/#1327/#1086** `backdrop-filter` dropped (vite#22649, #21954), **#1165/#1177** + strict
  default (vite#21911), **#1310** + C1 (vite#23294), #929/**#1351** (vite#23570), **#310** (vite#22381),
  #721/#722 (vite#16461), #1201 (remix-run/react-router#14095), **#1283/#1342/#1369**
  (withastro/astro#17940), C1 (withastro/astro#17647), **#821/#873** (sveltejs/svelte#18902).
- Next: **#1239** (next#75486), #888/#957/#970/#1026/#1185 (next#76632, #93419), **#1049/#1018**
  (next#81763, #82170), **#873** (next#82559), **#1074** (next#85029), **#761** (next#85200), #426 -> #1340 (next#86509,
  unreleased), **#1370** + C5 (next#98261), #1114 (next#90133), **#338** (next#96374), C15 (next#76269).
- Rspack/Rsbuild/Docusaurus: **#338** (facebook/docusaurus#12358: Sass BOM mid-bundle, `@font-face` silently dropped),
  **#1235** (rspack#13937), **#572**/#805 (rspack#7921), #792 (rspack#8405), **#310** (rspack#9370), **#1042**
  (rsbuild#5857), **#780** (rspack#10274).
- Parcel: 9e04c01 (parcel-bundler/parcel#10232), **#310** (parcel-bundler/parcel#8713), **#338**.

## 3. Contracts a PR must preserve

LightningCSS's tests pin none of these. A change to one needs a probe or NEEDS_MAINTAINER_DECISION (GEN-22).

| C | Touched path | Contract | Depends on it | Check |
|---|---|---|---|---|
| C1 | `src/targets.rs` | `targets` undefined = no lowering; `{}` (every browser `None`) also lowers nothing: `is_compatible` only fails for listed browsers (`src/targets.rs:225`), verified on master `.a{.b{color:lab(50% 20 30)}}` → unchanged | Vite `convertTargets` (`css.ts:3662`), Astro copy; vite#23294 | `{}` only via a raw adapter request |
| C2 | `src/targets.rs:156-179`, `node/flags.js` | `Features` bits and groups never move; new features take new bits | Rspack enum copy, Next literal `1 = Nesting` (`loader.ts:370`), Turbopack `from_bits_truncate` (`process.rs:84-90`), Tailwind | B11, bitflags diff |
| C3 | `src/parser.rs:54-60`, `napi/src/lib.rs:666-709` | draft syntax only behind a flag; flags keep meaning | Tailwind/Turbopack set `customMedia` only; Rspack `Draft{custom_media}`; styled-jsx `ParserFlags::all()` | GEN-02 |
| C4 | `src/error.rs:121`, `:279-280` | warning text is API | Tailwind regex `/'(deep\|slotted\|global\|ng-deep\|host-context)' is not recognized as a valid pseudo-/` | grep changed format strings |
| C5 | `src/error.rs:84`, recovery paths | valid CSS under recovery yields no new `EndOfInput`, `UnexpectedToken`, `UnexpectedImportRule` or non-pseudo `SelectorError` | Turbopack turns them into build errors (`process.rs:543-557`): #1137, #1370 | diff `warnings` in `corpus/outputs-{base,head}.jsonl` |
| C6 | `ErrorLocation`, napi | Rust `line` 0-based, `column` 1-based; JS both 1-based | Vite `column - 1` (`css.ts:2364`); styled-jsx `lines[loc.line + 1]` | B5 |
| C7 | `src/error.rs:410,437` | error `data` payloads (`AmbiguousUrlInCustomProperty {url}`) | Parcel `CSSTransformer.js:156` | B5 |
| C8 | `src/dependencies.rs`, `src/values/url.rs:52-56`, `src/rules/import.rs:55` | placeholders print as `url("...")` (double quotes); `@import` placeholders with `preserveImports`; dep types file/glob/url/import | Vite string-replaces them (`css.ts:3482`); vite#18994, #22718 | B5 |
| C9 | `src/css_modules.rs` | export shape `{name, composes[{name,type}]}` and order (#1355 changed it, unreleased) | Vite sorts keys (#291); Next joins `composes[].name`; vite#23735 | B5 |
| C10 | `src/css_modules.rs:30-49` | `pattern`, `dashed_idents`, `grid`, `container` (#835, for Turbopack) | Turbopack `process.rs:493-520` | diff |
| C11 | `selectors/parser.rs:1392` | `Component` variants (public Rust API) | Turbopack's pure-selector lint matches them (`process.rs:719-740`); tw#15614 | B7, semver |
| C12 | stylesheet entry | a leading BOM fails to parse | Next strips it and asserts that (`process.rs:1011-1016`); PR #1301 flips the test (benign) | - |
| C13 | `StyleSheet::minify` | `minify()` performs the CSS-modules transform | Turbopack, also in dev (#935, #1118) | - |
| C14 | printer, lowering | output re-parses strictly with the same options | Tailwind pass 2, then Vite 8; styled-jsx; basecoat fails today (#982, §7) | R2, `nesting/pseudo-element-parent-roundtrip` |
| C15 | printer | output parses in other tools | `[data-theme*=" "]` -> `[data-theme*=\ ]` broke postcss-selector-parser (next#76269) | flag new serializations |
| C16 | `src/selector.rs` | unknown pseudos pass through verbatim with a warning (`:deep()`, `::v-deep`, `:global()`, `::ng-deep`, `:host-context()`) | Tailwind (Vue/Angular), Vite, rspack#8695 | `selectors/framework-pseudo-verbatim` |
| C17 | `package.json` | `engines`, `exports`, `optionalDependencies`; master has node `>= 24.0.0` (#1388; npm 1.33.0 `>= 12.0.0`) | Vite 8 (node `^20.19 \|\| >=22.12`), Parcel (>= 16) take it via caret; Yarn 1 fails on mismatch, npm/pnpm warn | NEEDS_MAINTAINER_DECISION |
| C18 | `node/index.js` | native-binary loader structure | Tailwind's pnpm patch replaces it; tw#14919 reverted an upgrade when it stopped applying | flag any diff |

## 4. Reproducing a consumer in a probe

Headers carry targets, flags and `error-recovery`, not `include`/`exclude`, second passes or string patches (note the
gap in the analysis). Use `mode: lower-minify` with:
- Tailwind: `chrome 111, firefox 128, safari 16.4, ios_saf 16.4`, `flags: error-recovery, custom-media,
  deep-selector-combinator`; `expect: idempotent` runs a pass 2, but only a pass-2 parse error breaks Tailwind (C14),
  further merging is intended. Missing: include Nesting + MediaQueries (forces both lowerings), exclude
  LogicalProperties, DirSelector, LightDark.
- Vite 8: `chrome 111, edge 111, firefox 114, safari 16.4, ios_saf 16.4`, no flags (strict).
- Turbopack: `chrome 111, edge 111, firefox 111, safari 16.4`, `error-recovery` (+ `css-modules`).
- Rsbuild: `chrome 107, edge 107, firefox 104, safari 16`, `error-recovery`; assert output text (warnings unseen).
- styled-jsx pass 1: `chrome 64, edge 79, firefox 67, opera 51, safari 12`, all flags. Bun: `edge 80, firefox 78,
  chrome 80, safari 14, opera 67`. minify-html/trunk: `mode: minify`, no targets, strict.

## 5. Bug classes from other minifiers and transpilers

cssnano 9.9.0, csso 5.0.5, clean-css 5.3.3, esbuild 0.28.2, swc_css, csstools, Autoprefixer 10.6.1, Bun. On master:
15 NEW (no issue), 31 KNOWN, 6 DESIGN, 5 LOW, 58 OK, 3 n/a. The 19 NEW probes fail on master (`equivalent` ones
confirmed in Chrome 156 only).

### 5.1 NEW

| EM | Input -> master output (seen in) | LC site | Probe |
|---|---|---|---|
| 01 | `line-height:1e\32` -> `1e2` (invalid became valid; esbuild#2677) | cssparser `serializer.rs:103-112` via `values/length.rs:513`, `properties/custom.rs:541-546` | `printer-serialization/dimension-unit-e-digit-not-exponent` |
| 03 | `--a: x//**/*y` -> `--a:x/*y}...`, the rest of the sheet is a comment (bun#33683) | `custom.rs:898-902` | `custom-properties/comment-removal-creates-comment-opener` |
| 04 | raw names: `transition-property:fake\7d name` -> `fake}name`, next rule lost; same for unknown at-rule names, `@font-face` descriptors, `@page`, `:hover\:focus` -> `:hover:focus`, media types (bun#31404) | `write_str` at `properties/mod.rs:265`, `rules/unknown.rs:40`, `rules/font_face.rs:571`, `rules/page.rs:290`, `selector.rs:866,870,1305`, `media_query.rs:443` | `printer-serialization/transition-property-ident-escaped`, `at-rules-other/unknown-at-rule-name-escaped`, `at-rules-other/font-face-unknown-descriptor-escaped`, `selectors/custom-pseudo-class-name-escaped`, `media-queries/custom-media-type-name-escaped`, `at-rules-other/page-name-escape-preserved` |
| 05 | `content:"<\/style>"` -> `"</style>"` (inline `<style>`; esbuild#1509) | strings re-serialized unguarded | `printer-serialization/style-end-tag-not-emitted-in-strings` |
| 36 | `light-dark()` in `@property initial-value` lowered to `var()`: registration invalid (csstools) | `values/color.rs:707-716` lowers in any context (`rules/property.rs:40`) | `custom-properties/light-dark-not-lowered-in-property-initial-value` |
| 70 | `font-family:"revert-rule",monospace` -> keyword (esbuild#2135, cssnano 9.2.1) | `properties/font.rs:312-325`, `:423` | `font/font-family-revert-rule-stays-quoted` |
| 80 | `@keyframes "revert-rule"` -> invalid ident prelude (cssnano 9.2.0) | `rules/keyframes.rs:76,106`, `properties/animation.rs:75` | `transition-animation/keyframes-string-name-revert-rule` |
| 81 | `-webkit-animation:k 1s;animation-name:k` -> `animation-name:}` | `animation.rs:968-978` drains `names`, `:1038` prints the leftover | `transition-animation/prefixed-animation-shorthand-unprefixed-longhand-not-emptied` |
| 101 | `::selection{}` + `::-moz-selection{}` -> `::selection` twice, prefix lost, not idempotent; same for every prefixed pseudo pair (clean-css#814) | `rules/mod.rs:1082-1094`, `selector.rs:1189-1197` | `selectors/prefixed-pseudo-merge-keeps-prefix` |
| 110 | `.foo{> &a{}}` -> `.foo>.fooa` (esbuild#3096) | `selector.rs:1478` handles only the first compound | `nesting/relative-amp-type-selector-not-concatenated` |
| 111 | `:host(&){.b{}}`, `::slotted(&)` at chrome 95 -> stack overflow abort (bun#46270) | likely `selector.rs:1702-1714` (argument printed in the printer's context) | `nesting/host-amp-nested-rule-no-stack-overflow` |
| 112 | `:fullscreen{` x 20 at safari 8 -> 357 MB (bun#31270) | `rules/style.rs:212-238` reprints nested rules per prefix | `nesting/prefixed-nested-selector-no-duplication` |
| 113 | `a,b{` x 20 at chrome 100 -> 9.4 MB, exponential where `:is()` would be linear (esbuild#4114) | nesting lowering | - (§5.4) |
| 132 | `color-scheme` lowering repeats `--lightningcss-*` on every pass; cubic merging (cssnano#1747) | `properties/ui.rs:556-580` | `ui-misc/color-scheme-lowering-idempotent` |
| 140 | CSS modules leave `system: extends X`, `fallback: X`, `counter(c, X)` unrenamed (cssnano 8.0.6) | - | `css-modules/counter-style-descriptor-references-renamed`, `css-modules/counter-function-style-argument-renamed` |

### 5.2 KNOWN, DESIGN, LOW, OK

- KNOWN (issue or probe exists): EM-02 `+` dropped in token lists
  (`custom-properties/plus-sign-token-boundary`); 06 BOM (#338); 08 recovery drops earlier declarations (#1358);
  10 precision (#949, #12) and i32 saturation (§7); 21 `line-height:0px`, `flex:1 1 0%`; 22 invalid repaired (#1199);
  23 `calc(-1px)` folded out of range; 26 nested-function backtracking (#1382; calc, `rgb( / `, atan2 paths NEW); 31
  colors rewritten in custom properties; 33 out-of-range `color-mix()` %; 40/41 legacy gradient direction and
  `-webkit-radial-gradient` `at` (#1107); 43 `image-set()` `type()`; 57 `border` resets `border-image`; 61
  `box-ordinal-group` off by one; 68/89 logical lowering with multi-value `var()`, in `transition-property`; 72
  `monospace, monospace` (#1221); 85 `@keyframes` across conditions; 90 `-webkit-mask-composite` hoisted; 92
  `backdrop-filter` (#1086, #695, #1327); 100 merging in an engine-rejected selector; 102 `:is()` specificity (#1324);
  103 `-ms-input-placeholder` (#1281, #1351); 105 non-forgiving lists; 114 `&` under a pseudo-element (#982);
  122/123 range lowering MQ3-parsable (#1361), custom media with negation; 131 `color:blue\9` replaces a valid value;
  134 merging vs `revert-rule`; 144 view-transition names in CSS modules. Probes by issue:
  `grep -rlE '^(known|ref):.*[#/]<n>\b' corpus/probes`.
- DESIGN: EM-07 only leading `/*!` comments kept (`stylesheet.rs:153-170`, #830); 37 `light-dark()` lowering needs an
  ancestor `color-scheme` (`website/pages/transpilation.md:336`); 46 `background:none` -> `0 0` changes computed
  `background-position` `0% 0%` to `0px 0px` (visually identical); 67 logical lowering assumes
  horizontal-tb; 86 3D-to-2D transforms (#1080, PR #1157 closed); 141 module names used through `var()` dangle.
- LOW (ancient targets or no visible effect): EM-11, 56, 62, 94, 97. n/a (LightningCSS does not do the transform):
  EM-66 `-ms-grid`, 135 restructuring, 136 concatenation-assuming transforms.
- OK on master (regression guards): EM-09, 12, 13 (empty custom properties, `u + a`,
  escapes); 20, 24, 25, 27, 28 (`min(0px,10%)`, calc() with `var()`, clamp, `z-index:1000000`); 30, 32, 34, 35, 38
  (no color minification of idents such as `animation-name:white`, gamut mapping, alpha); 42, 44, 45, 47 (gradient
  stops, box keywords); 50-55, 58, 59 (shorthand merging: CSS-wide keywords, `var()`, `!important`, `border:none`,
  gap); 60, 63, 64, 65 (display, line-clamp, grid areas); 71, 73, 74 (font shorthand, quoting); 82, 83, 84, 87, 88
  (animation slots, empty `@keyframes`, `rotate(-90deg)`, individual transforms); 91, 93, 95, 96 (prefix values,
  author fallback pairs); 104, 106, 107, 115-117 (selectors, nesting); 120, 121, 124-128, 130, 133 (at-rule parens,
  dedupe, fallbacks the targets need); 142, 143 (CSS-module names).

### 5.3 Rules learned elsewhere

1. Every name reaching output goes through `serialize_identifier`; token lists keep boundaries (`+`, `/` + `*`,
   comments, `e<digit>` units). Test with `\7d`, `\:`, `\31 `, `e\32`.
2. Every CSS-wide keyword list needs `revert-rule` (css-cascade-5 ED; Chrome 148, Firefox 150, Safari 27):
   `values/ident.rs:35`, `properties/font.rs:312-325`, `rules/keyframes.rs:76,106`, `properties/animation.rs:75`,
   `properties/mod.rs:1684`. None has it at cbeaf83.
3. Buffering handlers emit unmatched properties at once, ahead of buffered shorthands (EM-90), and print empty values
   after draining (EM-81): probe prefixed shorthand + unprefixed longhand in both orders, then a second pass.
4. Generated `var()`, `:is()`, `:lang()`, `@supports` are valid only in some contexts: check `@property initial-value`,
   descriptors, `@keyframes`, `:host()`/`::slotted()` arguments (EM-36, EM-111).
5. Invalid stays invalid: the most common class across cssnano, csso and clean-css (EM-01, EM-22, EM-33).
6. Oracle traps: EM-46, `--lightningcss-*` variables from lowering, and Chrome returning custom property values with
   comments.

### 5.4 Performance generators (no probe format for time budgets)

Master release build, all NEW except #1382: `calc(100vh - ` x n unclosed 0.17 s at n=18, 2.64 s at n=22 (bun#31243);
`rgb(1 2 3 / ` x 22 4.0 s; `hsl(sin(2 -(atan2(9` x 40 > 20 s (bun#31558); `light-dark(` x 18 in a custom property
6.0 s (#1382); `:fullscreen{` x 20 at safari 8 357 MB; `a,b{` x 20 at chrome 100 9.4 MB; 2000 `color-scheme` rules
at chrome 80 1.34 s. For PRs touching `try_parse` chains, nesting lowering or prefix printing, run base and head at
n = 18 and 22: x16 growth per +4 levels is the signal, a new timeout fails R1.

## 6. Bun's port

"A direct port of LightningCSS" (Bun `docs/bundler/css.mdx:17`, 179664e; 61k lines of Rust). 2026: 355 `css` PRs (78
merged, 318 by the bot `robobun`), 44 citing LightningCSS issues. UNVERIFIED: mostly unreviewed, probe first. Cited:
bun#42948 merged (#1235/#1236), #45210 merged (#1340), #46806 (#1361), #46787 (#1032, #1324), #46715 (#949), #45462
(#1023, #1049, #1246). Fuzz tests to replay (`test/js/bun/css/`): `nested-selector-(list-)expansion`,
`nested-vendor-prefix-duplication`, `duplicate-declaration-merge-hang`, `token-list-backtracking`,
`nested-function-backtracking`, `selector-list-error-recovery`.

## 7. Real-world corpus (`r-*`)

25 pinned files (12.6 MB), areas and notes in `config/realworld.json`. Baseline on 1.33.0:
- Strict parse errors by design: foundation (`0\0`, 569:29), tachyons (`*zoom`, 579:15); the lane uses recovery
  (1 warning each). nhsuk: 1 false `EndOfInput` (#1370, C5). primer: 6 warnings without `customMedia`.
- Idempotent: open-props, open-props-media, katex (every profile); primer, wp-block-library, daisyui, tailwind-preflight
  (no targets only). Every other file already changes on a second pass on base, so R2 on an `r-*` case is
  pre-existing unless base was stable for that file and mode: say which in the analysis.
- basecoat lowered for the Vite 8 targets does not re-parse (column 214315; #982, C14).
- v1.32.0 -> v1.33.0 changed 3 files: wp-block-library `text-indent:-10000000px` -> `-9999999px` and daisyui 75x
  `border-radius:3.40282e38px` -> `2147483647px` (#1200), carbon `@position-try` bodies minified (#1238).
  v1.30.2 -> v1.32.0 changed 22-25 files (32f1f52). Base vs head on this corpus reproduces downstream snapshot diffs
  (tw#20381 saw the same plus #1183, #1233).
- **i32 saturation** (research disagreement, resolved from source): EM-10 files it under #949/#12 (precision,
  calc() percentages). It has no issue (#170 "z-index rounded" is closest) and is a v1.33.0 regression:
  `values/length.rs:518` has passed `Some(value as i32)` since c976374 (2021); cssparser 0.33 `write_numeric` used
  `int_value` only to drop `.0`, 0.37 (#1200, ae0e516) prints it. `rotate(3000000000deg)` -> `2147483647deg`
  (120deg becomes 127deg), custom properties too. Probe
  `values-numeric/large-integral-value-no-i32-saturation`: fails on master, passes on 1.32.0.
- legacy-2020 grows daisyui 1.14 -> 2.84 MB, carbon 1.37 -> 2.58 MB; S2 compares head with base, so no PR cost.
- No CSS-module, source-map or BOM inputs (a BOM needs a file-level case, not a probe).

## 8. Sass

LightningCSS never parses Sass (#113 "run Sass first", #624 `//` comments, #852 `&_title`); every consumer compiles it
first. What matters is Dart Sass *output* (sass 1.106.1 into 1.33.0):
- `expanded` + non-ASCII emits `@charset "UTF-8";`: LC drops it and decodes escapes to raw UTF-8 (#310: icon fonts,
  vite#22381).
- `compressed` + non-ASCII emits a leading U+FEFF: an ident at offset 0, so `@layer`/`@import` fail; through
  `bundle()` an imported file's BOM lands mid-output and browsers drop the next rule (#338, facebook/docusaurus#12358).
- Up to 10 decimals (`8.33333333%`) print with 6 significant digits like browsers (#949; 1px shift at 12px).
- Old IE hacks (`*zoom`, `\0`): strict parse error, dropped under recovery (#39, #542; corpus foundation, tachyons).
- `&__elem` in plain CSS means a type selector `__elem` (#852). Sass maps as `inputSourceMap`: lines off (#780).
- Bootstrap 5.3.8 SCSS -> Dart Sass -> 1.33.0 (Vite 8 targets, strict): 0 warnings.
