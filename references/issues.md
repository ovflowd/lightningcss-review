# LightningCSS issues for reviewers

Index of `issues.jsonl` (417 GitHub issues, one per number) plus unfiled bugs this research verified. Master = `cbeaf83` (v1.33.0 + 14).

## 1. Open correctness bugs, by area

**Master's bugs, not the PR's:** never count one against a PR. A PR that fixes one gets credit (check A2: its `known: open-issue#N` probe must pass on head). Root cause = first `file:line` of `root_cause`; probe ids drop the `<area>/` prefix when it matches the area row; `—` = no probe yet (write one from `repro_css`); *fixed* = open on GitHub, master passes (`fixed-by` guard, no A2 credit); *guard* = passes on master, bug needs the issue's options. Details: `jq 'select(.number==N)' issues.jsonl`.

| # | Title | Trigger | Root cause | Probe |
|---|---|---|---|---|
| **at-rules-other** | | | | |
| 962 | `@property` rules remain… | @property nested directly… | `parser.rs:731-739` | `issues-b1-nested-property-in-style-rule-error` |
| **border-outline** | | | | |
| 1146 | The border-image shorthand… | border-image (or… | `border_image.rs:295-334` | `issues-b3-border-image-none-not-empty` |
| **box-model-size** | | | | |
| 1371 | `height: stretch` causing… | height/width/min-*/max-*… | `targets.rs:245-246` | — |
| **bundler** | | | | |
| 181 | Wrong urls after bundling | @import bundling of files… | — | — |
| **calc-math** | | | | |
| 910 | Segmentation fault 11 | sum of two parenthesized… | `calc.rs:955` | `issues-b0-sum-of-parenthesized-sums-no-crash` |
| 1092 | Stack overflow on… | calc() sum of two… | `calc.rs:925` | — |
| 1312 | Percentage math functions… | abs()/sign()/mod()/rem()/ro… | — | `issues-b5-percentage-math-no-panic` *fixed* |
| **cascade-layers-scope** | | | | |
| 1189 | `@scope`: `&` has the wrong… | & directly inside @scope… | `rules/scope.rs:102` | `scope-ampersand-zero-specificity` |
| **color** | | | | |
| 618 | sRGB color notations… | hsl()/rgb() minified to… | — | — |
| 821 | `light-dark` is broken when… | light-dark() in a custom… | — | `spec-color-light-dark-lowering-in-custom-property` |
| 831 | border-color is not applying… | light-dark() inside border… | — | — |
| 873 | Invalid CSS generation with… | light-dark() inside a… | `ui.rs:555-582` | `issues-b0-light-dark-in-custom-property-inherited` |
| 1093 | assertion failed in… | hsl()/hwb() hue that… | `color.rs:2799-2805` | — |
| 1172 | Calculation error when using… | relative color with… | — | `issues-b3-relative-color-transparent-alpha` *fixed* |
| 1194 | color-mix: division by zero… | color-mix() in a polar… | `color.rs:3659-3666` | `color-mix-polar-zero-alpha-not-none` |
| 1252 | Colour precision too high | achromatic oklch()… | — | — |
| 1368 | color-mix() treats `none` as… | color-mix() where a color… | `color.rs:3534-3556` | `issues-b5-color-mix-none-cross-space` |
| **css-modules** | | | | |
| 351 | CSS Modules hashes clash… | pattern without [local] | — | — |
| 762 | grid-template identifiers do… | grid-template with var()… | — | — |
| 763 | Using rgb(var(--foo from… | var(--x from 'file')… | — | — |
| 854 | Local CSS variables not… | var(--x from 'file')… | — | — |
| 900 | CSS modules scoped and… | :global(.c) rules with… | `selector.rs:1994` | — |
| 908 | Unable to compose class… | composes: <name> where the… | `properties/css_modules.rs:78-87` | `issues-b0-composes-class-named-default` |
| 1032 | Broken pseudo element… | CSS modules selector list… | — | `issues-b2-global-list-pseudo-element-not-folded-into-is` |
| 1079 | wrapping selectors with a… | selector list with… | `selectors/parser.rs:996` | — |
| 1215 | `composes:` silently accepts… | composes: <name> where no… | `css_modules.rs:464-524` | — |
| **custom-properties** | | | | |
| 752 | Unexpected Token Error with… | all: var(--x) | — | `issues-important-all-var-accepted` |
| 921 | @property initial-value… | @property initial-value… | `rules/property.rs:89-100` | `issues-b0-property-initial-value-color-mix-currentcolor` |
| 1225 | Minification reorders… | typed… | `properties/position.rs:104-114` | `position-direction-var-fallback-order` |
| 1381 | Custom property color… | custom property with a… | `rules/mod.rs:928-932` | `issues-b5-nested-decls-custom-prop-supports-fallback` |
| **effects-masking** | | | | |
| 251 | minifier: it is not safe to… | filter function default… | — | — |
| 1327 | `backdrop-filter` is dropped… | `backdrop-filter` followed… | `prefix_handler.rs:93-123` | `issues-b5-backdrop-filter-unprefixed-kept` |
| 1360 | An earlier filter is dropped… | filter: blur(1px)… | `effects.rs:410` | `pr1364-filter-fallback-kept` |
| **flex-grid-align** | | | | |
| 1182 | Minification incorrectly… | align-self +… | `align.rs:509-520` | `place-self-justify-auto-not-collapsed` |
| 1291 | Unexpected behavior when… | `display:flex` followed by… | `display.rs:380-392` | `issues-b5-display-flex-before-ms-flexbox` |
| **font** | | | | |
| 1140 | Font-stretch percentages are… | font shorthand containing… | `font.rs:264-272` | `issues-b3-font-shorthand-stretch-keyword` |
| 1207 | Property reordering during… | font shorthand followed by… | `font.rs:830-892` | `font-shorthand-reset-only-longhands-keep-order` |
| 1221 | font-family: monospace… | font-family list repeating… | `font.rs:926-931` | `font-family-monospace-monospace-kept` |
| **gradient-image** | | | | |
| 436 | Duplicate 'image-set'… | image-set with ancient… | — | — |
| 1107 | Incorrect conversion of… | an existing… | `gradient.rs:268-300` | `issues-b3-prefixed-gradient-minify` |
| 1220 | minify… | linear-gradient(0deg / to… | `gradient.rs:282-318` | `linear-gradient-0deg-flip-nonmonotonic-stops` |
| 1286 | Unexpected transformation of… | image-set() with `x`… | `custom.rs:442` | `issues-b5-image-set-x-unit-in-token-list` |
| **logical** | | | | |
| 540 | Logical… | overflow-inline/overflow-bl… | — | — |
| 927 | LogicalProperties Conversion… | logical shorthand (inset… | — | `issues-b0-shorthand-with-var-in-calc-lowered` |
| 1018 | Downleveling… | logical margin/padding… | `context.rs:93` | `issues-b2-margin-inline-start-lowering-specificity` |
| 1179 | Logical Properties order is… | logical margin followed by… | `context.rs:93-127` | `dir-fallback-preserves-declaration-order` |
| 1246 | Logical border radius… | logical property in nested… | `rules/nesting.rs:72-84` | `nested-declarations-logical-fallback-on-parent` |
| **media-queries** | | | | |
| 213 | Negating custom media query… | negating a custom media… | — | `issues-important-custom-media-negation` |
| 379 | "1/1" Aspect-ratio media… | aspect-ratio 1/1 in media… | — | — |
| 582 | Custom media queries and… | @custom-media inside… | — | — |
| 987 | No AST produced when media… | a media feature whose… | — | `issues-b1-general-enclosed-calc-error-recovery` *guard* |
| 1361 | Media query range syntax… | range media query with <… | `media_query.rs:1522-1575` | `issues-b5-range-lowering-mq3-compatible` |
| 1366 | `@media (min-width)` is… | min-/max- prefixed feature… | `media_query.rs:1259-1266` | `issues-b5-min-prefix-boolean-is-invalid` |
| **nesting** | | | | |
| 202 | nesting rules not… | nesting with a… | — | — |
| 777 | Nesting selector always… | nested selector without &… | — | — |
| 982 | Nested selectors should not… | a nested rule whose parent… | `selector.rs:1742-1764` | `issues-b1-amp-under-pseudo-element-parent` |
| 1023 | `margin-inline-start`… | logical property declared… | `rules/nesting.rs:73` | `issues-b2-nested-media-logical-dropped` |
| 1049 | logical border-radius… | logical property declared… | `rules/nesting.rs:73` | `issues-b2-light-dark-dark-rule-after-nested-rule` |
| 1073 | Nested `:has(+ &)` is… | `&` right after a relative… | `selector.rs:1464-1479` | `issues-b2-has-relative-nesting-selector-wrapped-in-is` |
| 1159 | :is() incorrectly added to… | nesting lowering where the… | `selector.rs:1742-1764` | — |
| 1318 | Selector silently dropped… | nested rule list with an… | `rules/mod.rs:800-838` | `issues-b5-nested-split-selector-not-dropped` |
| **parser-syntax** | | | | |
| 338 | UTF-8 BOM Handling | UTF-8 BOM at the start of… | — | — |
| 938 | Unable to parse specific css… | url('data:...<svg… | — | — |
| 1297 | Unbounded recursion in… | deeply nested… | — | — |
| 1358 | errorRecovery: an at-rule… | errorRecovery with any… | `parser.rs:494-498` | `issues-b5-error-recovery-keeps-decls-before-at-rule` |
| **prefixing-compat** | | | | |
| 109 | Overwriting fallbacks are… | hand-written fallback… | — | — |
| 695 | Backdrop Filter outputs only… | standard backdrop-filter… | `prefix_handler.rs:120` | `issues-important-backdrop-filter-standard-then-webkit` |
| 872 | Already prefixed… | -webkit-text-decoration… | `text.rs:1196` | `text/issues-important-text-decoration-prefixed-inherit-idempotent` |
| 925 | Strange behavoiur for… | user-select with… | — | `issues-b0-user-select-webkit-prefix-safari-18` *fixed* |
| 934 | `text-size-adjust` is not… | text-size-adjust with… | — | `issues-b0-text-size-adjust-webkit-ios` *guard* |
| 969 | Vendor prefixes may be… | an authored… | `masking.rs:700-707` | `issues-b1-mask-image-var-duplicate` |
| 977 | Unable to set a different… | an author-written prefixed… | `prefix_handler.rs:22-45` | `issues-b1-unprefixed-backdrop-filter-dropped` |
| 1086 | Unexpected CSS minify | backdrop-filter: X… | — | — |
| **printer-serialization** | | | | |
| 289 | `u + a` selector is minified… | u + a selector minified… | — | — |
| 1155 | Crash: stack overflow /… | pathologically deep… | `printer.rs:76` | — |
| **rule-merging** | | | | |
| 572 | Properties order not… | duplicate or related… | — | `transition-animation/issues-important-animation-timeline-not-folded` |
| 688 | Removing duplicate… | duplicate declarations of… | — | — |
| 738 | Lightningcss randomly drops… | large real-world… | — | — |
| 1235 | Stale StyleRuleKey hash… | rule merging that mutates… | `rules/mod.rs:1222-1235` | `stale-dedup-index-drops-nested-rule` |
| 1260 | Incompatible selectors can… | selector list containing a… | `rules/mod.rs:758-790` | `incompatible-selector-kept-after-merge` |
| 1310 | Minifier silently drops a… | selector list with one… | `rules/mod.rs:800-838` | `issues-b5-split-selector-list-not-dropped` |
| **selectors** | | | | |
| 312 | :is() treatment is incorrect… | :is() downleveled to… | — | — |
| 345 | Do not simplify `:is()` when… | :is() with an unknown… | — | `issues-important-is-unwrap-forgiving-list` |
| 907 | Malformed @supports block… | selector list where every… | — | `issues-b0-all-selectors-incompatible-no-empty-supports-rule` |
| 990 | Support `::before::marker`… | the sub-pseudo-elements… | `selectors/parser.rs:145-148` | `issues-b1-before-marker` |
| 997 | Avoid injecting `:is` in… | :not() or :is() with a… | — | `issues-b1-webkit-any-fallback-specificity` |
| 1211 | `:-webkit-any(:lang(...))`… | :-webkit-any()/:-moz-any()… | `rules/mod.rs:1082-1093` | `prefixed-any-inside-not-preserved-without-targets` |
| 1239 | Pseudo-element arg inside… | pseudo-element argument… | `selectors/parser.rs:2832-2852` | `has-pseudo-element-argument-not-emptied` |
| 1244 | Selecting… | pseudo-element after the… | `selectors/parser.rs:2778-2786` | `details-content-pseudo-element-chain` |
| 1300 | 'highlight' is not… | `::highlight(name)` | — | `issues-b5-highlight-pseudo-accepted` *fixed* |
| 1303 | v1.33.0 rejects valid… | `::search-text:current`… | `selectors/parser.rs:3129` | `issues-b5-search-text-current` |
| 1324 | Minifier wraps a selector… | selector list containing a… | `selectors/builder.rs:358` | `issues-b5-is-wrap-has-specificity` |
| 1351 | `::placeholder` gets… | legacy… | `selector.rs:168-169` | `issues-b5-legacy-ms-input-placeholder` |
| 1375 | Excluding DirSelector also… | exclude… | `targets.rs:238-241` | — |
| **supports-container** | | | | |
| 710 | Improperly unprefixing… | vendor-prefixed… | `rules/supports.rs:225-252` | `issues-important-supports-prefixed-operand-unprefixed` |
| 1325 | Syntax error for container… | var() as the value in a… | — | `issues-b5-container-query-var` |
| **text** | | | | |
| 981 | Issue with text-shadow… | a Length visitor that… | `text.rs:1438-1445` | — |
| **transform** | | | | |
| 239 | translate3d after parcel… | translate3d(0,0,0)… | — | `sat-translate3d-zero-keeps-3d-function` |
| 426 | Individual… | transform together with… | — | `issues-important-individual-transform-preserved` *fixed* |
| **transition-animation** | | | | |
| 337 | Animation property broken… | animation shorthand… | `animation.rs:668` | `issues-important-animation-shorthand-without-name` |
| 1012 | Animation property shorthand… | animation shorthand with N… | `animation.rs:650` | `issues-b1-animation-duration-auto-expansion` |
| 1084 | : CSS properties sorting… | untyped longhand… | — | `issues-important-transition-behavior-after-shorthand` |
| 1095 | All properties in animation… | `animation` shorthand… | `animation.rs:662-668` | `issues-important-animation-shorthand-without-name` |
| 1103 | Keyframe including invalid… | any parse error inside a… | `rules/keyframes.rs:403-415` | `issues-b3-keyframe-nested-at-rule` |
| 1214 | `transition` shorthand… | transition: <CSS-wide… | `transition.rs:69` | `transition-inherit-not-merged-with-longhand` |
| 1226 | animation-range keywords… | animation-range shorthand… | `animation.rs:537-540` | `animation-range-end-keyword-default-100` |
| 1283 | `animation-timeline: view()`… | `animation` shorthand plus… | `animation.rs:957-965` | `issues-b5-animation-timeline-not-folded-chrome-115` |
| 1369 | Minifier folds… | animation shorthand +… | `targets.rs:227` | `issues-b5-animation-timeline-not-folded-no-targets` |
| **ui-misc** | | | | |
| 1362 | caret, caret-color and… | interleaved caret /… | `prefix_handler.rs:120` | `issues-important-caret-shorthand-order` |
| **values-numeric** | | | | |
| 170 | z-index rounded | large integers in… | — | `ecosystem-consumers-large-integral-value-no-i32-saturation` |
| 949 | lightningcss ate my precision | numbers with more than 6… | `custom.rs:544-546` | `custom-properties/issues-b0-integer-token-keeps-all-digits` |
| 1042 | Unexpected units for CSS… | unitless non-zero number… | `length.rs:145-147` | — |
| 1199 | Numbers inside invalid… | unitless non-zero number… | `length.rs:145-148` | `unitless-nonzero-length-not-px` |

Open bugs outside CSS output (API, visitors, bindings, source maps, CLI, warnings): #291, #780, #794, #892, #951, #1019, #1065, #1071, #1074, #1081, #1088, #1104, #1149, #1164, #1167, #1188, #1320, #1348, #1370.

## 2. Recurring bug classes

| Class | Issues (open in bold) |
|---|---|
| Buffered handlers emit a shorthand after a longhand or `var()` value it resets | **#572**, #746, #805, **#1084**, **#1207**, **#1225**, **#1362**; U15 |
| Invalid input typed as valid (or valid printed invalid); valid fallback lost | **#1199**, **#1042**, **#1146**, #1000; U18 |
| Author fallbacks or prefixed/unprefixed pairs collapsed by Fallback/PrefixHandler | **#109**, **#695**, **#977**, **#1086**, **#1327**, **#1360**, **#969**, **#872** |
| Side rules (`:dir()`/`:lang()`, `@supports`, dark `@media`) lost or leaked after nested rules | **#1023**, **#1049**, **#1246**, **#1381**, **#907**; U28, U29 |
| Merge/dedupe keys or side tables stale, or merged list invalid | **#1235**, **#1260**, **#1310**, **#1318**, #1109; U6, U10 |
| `:is()` wrapping, splitting or nesting lowering changes validity or specificity | **#202**, **#345**, **#997**, **#1159**, **#1324**, **#1032**, **#1079**, **#982**, **#1073**, **#1189** |
| Shorthand folding with CSS-wide keywords, `none` names, reset-only timelines | **#337**, **#1095**, **#1214**, **#1012**, **#1226**, **#1283**, **#1369** |
| Compat data counts partial, prefixed or mobile support as full | **#925**, **#934**, **#1283**, #508; U30, U31 |
| Number and token serialization | **#949**, **#170**, **#1286**, #899; U4, U20 |
| Unbounded recursion and panics | **#910**, **#1092**, **#1093**, **#1155**, **#1297**, **#1312**, **#1371**; U1, U2 |

## 3. Unfiled bugs found during this research (verified on master cbeaf83)

No issue found (search 2026-10-26). Probes re-run on a cbeaf83 build; engine verdicts from cbeaf83 `baseline.json`; every `file:line` re-read. ≠ = engines compute input and output differently; `+N` = more probes. A fix earns credit like an open issue.

**Breaks the sheet**
- **U1** `border-color:oklch(70% .2 30) currentColor` (safari 14) panics: `values/color.rs:517-519` unwraps (open PR #1311). `border-outline/community-prs-border-color-oklch-currentcolor` +2.
- **U2** `:host(&){.b{}}` (chrome 95) overflows the stack (suspected `selector.rs:1702-1714`); nested `:fullscreen` ×20 (safari 8) prints 357 MB (`rules/style.rs:218-238`). `nesting/em-host-amp-nested-rule-no-stack-overflow`, `nesting/em-prefixed-nested-selector-no-duplication`.
- **U3** Escaped names printed raw, `fake\7d name` → `fake}name` ends the block: `transition-property`, unknown at-rules, `@font-face`, `@page`, media types, pseudo-classes (`properties/mod.rs:265`, `rules/unknown.rs:40`, `selector.rs:866`). `printer-serialization/em-transition-property-ident-escaped` +5.
- **U4** Token lists merge tokens ≠: `x//**/*y` → `x/*y` comments out the rest (`custom.rs:898-902`); `1px+2px` → `1px2px`, `2e3.4` → `2000.4` (`custom.rs:544`). `custom-properties/em-comment-removal-creates-comment-opener` +7.
- **U5** `:nth-col(1)` → `:nth-col(` (`selectors/parser.rs:1299-1320`); `@font-feature-values` with `font-display` rejects the sheet (`rules/font_feature_values.rs:145`). `selectors/ss-nth-col-a0-unbalanced-output`, `font/sft-font-feature-values-font-display`.

**Merging and cascade ≠**
- **U6 (N1)** `.a{color:red}.b{color:blue}.b{color:red}.b{color:green}` → `.a,.b{color:red}`: `rules.pop()` (`rules/mod.rs:804-816`) leaves a stale `style_rules` index (`:864-890`). #1235's family; PR #1236 tests a similar pop case. `rule-merging/asr-dedupe-stale-index-drops-rule` +1.
- **U7 (N2/N3)** Same-name `@keyframes` replaced in place (`rules/mod.rs:643-648`), crossing an `@media` copy and leaving the loser's `@supports` fallback last. `rule-merging/arch-core-keyframes-replacement-crosses-conditional` +1.
- **U8 (N6)** Anonymous `@layer{}` contents never minified or lowered (`rules/mod.rs:716-729`, since v1.23.0). `cascade-layers-scope/arch-core-anonymous-layer-contents-lowered`.
- **U9** `@property`: unknown descriptor drops the rule (`rules/property.rs:198`); a browser-rejected later copy wins (`rules/mod.rs:973-978`); `"<LENGTH>"` accepted (`values/syntax.rs:346`). `custom-properties/ssv-property-unknown-descriptor` +4.
- **U10** Merged into a list browsers reject: `[a=b s]` (`selector.rs:1856`), undeclared `ns|div` (`:378-380`), `&div`. `rule-merging/asr-attr-s-flag-merge` +5.
- **U11** `::selection` + `::-moz-selection` → `::selection` twice; webkit + moz placeholder rules print `::placeholder` (`rules/mod.rs:1080-1094`). `selectors/em-prefixed-pseudo-merge-keeps-prefix` +1.
- **U12** `revert-rule` missing from CSS-wide keyword lists (`properties/mod.rs:1684-1695`, `values/ident.rs:35`): rules before it merged away, `"revert-rule"` names unquoted. `cascade-layers-scope/revert-rule-adjacent-rules-not-merged` +3.
- **U13** `@import` after `..bad{}` or an unknown block at-rule dropped (`parser.rs:447`, `:365`); `.foo{@media(…){@apply --x}}` loses `.foo` (chrome 95). `cascade-layers-scope/import-valid-after-invalid-style-rule` +2.
- **U14** Bundler: `@import "a.css"; @import "a.css" layer(x)` keeps only the layered copy (`bundler.rs:362-386`). CLI `--bundle` only.

**Order and shorthands ≠**
- **U15 (N8)** Buffered shorthand emitted after a longhand it resets: `overflow`;`overflow-inline`, `gap`;`grid-gap`, `mask`;`-webkit-mask-composite` (`masking.rs:662-749`), `border-image`;`border:var()` (`border.rs:725-728`). `rule-merging/arch-core-overflow-inline-after-overflow` +9.
- **U16** Folding resets untouched sub-properties: `font` longhands → `font` (`font.rs:934-964`), sides → `border` (resets `border-image`), `font-family:inherit` → `font:12px inherit`. `font/issues-b3-font-longhands-not-folded` +4.
- **U17** `transition:-webkit-transform 1s,opacity 2s,transform 3s` gives `transform` 1s (regression from #850); `animation:0s auto` → `animation:auto`; `-webkit-animation:k 1s;animation-name:k` → `animation-name:` (`animation.rs:968-978`). `transition-animation/sat-animation-name-auto-keeps-duration` +8.

**Invalid input made valid, deleting the valid fallback ≠**
- **U18** About 45 probes: `color:foo` (`prefix_handler.rs:148`); empty `filter:`/`flex:`/grid values; `repeat(0,1fr)`, `span -1` (`grid.rs:190-197`, `:1403`); 3-value positions outside backgrounds (`values/position.rs:60`); `font-weight:0`; `text-decoration-line:none underline` (`text.rs:494-512`); `steps(0)`; `calc(100px - 0)`. E.g. `rule-merging/ssv-invalid-color-does-not-override`.

**Values ≠**
- **U19** calc(): `calc(10px + 0%)` → `10px` (`percentage.rs:408-414`), `min(10%,20%)` folded (`calc.rs:658`), `round(-2.5px,1px)` → `-3px` (`calc.rs:116`). `calc-math/ssv-zero-percent-term-height` +6.
- **U20** `0px` → `0` in `tab-size`/`line-height` (`length.rs:491-494`); v1.33.0 i32 saturation `3000000000deg` → `2147483647deg` (`length.rs:518`). `values-numeric/ssv-line-height-zero-interpolation` +4.
- **U21** color-mix() powerless rules (`color.rs:3674`, `:3757`); gradients drop non-midpoint `50%` hints (`gradient.rs:1036-1041`) and legacy-ize `color-mix()` stops (`color.rs:3193-3200`). `color/spec-color-mix-hsl-white-saturation-not-powerless` +14.
- **U22** `skewX(a)` → `skew(a)` changes interpolation (`transform.rs:1204-1220`); grid names after a first unnamed row shift a line (`grid.rs:746-771`). `transform/sat-skewx-not-rewritten-as-skew` +2, `flex-grid-align/spec-layout-grid-template-first-row-trailing-line-names` +4.
- **U23** Serializers: `list-style:outside outside` → `outside` (`list.rs:420-438`); `text-decoration:none red` drops red (`text.rs:779-783`); `:has(:scope)` → `:has()` (`selector.rs:1465`). `ui-misc/sft-list-style-type-named-like-position` +18.

**Selectors and conditions ≠**
- **U24** Nesting: `> &a` → `.fooa` (`selector.rs:1478`); top-level `&` → `:scope` (`:1762-1769`); `@scope (.a) to (& > .b)` → `to (.a>.b)` (`rules/scope.rs:84-91`). `nesting/em-relative-amp-type-selector-not-concatenated` +7.
- **U25** CSS modules: `counter(c, stars)` and `system:extends stars` not renamed; `:state(x)` hashed (regression from #1133). `css-modules/em-counter-style-descriptor-references-renamed` +2.
- **U26 (N4)** `@supports (-webkit-x:v) and (x:v)` → `or` (`rules/supports.rs:236-252`, `:403`). `supports-container/arch-core-supports-and-prefixed-stays-and` +2.
- **U27** unminified `@media{}` → `not all` (`media_query.rs:167-169`); `not (width = 1px)` → `(width=1px)` (`:950`, since v1.29.0); custom media type inside `or` → `and` (`:1827-1837`). `media-queries/asr-not-equal-range` +5.

**Lowering and compat**
- **U28 (N5)** `!important` dropped from `:dir()`/`:lang()` side rules (`context.rs:93-112`); `color-scheme:… !important` gets a normal dark rule (`:144-147`). `logical/arch-core-important-logical-lowering-keeps-important`.
- **U29 (RA1)** `@keyframes k{from{margin-inline-start:1px}}` (safari 11) leaks `margin-left` onto the next style rule (`keyframes.rs:120-130`). CLI only.
- **U30 (N7)** `opera_android` overwrites `opera` (`scripts/build-prefixes.js:26`, `:449-450`): `opera 90` gets bare `lab()`. `prefixing-compat/arch-core-opera-desktop-lab-fallback` +2.
- **U31** Wrong fallbacks: `color(rec2020)` at safari 14 (`build-prefixes.js:434`); `row-gap`+`column-gap` → `gap` at chrome 60 (`align.rs:1168-1181`); `-webkit-box-ordinal-group` off by one (`flex.rs:353-358`); `transition:inline-size` → `height` in RTL (`transition.rs:493-497`). About 25 probes, e.g. `prefixing-compat/issues-b3-print-color-adjust-firefox`.

**Tooling**
- **U32** `cargo test -p parcel_selectors` fails at `selectors/parser.rs:3933`; CI tests only the root package (`test.yml:24`).
- **U33** `release.yml` pins Node 18 (lines 31, 66, 135, 232); `package.json:30` requires `>= 24.0.0`.

### Dropped or folded into an existing issue

Confirmed but not bugs: `#FF0000` → `red` in custom properties (CSS-equivalent, intended); `"<\/style>"` decoded in strings (HTML-inlining hazard only). Covered by open issues: UUID digits (#949), legacy placeholder pseudos (#1351), unitless media lengths (#1199), invalid nested rule (#1358), `animation-timeline` (#1283), `transition-behavior` (#1084), `transition-property:inherit` (#1214), `:dir()` specificity (#1018). By design: `:lang()` heuristic, horizontal-tb logical lowering, `light-dark()` without `color-scheme`. Not confirmed (legacy-engine-only verdicts or spec-conformant output): `calc-math/ssv-clamp-lowering`, `display-layout/spec-layout-display-multi-keyword-short-forms`, `selectors/ss-nth-child-of-not-lowered-to-compound`, `font/sft-system-font-keyword-as-family` and 2 guard probes.
