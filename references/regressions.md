# Regression taxonomy: how changes broke each area

Read "Read first", then the section of each area in `prepare.json.areas`/`radius_areas`. Per class:
**Breaks**, **Chain** (cause → issue → fix, first release), **Ask** (the review question that would have
caught it), **Detect** (harness evidence). `file:line` refs are at master `cbeaf83`; probe refs are probe
ids (`corpus/probes/<area>/<slug>.css`), `*` globs over slugs. "master" = fixed after v1.33.0, unreleased.
N1..N8 = unfiled bugs verified on a master build (research `arch-core` §0). Sources: research
`community-prs`, `devon-work` §5, `issues-important`, `issues-b0..b5`, `arch-core`, `rejected-and-open-prs`.

## Read first (every PR)

- **Baseline moved.** master = v1.33.0 + 14 unreleased commits, incl. 93b9e66, 32aecd9, b0939ab/#1329,
  #1340, #1343, #1263, #1274 and #1323 (every gamut-mapped fallback changes). Diff against the merge base.
- **Big-bang commits caused most regressions** (mostly direct pushes): aa083a7, a84fbdb (1.20.0); 2694a18,
  d18c223, 5c105fb+31ce350, 09f6b7a (1.21.0); a8b7ea0 (1.22.0); aedf6b6 (1.23.0); d7aeff3, f4408c7
  (1.25.0); 6c465c1 (1.30.0); #1062 (1.30.2); 32f1f52, 220b390 (1.31.0). A pass rewrite needs the whole
  corpus. 17 of 105 community product PRs since #400 shipped a regression (22 with incomplete fixes);
  none of #850, #936, #929, #1152, #1133 got a review comment on the regressing part. 8 of the 15
  regressions behind issues #1270-#1382 trace to five 2023 commits and were filed only in 2026, once Vite
  8 made LightningCSS its default production minifier: old paths are not proven safe by silence.
- **Always-on passes.** `transform()` always calls `minify()` (napi/src/lib.rs:761): merging, dedupe and
  handlers run with `minify:false`. No targets = all features supported (src/targets.rs:225-227), so
  author fallbacks collapse by design. Any `targets`, even `{}`, enables selector compat/splitting.
- **Some warnings fail builds.** Turbopack makes `UnexpectedToken`, `EndOfInput`, `UnexpectedImportRule` and
  non-pseudo `SelectorError` warnings errors (next.js turbopack-css process.rs): a new one on valid input
  breaks `next build` (#1370 → next.js#98261).
- **Harness blind spots**: deltas ignore `warnings` (lib/lcr/adapter.py:114-126; read
  `<run>/corpus/outputs-*.jsonl`); `var-before`/`var-after` reuse the typed value as fallback (a pure
  reorder stays equivalent); `prefixed-sibling` writes only the safe
  `-webkit-x; x` order; no mutation mixes importance, adds declarations after a nested rule, or toggles
  `compact`/`error_recovery`; gradient flips change computed strings (use O6) and a fallback hidden by
  the unprefixed declaration renders only in a legacy engine (O4); WPT = property values only; no
  visitor mode; probes cannot set `include`/`exclude`; L5 (animations), L8 (CSS modules).

## rule-merging

**RM-1 Dedupe key ignores a cascade dimension**
- Breaks: an earlier rule or its `!important` declaration is deleted as "overridden" by a later
  same-selector rule that differs in importance (or prefix, condition, source file).
- Chain: aa083a7 "Remove duplicate style rules" (1.20.0) → #1109, #1347 → 93b9e66 (master). #89 (2022)
  fixed it for adjacent merges. #1263 (master) minifies each run of adjacent conditional rules once, so
  an in-list dedupe bug now spans the run (bun#46733).
- Ask: does every key that drops/merges rules compare importance, prefix, condition/layer and (CSS
  modules) source file (src/rules/mod.rs:877-882)?
- Detect: O1 on `rule-merging/*important*`, `rule-merging/devon-dup-rule-keeps-importance`; no mutation.

**RM-2 Stale bookkeeping after in-place merges**
- Breaks: missed dedupe, output that changes on a second pass or between processes (#1235), or a live
  rule deleted: `.a{color:red}.b{color:blue}.b{color:red}.b{color:green}` → `.a,.b{color:red}` (N1,
  verified master and 1.33.0).
- Chain: the `StyleRuleKey` hash is cached at insert (src/rules/style.rs:152, `AHasher::default()`,
  per-process seed) while `merge_style_rules` mutates the rule; `rules.pop()` (mod.rs:810) leaves the key,
  so the next rule at that index matches itself and becomes `Ignored` (:877-882). aa083a7 + e9277fd,
  bisect UNVERIFIED. Open #1235; PR #1236 drops indexes at merge/pop, but none of its tests is N1's input
  (N1 coverage UNVERIFIED). Same pattern: `@keyframes` replaced in place across a conditional rule,
  the loser's `@supports` fallback kept after the winner (mod.rs:642-664; N2/N3).
- Ask: after each merge/pop, are `style_rules`/`keyframe_rules` updated? Same output on a second pass?
- Detect: R2; `rule-merging/*stale-dedup*`, `rule-merging/asr-dedupe-stale-index-drops-rule` (N1),
  `rule-merging/arch-core-keyframes-replacement-*`.

**RM-3 Split-off incompatible selectors lost**
- Breaks: with targets, a selector split from a list loses its declarations; if all are incompatible, an
  `@supports` fallback with an empty selector is emitted (head rejects its own output).
- Chain: 5c105fb + 31ce350 (1.21.0) → #1260, #1310, #1318 (PR #1275); #907/#1010 (widened in 1.30.0).
  `merge_style_rules` drains `style` (mod.rs:798-818) before clones and side rules are built from it
  (:822-839); empty clones are skipped (:899-901).
- Ask: do all readers of a rule run before its declarations move? Is every input selector in the output?
- Detect: `retarget-modern`/`retarget-legacy` → O1; R2; `rule-merging/*incompatible*`,
  `selectors/issues-important-split-*`, `nesting/issues-b5-nested-split-selector-not-dropped`.

**RM-4 Buffering handlers reorder declarations** (#2 by impact, issues-important §1)
- Breaks: a handled property waits for `finalize()` while an unhandled longhand, `Unparsed` value or alias
  is pushed at once (src/declaration.rs:246-253): a shorthand then resets a longhand written after it, or
  a static value beats its later `var()` override.
- Chain: fixed #746 `all` (d7aeff3 1.25.0 → 60622a1 1.25.1), #805 size+`var()` (d18c223 1.21.0 → 22a8b6f
  1.28.0). Open: #1084 `transition-behavior`/`animation-composition` (PR #1365); #1207 reset-only
  `font-*` (PR #1209; font.rs:879 `TODO: reset other properties`), `font-width` (#1234); #1225 position/direction (no
  `Unparsed` arm, position.rs:97-112; PR #1387); #1362 caret (PR #1363); N8 `overflow; overflow-inline`.
- Ask: which family members does the handler not own (spec "reset implicitly" list, newer longhands,
  `Unparsed`, aliases), and does it flush before emitting them? Both orders tested?
- Detect: deltas in `lcr show`; O1 on probes with distinct values: `font/*after-shorthand*`,
  `transition-animation/*transition-behavior*`, `display-layout/*position-var-order*`, `ui-misc/*caret*`,
  `box-model-size/*-order`, `rule-merging/arch-core-overflow-inline-after-overflow`; `reverse-decls`.

**RM-5 Merge-core refactors** (latent): #1263 (master) and open #1236, #1275, #1333, #1386 edit
`CssRuleList::minify`; #1333 adds a cascade-reordering optimization (shared custom properties moved
into a new rule). Detect: S3, S1,
`rule-merging/community-prs-adjacent-media-coalesce-important`.

## prefixing-compat

**PFX-1 FallbackHandler write-back drops the earlier declaration**
- Breaks: `backdrop-filter:X;-webkit-backdrop-filter:X` keeps only `-webkit-` (lost in Chrome/Firefox),
  even with no targets; an author fallback goes when the later value is unsupported; caret order flips.
- Chain: 2694a18 (1.21.0) added `dest[index] = …` (src/properties/prefix_handler.rs:116-121) for Color,
  TextShadow, Filter, BackdropFilter, Fill, Stroke, CaretColor, Caret (:172-181) → #695, #1086, #1327,
  #977, #1360, #1362 open, #1229 dup (PRs #1259, #1284, #1364). `Filter`/`FilterList::is_compatible`
  always return `true` (effects.rs:214-217, :410-413). Executed bisects (1.20.0 ok, 1.21.0 bad) refute issues-b2's "since
  b9624aa". Siblings: `display:flex` dropped before `-ms-flexbox` (#1291); `overflow:hidden;overflow:clip`
  → `clip` for Safari <16 (unfiled).
- Ask: before overwriting: prefix × target support of the later value × importance × a related shorthand
  in between? Both orders, different values?
- Detect: `reverse-decls` on an input with both forms → O1; `*/*backdrop-filter*`,
  `effects-masking/*filter*-fallback-kept`, `flex-grid-align/issues-b5-display-flex-before-ms-flexbox`,
  `*/*overflow-clip*`.

**PFX-2 Compat data and generator semantics**
- Chain: #325 closed upper range (1.16.0 → #326); #508 `::marker` partial data; #826 (1.22.1 → 1.23.0); #925
  `-webkit-user-select` lost (1.28.0 → 1.29.3); #1102 (1.31.0) emits `-moz-print-color-adjust` (Firefox
  48-96 use `color-adjust`, autoprefixer hack; unreported); #1198 shifted ios_saf/opera thresholds; #1283:
  BCD partial counted as support (scripts/build-prefixes.js:337, :434-436; also colorFunction, imageSet,
  highlight, fontStyleObliqueAngle); N7: mobile keys overwrite desktop (:23-32, :449-450), so `opera 90`
  gets bare `lab()`.
- Ask: regenerated by the script, not hand-edited (#1178, #1284)? Decisions diffed for a fixed target
  matrix? BCD `partial_implementation`/`alternative_name` and autoprefixer `lib/hacks` checked per name?
- Detect: B11; S1; realworld `lower-*` deltas; O3/O4; `*/*opera-desktop*`,
  `prefixing-compat/*print-color-adjust*`, `prefixing-compat/issues-b0-user-select-webkit-prefix-safari-18`.

**PFX-3 Prefixed `Unparsed` values grow every pass**: #872 `-webkit-text-decoration: inherit` (a58ea6f
1.19.0; PR #1334), #969 mask (PRs #1295/#1339; Devon: merge into `dest.last_mut()`), #1211
`:not(:-webkit-any())` → `:not(:is())` + copy without targets (f782754 1.22.0). Detect: R2;
`text/issues-important-text-decoration-prefixed-inherit-idempotent`, `prefixing-compat/issues-b1-mask-image-var-duplicate`.

## selectors

**SEL-1 Making an unknown pseudo known tightens the parser**
- Breaks: CSS that passed with a warning becomes a hard error: only user-action pseudo-classes may follow
  a known pseudo-element (selectors/parser.rs:2780, :3129).
- Chain: #1213 (e013c45, 1.33.0) → #1303 `::search-text:current` (PRs #1304/#1307); #930 (1.29.3) →
  #1244 `::details-content::before` (element-backed; PR #1308); #957 (1.30.0) → #1292 (contested); #1133
  (1.31.0) `:state(initial)`; #990 `::before::marker`; #842 `@value` warning → error (1.28.0).
- Ask: per spec/WPT, what may follow each newly known pseudo? Does everything base accepts still parse?
- Detect: head `parse` error deltas; `selectors/*search-text*`, `selectors/*details-content*`,
  `selectors/issues-b1-before-marker`. WPT selector parsing (would have caught #1213) is not in the lane.

**SEL-2 Parse/print asymmetry for legacy aliases**: #929 (b93c9c5, 1.29.3) changed only the parser:
`input:-moz-placeholder` prints as nonexistent `:-moz-placeholder-shown`; with targets a
`:-ms-input-placeholder` list gains a live `:placeholder-shown` (vite#23570 hid fields) → #1351, PR #1352.
`::-ms-input-placeholder` maps to `VendorPrefix::Moz` (src/selector.rs:291; PR #1281). Ask:
print(parse(x)) == x when nothing is lowered? Detect: output assertions; `selectors/*placeholder*`.

**SEL-3 Lowering changes specificity or wraps pseudo-elements**
- Chain: 31ce350 (1.21.0) wraps in `:is()` only for equal specificities, but `:has()` counts 0
  (selectors/builder.rs:357-358) → #1324; #536 pseudo-elements in `:is()` (→ 284debf 1.21.6); `:global()`
  hides pseudo-elements from the guard (mod.rs:768), deserialization drops `HAS_PSEUDO` (#1032, #1079);
  `:not(.a,.b)` (fixed by ff4de2a); `:-webkit-any()` weight (#997); `.cb:is(input:checked)` → `.cbinput:checked`
  (fixed by #783); `:is()` unwrapped around invalid input (#345).
- Ask: spec specificity (`:is`/`:not`/`:has` = max, `:where` = 0) through `:global`/`:has` and after
  deserialization? No pseudo-element inside `:is()`?
- Detect: O1 with an equal-specificity competitor; `engine-legacy-2021` (Chromium/Firefox lack `:has()`);
  `*/*is-wrap-has-specificity`, `selectors/issues-important-pseudo-element-not-wrapped-in-is`,
  `css-modules/issues-b2-global-list-pseudo-element-not-folded-into-is`, `selectors/*is-*unwrap*`.

**SEL-4 Compat gaps drive splitting**: `is_compatible` (src/selector.rs:1836) is `false` for unlisted
pseudos (:1994, :2022), so `:open`, `:defined`, `:global` and unknown names split (or `:is()`-wrap) lists for any targets
(feeds RM-3); a new pseudo needs a compat `Feature`. Excluding one Selectors flag disables all selector
lowering (src/targets.rs:238-241 → #1375; Tailwind v4 excludes `DirSelector`). Detect: `retarget-modern`.

## nesting

**NS-1 Nested declarations lose or misplace generated rules**
- Breaks: after a nested rule, logical `:lang()`/`:dir()` rules, `@supports` color fallbacks and the
  `light-dark()` dark rule are dropped (#1023, #1049, #1381, #109) or attached to the next sibling
  (#1246: `.p{.c{} margin-inline-start:1px; .d{}}` → `.p .d:not(:lang(…))`).
- Chain: 6c465c1 (1.30.0): `NestedDeclarationsRule::minify` (src/rules/nesting.rs:73-84) never drains or
  resets `handler_context` (only `CssRule::Style` does, mod.rs:822-841). Open PRs #1123 (merges into the
  parent; Devon questioned the order) and #1386 (positional `@supports`).
- Ask: does every rule kind holding declarations (nested declarations, `@starting-style`, `@scope`,
  keyframes) emit side rules at its own position, inside its condition, then reset the context?
- Detect: O1/O4 + dark jobs on `nesting/issues-important-nested-decl-*`, `nesting/issues-b2-*`,
  `nesting/arch-core-nested-declarations-side-rules-leak-to-sibling`, `*/*nested-decl*-fallback`.

**NS-2 Missing separators**: 6c465c1 → #989, #1002, #1078 (`margin:autodiv &{}`) → 9e04c01 (1.31.0).
Body-less JS custom at-rules still print no `;` (napi/src/at_rule_parser.rs:163-195, unreported).
Detect: R2, O1; `nesting/*semicolon*`.

**NS-3 `&`/`:is()` cannot represent pseudo-elements**: #982 open (`#b::after{&{}}` lowered to a matching
`#b:after`; `serialize_nesting`, src/selector.rs:1742-1763, has no guard). Open PR #1156 makes
`.el::after{.parent &{}}` match, against css-nesting-1 #nest-selector (expect UNSAFE). Also `!important`
in nested `@media` (#356 → 6a7d19e), `&` in `:has()` (#1073). Ask: same as native nesting, incl.
`::before`/`::after` styles? Detect: O1 with targets on `nesting/*pseudo-element*`,
`nesting/devon-important-in-nested-media` (`nest` never builds these shapes).

**NS-4 Unknown at-rules hoisted**: #896 → #1233 (1.33.0, direct children only); the nested-`@media` case
of #1232 still loses the parent selector. Detect:
`nesting/community-prs-unknown-at-rule-stays-in-style-rule`, `at-rules-other/unknown-at-rule-*`.

## cascade-layers-scope

**LAY-1 Layer optimizations reorder or skip**: aedf6b6 (1.23.0) → #974 sublayer order and `@layer a`
merged across an `@media` adding to `a` → 32aecd9 (master: no moving layer content across non-layer
rules). N6 (unfiled): anonymous `@layer {}` contents are never minified or lowered unless the list has a
named layer (`has_layers`, mod.rs:716-741, :988). Ask: order = first appearance across statements,
dotted names, nested blocks, conditions and `@import layer()`? Detect: `wrap-layer` (named) → O1;
`cascade-layers-scope/*layer*` (a release base fails the 32aecd9 guards).

**LAY-2 `@scope`**: `&` lowered to `:scope`, not `:where(:scope)` (#1189); bare declarations in `@scope`
are a parse error (#1165). Detect: `cascade-layers-scope/*scope*`.

## supports-container

**SUP-1 Operand merging changes truth value**: 6bd2761 (1.24.1) merges declarations "minus prefix"
(src/rules/supports.rs:236-252): `(-webkit-box-orient:vertical)` in and/or loses its prefix (#710; PRs
#1313/#1316 duplicates); a prefixed `and` pair prints as `or` (N4). Detect: O1; `supports-container/*prefixed*`.

**SUP-2 Queries under errorRecovery**: #1125 name-only `@container` + 220b390 recovery (both 1.31.0) →
#1370 `@container x   {` + false `EndOfInput` warning (PR #1379); 220b390 → #1137 → f3666d6 (1.31.1);
#954 left `dbg!()` (1.30.0). Strict mode rejects valid `<general-enclosed>` (#1176, #987); #1210 lists,
#1325 `var()`. Ask: same output, no warnings with errorRecovery? Detect: `supports-container/*name-only*`,
`supports-container/*general-enclosed*`.

## media-queries

**MQ-1 Lowered/reprinted queries match differently**: a84fbdb (1.20.0) → #1366 `(min-width)` → `(width)`
(never → always; PR #1380); 7f29035 (1.29.0) → #1361 MQ4 `not (…)` for MQ3 engines (iOS ≤16.3, Chrome
<104); #1105 parens (→ #1114); #213 custom-media negation. Ask: parses in the lowered-for engines, true
for the same widths? Detect: `engine-legacy-2021` (no range syntax) → O3/O4 (800px viewport, L6);
`media-queries/*mq3*`, `media-queries/*min-*`, `media-queries/*range*`.

## transition-animation

**ANI-1 Parallel lists misaligned**: #850 (1.28.2, unreported) re-indexes `transition-property` but not
`transition-duration` (`-webkit-backdrop-filter,opacity,backdrop-filter` + `1s,2s,3s` → opacity 3s).
Ask: a distinct value per entry. Detect: O1; `transition-animation/community-prs-transition-*`.

**ANI-2 Shorthands engines reject or read differently**: f4408c7 (1.25.0) folds `animation-timeline` into
`animation` → #1283, #1369 (Chrome drops it; `none` read as fill-mode); compat key per PFX-2 (PR #1306,
whose no-targets branch conflicts with #1350 "no targets = perfect browser"). `AnimationName::None`
prints nothing else (src/properties/animation.rs:667-668): `animation:.5s ease-out both` → `none` (#337;
PR #879). 39964f1 (1.26.0) → #1226 `entry exit 0%`; #1012 duration `0s`; #1214 `transition:inherit`
merged. Ask: output sets/resets exactly the input's longhands, in a form targets accept? Detect: O3, O1,
O7, R2; `transition-animation/*timeline*`, `*/*without-name*`, `transition-animation/*animation-range*`,
`transition-animation/*inherit*`.

**ANI-3 `@keyframes` deleted**: named timeline ranges ≤1.25 (fixed by #787); one invalid item deletes the
keyframe (#1103). Detect: `transition-animation/*keyframe*`.

## transform

**TR-1 Composition, identity, interpolation**: cc54e46 folded individual transforms into `transform` →
#426, #1099 → #1340 (master; also ends the accidental lowering for Safari <14.1/Chrome <104, a
maintainer decision under `engine-legacy-2021`). `translate: none` → `0` (fixed by #703),
`rotate: 0deg` → `none` (fixed by #1147): `none` vs identity changes stacking. 6d46cce: no matrix
outside [0,360). #1335 needs two passes. Ask: each rewritten list interpolates like the original (L5: reason it)? Detect: O1, O6, R2;
`transform/*individual*`, `transform/*none*`, `transform/*rotate*`.

## color

**CLR-1 Panic on unresolvable colors**: #522 (20c9612); system colors in `color-mix()` (2983614 1.24.0 →
#819 1.28.0); #722 (1.25.0) fixed RGB/LAB only → #800 P3 → #801. Still on master: text-shadow
(src/properties/text.rs:1502, :1513, :1522), `CssColor::get_fallback` (src/values/color.rs:511-521):
open PR #1311. Ask: grep diff and siblings for `to_rgb()/to_p3()/to_lab().unwrap()`; test RGB/P3/LAB
branches × `currentcolor`/system color. Detect: R1 + `retarget-legacy`; `color/*no-panic*`, `*/*currentcolor*`.

**CLR-2 Static evaluation drops `none`/space**: 1.30.0, likely #465 (4ebcb45), made `color-mix()` with
`none` resolvable through an interpolation that drops it (#1368, PR #1376); polar zero alpha → `none none`
(#1194); token-list rewrites (#1272); legacy↔modern spelling in gradients changes the interpolation
space. Detect: O1 (`none`→number is `different`), O5; `color/*none*`, `color/spec-color-gradient-*`.

**CLR-3 `light-dark()` polyfill**: 808ce79 (1.24.0) → #821/#873 (by design); #1152 (1.32.0) made `light
dark <custom-ident>` `Unparsed`, so `ColorSchemeHandler` (src/properties/ui.rs:554-564) emits no
`--lightningcss-*` vars (unreported). N5: `!important` color-scheme gets a normal dark rule. PR #1287:
breaking per Devon. Ask: which handlers match a `Property::` variant the parser now rejects? Detect: dark
jobs + O4 (`engine-legacy-2023`); `color/*light-dark*`, `ui-misc/*color-scheme*`.

**CLR-4 Shared constants**: #1323 widened a constant shared with the black/white cutoff; review caught
`oklch(99.995% .01 0)` turning white. Detect: O5, O4; `color/*gamut-map*`.

## gradient-image, background

**GRD-1 Prefixed gradients minified with standard rules**: `LinearGradient::to_css` elides 180deg and
flips 0deg regardless of `is_prefixed` (src/values/gradient.rs:268-300); `LineDirection::to_css` (:501)
maps legacy keywords to modern angles. #936 (c5cbcfa, 1.30.0) → minified default gradients flip
(`-webkit-linear-gradient(#00f,red)`, unreported), also for modern targets: Chrome 100-112 lack unprefixed
`image-set()` and use the `-webkit-` copy. #1107 open (#918 closed by #936); src/lib.rs:14210-14213 expects a reversed
output. Ask: every shortcut gated on `is_prefixed`; lowering tests also minified? Detect: O6; O4 with
`engine-legacy-2023` (Chromium 110); `gradient-image/*prefixed-gradient*`, `gradient-image/*legacy*`.

**GRD-2 `image-set()`**: `1x` omitted (fixed by #264); `x` → `dppx` in token lists (dcbb9b8, #1286).
Detect: `gradient-image/*image-set*`. background: GRD-1 covers `background-image`; `Position::to_css` is shared
with mask-position and gradient `at` (#1124); a `-webkit-gradient` moved after a later `var()` (RM-4).
`background/*`.

## border-outline, effects-masking, text, ui-misc

**BOR-1 All-default shorthands print nothing**: `border-image: none` → `border-image:` (#1146; PR #1336
approved); mask-border reuses border-image initials; `-webkit-border-image` loses its implied `fill`.
Detect: R2, O1; `border-outline/*border-image*`. effects-masking: PFX-1, PFX-3, CLR-1.
text: PFX-3 (#872), CLR-1; `text-shadow` spread printed when it is a non-px zero, a 4-length shadow no
engine accepts (`!= NonNegative::zero()`, src/properties/text.rs:1438-1445; #981). `text/*`.
ui-misc: caret (RM-4, PFX-1), `list-style: none` → `outside` (97891d8 1.29.0 → e3b1e88, npm 1.29.1),
color-scheme (CLR-3), print-color-adjust (PFX-2). `ui-misc/*`.

## font

**FONT-1 Family unquoting/dedupe**: 41dfaa4 dedupe (1.13.0) → #1221 `monospace, monospace` collapses
(16px → 13px; PR #1250). #1064 (1.31.0; merged uncompilable, 4e6492b) leaves `"Serif Gothic"` and single
edge spaces unquoted (src/properties/font.rs:423-425). Ask: re-parse and compare family names? Detect: O1
(L3), R2; `font/*family*`, `font/*monospace*`.

**FONT-2 `font` shorthand**: `FontStretch::to_css` prints a percentage whenever minifying
(font.rs:264-272), invalid inside `font` (#1140); folding the longhands resets kerning (unreported).
Detect: O3, O1; `font/*stretch*`, `font/*longhands*`.

## flex-grid-align, display-layout, box-model-size

**LAY-S Unequal values collapsed**: `PlaceSelf::to_css` treats `JustifySelf::Auto` as equal and Stretch as
Normal (src/properties/align.rs:509-512) → #1182 (PR #1302); grid-template dropped a row (≤1.30.2 →
#1132), which drops `grid-auto-columns` (unreported) and pads `grid-template-areas` (layout-equal:
classify, not a regression). Ask: omitted values follow the spec rule? Detect: O1, O7;
`flex-grid-align/*place-*`, `flex-grid-align/*grid-*`. display-layout, box-model-size: RM-4, PFX-1.

## logical

**LOG-1 Lowering changes cascade**: side rules land after the base rule, more specific (#1179, #1018;
src/context.rs:94 TODO); `!important` dropped (context.rs:111, and :146 for the dark rule; N5). #927 `var()` shorthands not lowered; PR
#1227 copies `inset: 0 var(--x)` into each longhand. Ask: `dir=rtl` DOM, a later physical declaration,
`!important`? Detect: O1/O4 (`engine-legacy-2023` lacks `:dir()`); `logical/*`.

## custom-properties

**CP-1 Token-list whitespace**: stripping broke `var()` substitution (#976) → 32f1f52 (1.31.0) → #1141
`var(--x, )` grows each pass (→ #1142), #1378 size. Detect: R2, S2; `custom-properties/*var-empty-fallback*`,
`custom-properties/*comment*`.

**CP-2 Typed ↔ `Unparsed`**: a failed typed parse silently becomes `Unparsed`, skipping lowering,
renaming and handlers (#1152, #973, #927, #762); a typed property rejecting `var()` fails the sheet
(`all: var(--x)`, d7aeff3 → #752). Detect: O7 (WPT `valid-became-invalid` / `computed-difference`); `custom-properties/issues-important-all-var-accepted`.

**CP-3 Grammar-blind token rewrites**: units (#1286), `none` (#1368), integers rounded to 6 digits (#949,
src/properties/custom.rs:544). Detect: `custom-properties/*verbatim*`, `custom-properties/*integer*`.

## values-numeric, calc-math, printer-serialization

**NUM-1 One sibling serializer fixed**: `--7.45e-9` (#899) → #901 (numbers, 1.29.2) → #1192 (dimensions,
1.33.0); percentages still print `--10e-8%` (src/values/percentage.rs:64-72, #1219). Ask: same input
per numeric type, in `calc()` and token lists. Detect: R2, O3; `values-numeric/*sci*`.

**NUM-2 Invalid made valid, fallback deleted**: unitless numbers as px (src/values/length.rs:145-147,
#682/#1199); `calc(<length> - 0)` accepted (#928; src/lib.rs:8538 pins `calc(1px + 1)`); nested `@property` (#1090 →
#962). Detect: O7 `invalid-became-valid`; O1 on `values-numeric/*unitless*`, `*/*override-valid`,
`*/*keeps-fallback`.

**CALC-1 Panics, recursion**: #827 → e3c8e12 (1.28.0); `calc((a - b) + (c + d))` with unlike units
recurses forever (src/values/calc.rs:955 ↔ percentage.rs:421), SIGSEGV 1.18-1.33 (#910; PR #1245 also
changes other sums); #1131 fixed min/max/clamp only; the percentage `unreachable!()` (#1312) is gone on
master (b0939ab, percentage.rs:38-42), so `calc-math/community-prs-sign-percentage-panic` is stale;
#1098 exponential `atan2`; #1371 (PR #1377). Ask: each math shape in every slot, deeply nested.
Detect: R1; `calc-math/*crash*`, `calc-math/*panic*`, `calc-math/*overflow*`. Printer: open PR #1025
drops the hex-escape space; `printer-serialization/*`.

## css-modules

**CSSM-1 New identifiers hashed or not**: #1133 (1.31.0) hashes `:state(checked)` via
`CustomIdent::to_css` (unreported); `match-element` hashed since 1.20.0 → #1274 (master);
`:nth-child(of S)` lacked a printer arm (#883); `var()` skips renaming (#762); PR #860 unwraps `global()`
without CSS modules. Ask: hashed per spec (UA/JS names never), consistent with references and exports?
Detect: output assertions (L8); `css-modules/*`.

## parser-syntax, at-rules-other

**PAR-1 errorRecovery changes control flow**: a8b7ea0 (1.22.0) clears the declarations before any
error (src/parser.rs:494-498) → #1358 (`.a{color:red;@keyframes k{…}height:2px}` keeps only `height`); keyframes
parsed with default options (#1103); SUP-2. Ask: same output, no new warnings, only the bad item
dropped? Detect: `*/*error-recovery*`; realworld runs with `error_recovery: true`. at-rules-other:
`@property` context (#962, #968), SEL-1; `at-rules-other/*property*`.

## visitor-api, bindings-api, bundler, sourcemap, build-release, perf

- **API-1 serde round trips**: #1062 (1.30.2, no test changes) → #1065, #1081 (identity visitors fail on
  any `var()`), #1188 (PR #1357); #1079 selector flags lost. Detect: none (no visitor mode); B5.
- **API-2 AST/TS/semver**: #1147 (`ast.d.ts` `{xyz}` vs runtime `{x,y,z,angle}`; scripts/build-ast.js
  unwraps only Translate/Scale); #880 → #1251/#1261; #784 variant in a `parcel_selectors` patch; #739 C
  bindings. Detect: B5, B7, B8, B10, B11.
- **Build/other**: #932 → #1024 → #1030; #892 worker segfault (d302a6b); #1388 engines ≥24 (UNVERIFIED
  impact); #1167 source-map index race; #1074 `@import layer()`; #1098, #1382 exponential parses (R1).

## Likely-wrong open PRs

| PR | class | problem | guard |
|---|---|---|---|
| #1227 | LOG-1 | multi-value `var()` shorthand copied to each longhand | `logical/pr1227-multi-value-var-shorthand` |
| #1156 | NS-3 | `&` made to represent a pseudo-element | `nesting/pr1156-amp-cannot-represent-pseudo-element` |
| #1025 | printer | hex-escape space dropped, not idempotent | `printer-serialization/pr1025-hex-escape-before-space` |
| #860 | CSSM-1 | `global()` unwrapped without CSS modules | `transition-animation/pr860-global-fn-without-css-modules` |
| #1356 | CP | `@function` `var()` resolved from the calling rule | flag-on probe needed |
| #1123 | NS-1 | side rules hoisted into the parent | `nesting/pr1123-logical-after-nested-rule` |
| #1178, #1284 | PFX-2 | hand-edited `src/prefixes.rs` | B11 |
| #1309 | SEL-1 | old input becomes a hard error | parse-error deltas |

## Top 15: what to check first

1. **Handler order (RM-4)**: shorthand↔longhand, typed→`var()`, both prefix orders, distinct values.
2. **Earlier declaration dropped (PFX-1)**: prefix × target support × importance × shorthand between.
3. **Rule-level passes (RM-1..3, LAY-1)**: every selector, `!important` and layer position survives; R2.
4. **Nested declarations (NS-1, NS-2)**: declarations after a nested rule keep side rules in place.
5. **Fallback semantics (GRD-1, MQ-1, SEL-2)**: minified lowering; O4 in the engine using it; O6.
6. **Parser tightening (SEL-1)**: base-accepted selectors/at-rules still parse; warnings unchanged.
7. **Shorthand round trip (ANI-2, LAY-S, BOR-1, FONT-2, TR-1)**: omitted parts are defaults; `none` ≠ identity.
8. **Incomplete fixes**: grep the pattern, one test per sibling (#722→#801→#1311, #901→#1192→#1219).
9. **Panics (CALC-1, CLR-1)**: `unwrap`/`unreachable!` in the diff, nested math, `currentcolor`; R1.
10. **errorRecovery (PAR-1, SUP-2)**: identical output, no warnings for valid input.
11. **Typed ↔ `Unparsed` (CP-2)**: handlers keyed on the variant still fire; `var()` still parses.
12. **Specificity (SEL-3, NS-3, LOG-1)**: spec specificity through `:has`/`:global`; native nesting on `::after`.
13. **Compat data (PFX-2)**: regenerated, partial support excluded, mobile keys not overwriting desktop.
14. **Serialization (NUM-1, CP-1, CP-3)**: print(parse(print(x))) = print(x) per numeric type and token list.
15. **Identifiers and API (CSSM-1, API-1/2)**: hashing per spec; `ast.d.ts` regenerated; identity visitor.
