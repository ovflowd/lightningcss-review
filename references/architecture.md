# LightningCSS architecture for reviewers

How a change reaches output: pipeline, handler order, rule merging, lowering, blast radius. Refs are
master `cbeaf83` (1.0.0-alpha.72). "verified" = reproduced on a master build (Rust driver, true
parse+print); `UNVERIFIED` = read from code only. Bug ids: `N#` arch-core research, `F#`
arch-selectors-rules research, `RA#` found while writing this file. Probes: `corpus/probes/<id>`.

## 1. Pipeline

```
StyleSheet::parse_with (stylesheet.rs:146-210) -> Top/NestedRuleParser (parser.rs:161-1094)
  -> Property::parse: typed | Unparsed (declaration.rs:509-538, properties/mod.rs:700-726)
[napi] JS visitor (napi/src/lib.rs:752): sees unmerged rules, unlowered nesting/media, @custom-media
StyleSheet::minify (stylesheet.rs:225-266): ONE DeclarationHandler pair + PropertyHandlerContext;
  @custom-media pre-scan iff CUSTOM_MEDIA && should_compile!(CustomMediaQueries) (:232-244);
  CssRuleList::minify, recursive (rules/mod.rs:599-1048)
StyleSheet::to_css (stylesheet.rs:269-323) -> CssRuleList::to_css (mod.rs:1110-1172)
```

napi `transform`/`bundle`/`transformStyleAttribute` (napi/src/lib.rs:761, :896, :1019) and the CLI
(src/main.rs:208-213) **always** call `minify()`; JS `minify:false` only sets `PrinterOptions.minify`
(whitespace plus `dest.minify` shortcuts: `@media all` unwrapping, `transparent`). True
parse+print (probe `mode: print`) needs the Rust API.

- **Parse + plain print** canonicalize typed values even in print mode (verified): shortest colors, reduced
  `calc()`, collapsed rect shorthands (`margin:0 0 0 0`→`0`), no leading zero, single-colon CSS2
  pseudo-elements, `:is(.a)`→`.a`. Invalid values of known properties become `Property::Unparsed`
  (kept, never a parse error).
- **Minify time** (`MinifyOptions.targets`): handlers (shorthand collapse, declaration dedupe,
  fallbacks, property prefixes, logical lowering, `@supports`/dark side rules, 3D→2D transforms),
  rule merging/dedupe/splitting, selector downlevel decisions, `@keyframes`/`@supports` prefixes,
  custom media and `resolution` prefixes (media.rs:31-44), layers, unused symbols, empty rules.
- **Print time** (`PrinterOptions.targets` as `dest.targets.current`, incl. the `@supports` scope):

| Lowering | file:line | Condition |
|---|---|---|
| nesting: nested rules after parent, `&`→parent or `:is(parents)`, top-level `&`→`:scope` | style.rs:247, nesting.rs:95, mod.rs:1157, selector.rs:1457, :1767 | `Nesting` |
| media range/interval → `min-/max-`, `not (…)`, parens | media_query.rs:1188, :1204, :1142-1156 | `MediaRangeSyntax`, `MediaIntervalSyntax` |
| `@container` conditions: never lowered | container.rs:491-495 | always |
| `#rrggbbaa`→`rgba()` (all-zero→`transparent` if minifying) | color.rs:655 | `HexAlphaColors` |
| `light-dark(a,b)`→`var(--lightningcss-light,a) var(--lightningcss-dark,b)` | color.rs:708, custom.rs:1607 | `LightDark` |
| space-separated colors in token lists | custom.rs:1559, :1583 | `SpaceSeparatedColorNotation` |
| `clamp()`→`max(a,min(b,c))` | calc.rs:164 | `ClampFunction` |
| double-position stops split | gradient.rs:1045 | `DoublePositionGradients` |
| `x`↔`dppx` (always `x` in `image-set()`, image.rs:481) | resolution.rs:86 | `XResolutionUnit` |
| prefixed rule copies, `:is()`→`:-webkit-any()` | style.rs:213-239, selector.rs:1652-1680 | `vendor_prefix` set at minify |
| always-matching `@media` unwrapped | media.rs:51-56 | `dest.minify` |
| pseudo-class replacement, module names, `composes`, dependency placeholders | selector.rs:729, printer.rs:290-355, declaration.rs:202-213, url.rs:42-90 | printer options |

Verified: `print` + targets applies these rows but no `lab()` fallbacks or logical lowering.
Light-dark vars are defined at minify and consumed at print: one-sided targets break the pair.

## 2. Options and flags (exact names)

- `ParserOptions` (parser.rs:64-80): `filename`, `css_modules: Option<css_modules::Config>`,
  `source_index`, `error_recovery`, `warnings`, `flags`. `ParserFlags: u8` (:48-62): `NESTING`
  (read nowhere, nesting always on), `CUSTOM_MEDIA` (parser.rs:347, stylesheet.rs:232),
  `DEEP_SELECTOR_COMBINATOR` (`>>>`, `/deep/`), `SCROLL_NAVIGATION_CONTROLS`.
- `css_modules::Config` (css_modules.rs:30-49): `pattern` (`[hash]_[local]`), `dashed_idents`,
  `animation`, `grid`, `custom_idents`, `container`, `pure`.
- `MinifyOptions` (stylesheet.rs:97-103): `targets`, `unused_symbols`. `PrinterOptions`
  (printer.rs:16-38): `minify`, `source_map`, `project_root`, `targets`,
  `analyze_dependencies: Option<DependencyOptions{remove_imports}>`,
  `pseudo_classes: Option<PseudoClasses{hover, active, focus, focus_visible, focus_within}>`.
- `Targets` (targets.rs:197-205): `browsers: Option<Browsers>`, `include`, `exclude: Features`.
  `Browsers`: `android chrome edge firefox ie ios_saf opera safari samsung`, `major<<16|minor<<8|patch`;
  `from_browserslist` folds `and_chr`/`and_ff`/`op_mob` into desktop keys by minimum (:95-129).
- `Features: u32` (targets.rs:151-181; bit = index in build-prefixes.js:486-511, public in
  `node/flags.js`): 0 Nesting, 1 NotSelectorList, 2 DirSelector, 3 LangSelectorList, 4 IsSelector,
  5 TextDecorationThicknessPercent, 6 MediaIntervalSyntax, 7 MediaRangeSyntax, 8 CustomMediaQueries,
  9 ClampFunction, 10 ColorFunction, 11 OklabColors, 12 LabColors, 13 P3Colors, 14 HexAlphaColors,
  15 SpaceSeparatedColorNotation, 16 FontFamilySystemUi, 17 DoublePositionGradients,
  18 VendorPrefixes, 19 LogicalProperties, 20 LightDark; groups Selectors, MediaQueries, Colors.
- Decisions (targets.rs): `is_compatible(f)` is **true without browsers** (:226-228), so hand-written
  fallbacks collapse (`color:red;color:lab(..)`→`lab(..)`, by design, #826). `should_compile(f,flag)` =
  `include⊇flag || (!exclude⊇flag && !is_compatible(f))` (:230-232); `should_compile!(t, X)` needs
  `X` in both `compat::Feature` and `targets::Features` (:317-324). `should_compile_selectors()`
  (:238-241): excluding **any** selector feature disables all selector splitting/downleveling (#1375).
  `prefixes()` (:243-253) only expands unprefixed input. Handlers decide which duplicates survive
  from `targets.browsers` directly (macros.rs:230, margin_padding.rs:195, prefix_handler.rs:116):
  include/exclude do not affect it.
- JS `transform` (napi/src/lib.rs:563-584): `filename projectRoot code targets include exclude minify
  sourceMap inputSourceMap drafts{customMedia,scrollNavigationControls}
  nonStandard{deepSelectorCombinator} cssModules analyzeDependencies{preserveImports} pseudoClasses
  unusedSymbols errorRecovery customAtRules visitor`. The CLI (src/main.rs:22-66) cannot set the deep
  combinator, include/exclude, unused symbols or pseudo-classes.

## 3. Declaration handling

`DeclarationBlock::minify` (declaration.rs:238-264): important declarations through
`important_handler`, then normal ones through `handler` (`handle_property(..) || decls.push(..)`),
then `handler.finalize`, `important_handler.finalize`; separate vectors, normal printed first
(:186-234). During `important_handler.finalize`, `is_important` still holds the last normal
declaration's `false` (if any): `@supports` side entries must be added at handle time (all current ones are).

**Output order of one importance group** = handle-time pushes in input order (unowned properties,
Unparsed of unowned ones, fallback/prefix/color-scheme handler output, custom properties, mid-block
flushes), then `direction`, `unicode-bidi`, then buffered handlers in dispatch = finalize order
(declaration.rs:578-612, :695-731; first claimant wins): background (prefixed images re-appended
at finalize) → border (+ border-image, border-radius) → outline → flex (+`order`, 2009/2012
aliases) → grid → align/justify/place/gap (+legacy box-pack) → size (+logical) → margin →
padding → scroll-margin → scroll-padding → font (`font` + 7 longhands) → text (text-decoration*,
text-emphasis*, `text-align`) → list-style → transition → animation (not `animation-composition`) →
display → position (ignores Unparsed, #1225) → inset → overflow/-x/-y (no mid-block flush) →
transform/translate/rotate/scale → box-shadow → mask (+mask-border, -webkit-mask-box-image) →
container → color-scheme* → fallback* (color, text-shadow, filter, backdrop-filter, fill, stroke,
caret-color, caret) → prefix* (transform-origin/-style, backface-visibility, perspective(-origin),
box-sizing, tab-size, hyphens, text-align-last, text-decoration-skip-ink, text-overflow, user-select,
appearance, clip-path, box-decoration-break, text-size-adjust, print-color-adjust) → `handle_all`
(`all` drops everything before it except custom props/direction/unicode-bidi, :646-674) →
custom properties* (dedupe by name, later value overwrites the **first** slot, P3/LAB fallbacks →
`@supports` side rules except in keyframes, :614-693). `*` = immediate. Unowned, pushed at once: many
typed properties (opacity, z-index, white-space, SVG props, mask-type, animation-composition…) and
every unknown one (font-feature-settings, font-kerning, overflow-inline, transition-behavior…).

| Pattern | Where | Mid-block flush when | Emits |
|---|---|---|---|
| `shorthand_handler!` | macros.rs:207-327 (list, container, outline) | key set again with `!is_compatible` value; any Unparsed member (:248-257) | shorthand if all keys set (+fallbacks), else longhands |
| `side_handler!` | margin_padding.rs:171-415 | logical↔physical change (:190-199); incompatible value; 2nd Unparsed logical | 4-side shorthand only if all set; block axis→top/bottom; inline axis→`add_logical_rule` unless start==end (:384-400) |
| other buffered | background … mask | incompatible value, Unparsed, prefix/logical change | shorthand or longhands, prefixed copies, fallbacks |
| index, immediate | PrefixHandler (prefix_handler.rs:9-77) | — | same value or prefix: overwrite in place, union prefixes; `finalize` empty (:54) |
| index, immediate | FallbackHandler (:79-181) | — | 1st: `get_fallbacks()` then value; later: overwrite slot unless incompatible; Unparsed overwrites |

Reorder classes (the most frequent breakage):
- **B, owned shorthand vs unowned longhand**: `shorthand; longhand-it-resets` inverts. Verified:
  `font` + its reset-only longhands (font-feature-settings, -kerning, -variant-* but not -caps, -variation-settings,
  font-width…; #1207, font.rs:879 TODO), `transition`+`transition-behavior`
  (#1084), `overflow(-x)`+`overflow-inline/-block` (N8), `mask-border; mask`, `-webkit-mask` +
  `-webkit-mask-composite`, `grid-gap`, `position`+Unparsed (#1225). Probes
  `rule-merging/font-reset-only-subproperties-stay-after-font`,
  `rule-merging/overflow-inline-after-overflow`.
- **C, in-place overwrite**: `user-select:none;user-select:var(--x);user-select:text` →
  `user-select:text;user-select:var(--x)`; `-webkit-backdrop-filter` rewritten by a later unprefixed
  value (#1327, #695).
- **A, invalid typed value wins**: empty/invalid input parses as typed (`filter:`, `text-transform:`,
  `flex:`, unitless px #1199, unchecked ranges) and replaces the valid earlier declaration
  (`rule-merging/invalid-color-replaces-valid`).

## 4. Rule-list minification (`CssRuleList::minify`, mod.rs:599-1048)

Step 0 `coalesce_adjacent_conditional_rules` (:544-597, #1263): adjacent equal `@media`/`@supports`/
`@container` are concatenated **before** their contents are minified. Then per rule:

| Rule | Behavior | Lines |
|---|---|---|
| anything but LayerBlock/LayerStatement/Ignored/Style-without-nested | clears `layer_rules` | :615-624 |
| `@keyframes` | minified in Keyframes context; same name+prefix: **later replaces earlier at the earlier index** (N2: wins over an intervening `@media` copy; N3: old `@supports` fallbacks stay after it); same frames: prefixes merged; P3/LAB token fallbacks as `@supports` copies | :626-666 |
| `@media`/`@supports`/`@container` | merged into the **immediately previous** output rule if equal, then re-minified; dropped if empty (`@media` also if `never_matches`) | :672-711 |
| `@layer` block / statement | block merges into the remembered same-name block (not minified here); statement becomes empty placeholder blocks | :712-750 |
| style rule | §4.1 | :752-916 |
| `@font-feature-values` | same family list merged into the first | :950-962 |
| `@property` | same name: later replaces earlier in place (F15: weaker validation than browsers) | :968-979 |
| `@counter-style`, `@position-try`, `@font-palette-values` / `@font-face`, `@page`, `@namespace`, `@import`, unknown | removed if unused / never merged | |

Layer post-pass only `if has_layers` (:986-1044): minifies each block, empty named blocks → merged
`@layer a,b;`, empty anonymous blocks removed. `has_layers` is set only for **named** layers
(:716-729), so anonymous `@layer{}` contents are not minified or lowered unless the same list also has
a named layer block or statement (N6, verified both ways;
`cascade-layers-scope/anonymous-layer-contents-lowered`).

### 4.1 One style rule

1. `StyleRule::minify` (style.rs:56-105): unused symbols, pure-modules check, declarations, nested
   rules under a **child** `PropertyHandlerContext`.
2. Split (:759-793) if >1 selector, `should_compile_selectors()`, `!is_compatible`: `:is()` supported +
   no pseudo-element + **equal specificities** → wrap as `:is(list)`; else incompatible selectors become
   clones.
3. `update_prefix` (style.rs:173-178): `get_prefix` + `downlevel_selectors` → `vendor_prefix`.
4. `merge_style_rules` with the previous output rule (:1051-1108), then backward cascade with
   `rules.pop()` (:796-816). A: `selectors==`, both compatible, no nested rules, same module source →
   append declarations, **re-run `DeclarationBlock::minify`**. B: `declarations==`, no nested rules →
   union prefixes if `is_equivalent`, else append selectors if both compatible.
5. Side rules (`get_supports_rules`, `get_additional_rules`, context.rs:93-226) for the rule and each
   clone, then `reset()` (:822-841); with nested rules the rule splits into base, side rules,
   nested-rules clone (:846-862).
6. Dedupe (:864-890) for non-merged rules without nested rules: key = ahash(selectors, [(property id,
   important)]) (style.rs:152-160), equal = same selectors and same ids+importance in order
   (:165-171); the earlier rule becomes `Ignored`; skipped across module files. Values are not
   compared: without targets this deletes non-adjacent author fallback rules (by design).
7. Output: `[base] [ltr, rtl :dir rules + dark @media rule, re-minified (:894)] [@supports fallbacks]
   [clones + their side rules] [nested-rules clone]`.

Known breakage: **N1 = F1** (verified) `.a{color:red}.b{color:blue}.b{color:red}.b{color:green}` →
`.a,.b{color:red}`: the popped index stays in `style_rules` and the next rule pushed there matches
itself. Same family as **#1235** (hash cached before in-place merges: missed dedupe, per-process
nondeterminism from `AHasher::default()`, style.rs:153; a stale slot can also erase a later rule
with nested rules, `rule-merging/stale-dedup-index-drops-nested-rule`); open PR **#1236** fixes all
three (drops popped indices). #1260/#1310/#1318: clones made after merge A drained the declarations
vanish. #907: all selectors incompatible → `@supports`/`:dir` rules with an empty selector that
LightningCSS cannot re-parse (:779-789). F14: dedupe drops an earlier `composes`.

Relied on: §13 invariants 2-7; adjacency exceptions are keyframes, `@property`, font-feature-values,
layers and dedupe (#225); merges are re-minified at :676, :689, :703, :894, :905.

## 5. Lowering

- **Fallbacks**: `IsCompatible` (traits.rs:291-306, 57 impls) decides whether an earlier declaration
  stays and whether selectors merge. `get_fallbacks` (traits.rs:165-167) returns values printed
  before the main one and may rewrite it (colors: RGB/P3 copies, main may become LAB,
  color.rs:503-597). `compat::Feature::is_compatible` is false for a targeted browser below the
  minimum **or without data** (compat.rs:237).
- **Token lists**: `TokenList::get_fallbacks` (custom.rs:1052) → lowest fallback in place, others as
  `@supports (color: color(display-p3 0 0 0))`/`(color: lab(0% 0 0))` side rules
  (`add_conditional_property`, StyleRule context only, context.rs:158-183).
- **@supports scope**: features of the condition's values are added to `exclude` while minifying and
  printing the block (supports.rs:41-60, :73-84); `not`/`or` disable it (:184).
- **Prefixes**: `VendorPrefix` declares WebKit, Moz, Ms, O, None (vendor_prefix.rs:22-33); iteration
  follows declaration order, so prefixed copies print first (properties/mod.rs:864-872, style.rs:222).
  `Targets::prefixes` → generated `prefixes_for` + `is_flex_2009`/`is_webkit_gradient`
  (prefixes.rs:2248-2294). `@supports` operands get target prefixes at minify (supports.rs:153-169).
  The parse-time operand merge (:236-252) loses the prefix of every non-first operand
  (`(display:grid) and (-webkit-appearance:none)` → `(appearance:none)`, verified; #710 open, PR
  #1316) and merges same-value prefixed operands even under `and` (N4 = F5).
- **Logical**: `should_compile_logical` (false in style attributes, context.rs:74-82; margin/padding,
  size, border, border-radius, `text-align:start/end`, transition-property, inset). Block axis is
  renamed in place (ignores writing-mode); inline axis → `add_logical_rule` → `get_additional_rules`
  appends `:dir(ltr|rtl)` to each selector with **normal-only** declarations (context.rs:93-156; N5,
  `logical/important-logical-lowering-keeps-important`). Minified as a list, so
  `:dir(rtl)` → `:lang(ae,ar,arc,bcc,bqi,ckb,dv,fa,glk,he,ku,mzn,nqo,pnb,ps,sd,ug,ur,yi)` and
  `:dir(ltr)` → `:not(:lang(…))` (selector.rs:2108). A documented heuristic, **not equivalent**
  (website/pages/transpilation.md:412-430): `dir=rtl` without an RTL `lang` gets LTR values. Specificity +(0,1,0)
  (context.rs:94 TODO, F20); later physical declarations lose (#1179, verified); NestedDeclarations
  (after a nested rule, or leading ones in a nested `@media`) leak (#1381/#1023).
- **light-dark()**: `ColorSchemeHandler` (ui.rs:556-586) pushes `--lightningcss-light/dark` and an
  `@media (prefers-color-scheme:dark)` side rule; values become `var()` pairs at print. Needs
  `color-scheme` on an ancestor (transpilation.md:336, by design). `color-scheme:… !important` leaves
  the dark rule normal, so dark mode never applies (N5).
- **Side-rule leaks**: only the Style arm drains side lists. `NestedDeclarationsRule::minify`
  (nesting.rs:73-84) leaks them onto the next sibling or drops them (#1023/#1381/#1246/#1049;
  `nesting/nested-declarations-side-rules-leak-to-sibling`). **RA1 (verified, no issue
  found):** keyframes (keyframes.rs:120-130) too: `@keyframes k{from{margin-inline-start:1px}}
  .x{color:red}` (safari 11) → `@keyframes k{0%{}}` plus `.x:not(:lang(…)){margin-left:1px}…`; a
  keyframe `color-scheme:light dark` (chrome 90) attaches its dark rule to `.x`.
- Style attributes never lower logical properties and drop `@supports`/dark side rules
  (context.rs:74-82, :158-161): the WPT lane (StyleAttribute, #1328 adapter) cannot see §4-§5 bugs.

## 6. Selectors and nesting

- `parcel_selectors` (Servo fork): `==`/`Hash` include specificity and flags (parser.rs:713). Unknown
  pseudos are raw `Custom`/`CustomFunction`, never compatible, never merged (selector.rs:1994, :2022).
- Recovery: `:not()` unforgiving; `:is()`/`:where()` forgiving, no pseudo-elements (#760); `:has()`
  and `:nth-child(of)` wrongly forgiving (selectors/parser.rs:2846, :2934; F8).
- Specificity (builder.rs:285-377): `:has()` 0 (#1324), `&` 0 (TODO); only src/ consumer mod.rs:769.
- `is_compatible` (selector.rs:1836-2039) gaps: `:not(<complex>)` passes for Chrome < 88 (F12), `s`
  attribute flag treated as `i` (F11), `:scope`→Shadowdomv1. No targets: every known selector merges.
- Downlevel (:2126-2192): `:dir()`→`:lang()`; `:lang(a,b)`→`:is(:lang(a),:lang(b))`;
  `:not(a,b)`→`:not(:is(a,b))`; combinator-free `:is()` → `-webkit-any`/`-moz-any` copies +
  unprefixed, with combinators only `:is()` (#312). `get_prefix` (:2075-2106) yields one prefix per
  rule (two different → empty set, no copies).
- Pseudo parse/print tables (:97-352, :677-876, :1177-1311) must stay inverses (F16:
  `::-ms-input-placeholder` parsed as Moz). Printing (:1433-1834): `:has(:scope)`→`:has()` (F7).
- Nesting parse: nested rules `parse_relative(…, Implicit)` (parser.rs:1000-1014), `.a{.b{}}`→`& .b`;
  AFTER_NESTING lost in `:nth-child(of &)` (F9). Declarations after the first nested rule →
  `NestedDeclarations` (:1041-1081); leading ones in nested `@media` → invisible NestedDeclarations
  (:532-555). Allowed in style rules (:262-290): media, supports, container, -moz-document, layer,
  starting-style, scope, nest, unknown, custom.
- Nesting lowering (print, style.rs:242-333): parent block, unknown at-rules kept inside, nested rules
  after it under `with_context`. `serialize_nesting` (selector.rs:1742-1773) prints the plain parent
  only for a single parent with leading `&` or a simple type-free parent, else `:is(parents)` **even
  for targets without `:is()`** (Chrome < 88, Safari < 14). Pseudo-element parents: lowered output
  matches, native nesting matches nothing (#352). In `@scope`, lowered `&` prints `:scope`
  (#1189) and `&` in `<scope-end>` becomes scope-start (F6).
- Visitors round-trip selectors through serde without HAS_PSEUDO/SLOTTED/PART
  (selectors/serialization.rs:687-701, F13): mod.rs:768 may then wrap pseudo-elements in `:is()`.

## 7. Media queries, @supports, @container

- Without error recovery one bad query fails the whole rule (media_query.rs:54-82; spec: `not all`).
  `(min-width)` → boolean `(width)` (#1366).
- Empty `MediaList` prints `not all` while `always_matches()` (:118-126 vs :167-170; F3, print mode
  only). `not (width = X)` → `(width = X)` (`Equal.negate()`, :950; F2, since 7f29035).
- Range lowering: `>`/`<` → `not (max-/min-…)` (7f29035, #228/#864); intervals (:1197-1208,
  :1522-1573); relies on old engines accepting MQ4 `not (…)` (UNVERIFIED Chrome < 104, Safari < 16.4).
- `resolution` gains `-webkit-`/`-moz-device-pixel-ratio` copies (:95-115). Custom media
  (:1758-1890) hoists the custom query's type/qualifier to the outer query: wrong under `not`/`or`
  (#213, `media-queries/custom-media-or-media-type`).
- `MediaList::and` (:132-149, :367-417; bundler): `not print` ∧ `(min-width)` → ¬(print ∧ …) (F4d).
- `@supports`: operand bugs in §5; `selector()` kept raw. `@container`: `style()` values go through
  the property printer (minified).

## 8. CSS modules

Renaming happens in the printer (`write_ident`/`write_dashed_ident`, printer.rs:290-355): classes/ids
everywhere incl. `:not/:is/:where/:has/:nth-child(of)`; `:global()` suspends it (selector.rs:838-843);
`@keyframes`+`animation` (`animation`), `@counter-style`+`list-style` (`custom_idents`; `counter()`
not renamed, F19), grid names (pattern must end with `[local]`), containers, dashed idents only with
`dashed_idents` (`transition: --x` not renamed, F19). `composes` only in single-class selectors,
consumed at print (declaration.rs:202-213). Hash = std `DefaultHasher` (css_modules.rs:538-549): a
Rust toolchain bump can rename every class. Oracle skips modules (L8): assert output text.

## 9. Bundler and dependencies

`load_file` (bundler.rs:361-613) composes per `@import`: media via `MediaList::and` (F4d), supports
AND, layer `parent.child`; anonymous parent + unlayered child → no layer (:502-523, F4a); non-leading
layer statements double-prefixed (:476-482, F4b); re-imports OR media/supports, adopt a layer only if
none (:364-411, F4c/F4e); `order` keeps the **last** instance (:668-711); `inline` wraps
layer→media→supports (:791-813). `analyzeDependencies` drops `@import` into `ImportDependency`
**without layer** (#1074, dependencies.rs:52-89). Oracle never follows `@import` (L7).

## 10. Compat data

`scripts/build-prefixes.js` (manual; locked autoprefixer 10.5.4, caniuse-lite 1.0.30001806, BCD
8.0.7) writes `src/prefixes.rs`, `src/compat.rs`, the `Browsers`/`Features` blocks of
`src/targets.rs`, `node/targets.d.ts`, `node/flags.js` (:532-692), then rustfmt. caniuse: first `'y'`
version. MDN: earliest entry without `alternative_name`/`flags`, so **prefix and partial entries count
as support** (:433-437; #1283/#1369 `animation-timeline`), and mobile keys **overwrite** desktop
(:449-450; N7: `opera 90` gets bare `lab()`; `MediaRangeSyntax` opera 71 vs chrome 104,
compat.rs:1826-1844). Hand-written: p3Colors,
LangSelectorList, CustomMediaQueries = never. Regeneration with the locked deps reproduces master
modulo rustfmt (verified): diff a data PR against a regeneration (B11). `compat::Feature` has ~22
dependent files (selector.rs uses ~44 features), `prefixes::Feature` 23: one data change can flip
fallbacks, logical lowering, selector splitting, **rule merging** and print-time lowering.

## 11. Printer

`whitespace()`/`delim()`/`newline()` (printer.rs:184-215; 48/137/55 call sites). Rule lists skip
`Ignored`, move `@import` into dependencies, add `;` after minified NestedDeclarations
(mod.rs:1110-1172). Numbers: `f32`, 6 significant digits, no leading zero (number.rs:122-140);
integral dimensions via `value as i32`, saturating at `2147483647px` (length.rs:518). Strings
double-quoted; `url()` unquoted when shorter. Source-map columns: `write_str` adds bytes,
`write_char` 1 (printer.rs:143-178) vs UTF-16 `Location.column` (UNVERIFIED impact).

## 12. Change impact map

Mutation gaps: `wrap-layer` uses a **named** layer (misses N6) and `nest` never puts declarations
after a nested rule (misses #1023), and none puts logical properties in `@keyframes` (RA1): use
probes for those. Dependent counts = files importing the unit (grep at cbeaf83), approximate (±1).

| Unit (file:line) | Direct dependents | Blast radius | Must test |
|---|---|---|---|
| `DeclarationBlock::minify`, handler order (declaration.rs:238-264, :578-731) | style.rs:90, nesting.rs:81, keyframes.rs:126, mod.rs:1074, stylesheet.rs:395 | order/survival of every declaration | `reverse-decls`, `important`, `var-before/after`; class-B probes; O1, R2, T2 |
| one handler (`properties/<x>.rs`) | declaration.rs | its group, unowned longhands it resets, merge A | `reverse-decls`, `var-after`, `prefixed-sibling`, `duplicate-nonadjacent`, `retarget-*`, `engine-legacy-*`; O3, O4, O7 |
| shorthand macros, `side_handler!` (macros.rs:207-717, margin_padding.rs:171-415) | list, contain, outline, sides; CSSOM API | collapse, fallbacks, importance (macros.rs:463-466) | `important`, `var-before`, `retarget-legacy`; tests/test_cssom.rs; O4 |
| `enum_property!`, derive `Parse`/`ToCss` (macros.rs:1-91, derive/src/parse.rs:44-140) | 34 / 27 files | keyword enums; variant order = parse priority | `upper-props`; O7; print-mode probes |
| `define_properties!` (properties/mod.rs:172-1623) | declaration.rs:524, container.rs:298, handlers | Unparsed fallback, prefixes, logical groups, AST | name the new property's owner or test `shorthand; new-longhand`; O7, B11 |
| `PropertyHandlerContext` (context.rs:84-226) | 31 files | side rules, importance, context gating | `important`, `wrap-supports`, `retarget-legacy`, `engine-legacy-2021`; `logical/*`, `nesting/*nested-decl*`; O1, O4 |
| `CssRuleList::minify` (mod.rs:599-1048) | 11 call sites (stylesheet, style, media, supports, layer…) | every rule list | `duplicate-nonadjacent`, `wrap-*`, `nest`, `important`, `retarget-*`; `rule-merging/*`; R2, S1, O1 |
| merge + cascade (mod.rs:796-816, :1051-1108) | mod.rs:800, :808 | cascade order, per-engine selector validity | `prefixed-sibling`, `retarget-legacy`; `rule-merging/*stale*`, `*incompatible*`, `attr-s-flag-merge`; O1, O3 |
| dedupe (mod.rs:864-890, :1212-1259; style.rs:152-171) | mod.rs:875, :1232 | deletes earlier rules | `duplicate-nonadjacent`, `important`, `nest`; `rule-merging/*stale-dedup*`; R2; run twice |
| keyframes, `@property`, layer, conditional merging (mod.rs:544-750, :968-1044) | parser.rs:409, :879; bundler | winning definitions, layer order | `wrap-media`, `wrap-layer`, `wrap-supports`, `important`; `rule-merging/keyframes-*`, `cascade-layers-scope/*layer*`; R2; L5 |
| side-rule placement (mod.rs:822-913) | — | order, empty selectors (#907), clones (#1260) | `nest`, `retarget-legacy`; `rule-merging/all-selectors-*`; R2 |
| `StyleRule::to_css`/`update_prefix`, `NestedDeclarationsRule` (style.rs:173-333, nesting.rs:73-123) | mod.rs:795, :832, :929 | print-time nesting, prefixed copies, side-rule leaks | `nest` × `retarget-none`/`engine-legacy-2023`; `nesting/*`; O1, O3, O4 |
| selector compat/downlevel (selector.rs:1836-2226) | mod.rs:761, :786, :1058, :1097; style.rs:117, :174 | merging, `:is()` wrap, `:dir`, prefixed rules | `retarget-*`, `engine-legacy-*`; `rule-merging/*`, `selectors/*`; O3, O4 |
| selector printing (selector.rs:1433-1834), `selectors/parser.rs`, `builder.rs` | printer; 13 files; mod.rs:769 | every selector, recovery, wrap choice | `nest`; `selectors/*`; B7, O3 |
| `media_query.rs` | 9 files | conditions, negation, print lowering | `wrap-media`, `retarget-legacy`, `engine-legacy-2021`, print + minify modes; `media-queries/*`; O3 |
| `supports.rs` | parser.rs:322, :583; context.rs; import.rs | operand prefixes, feature scope | `wrap-supports`, `prefixed-sibling`; `supports-container/*prefixed*`; O3 |
| targets, compat, prefixes, `build-prefixes.js`, `vendor_prefix.rs` | 41 / 22 / 23 / 29 files | every lowering and merge decision; JS `Features` | `retarget-*`, `engine-legacy-*`, `prefixed-sibling`; regenerate + diff (B11); O4, S2 |
| `printer.rs`, `number.rs:122`, `length.rs:513` | 82 / 38 / 27 files | whitespace, maps, modules, numbers | print + minify modes; `printer-serialization/*`; O7, R2, S2 |
| `parser.rs`, `stylesheet.rs` | every rule type; napi, c, CLI | placement, nesting, error recovery (#1358) | `nest`, flag `error-recovery`; `parser-syntax/*error-recovery*`; R1, B5, B10 |
| `bundler.rs`, `dependencies.rs`, `css_modules.rs` | napi bundle; printer | `@import` composition (F4), names | bundler and node tests (B5); `css_modules_test` tuples; L7, L8 |
| `serialization.rs`, derive `Visit`, `selectors/serialization.rs` | 89 uses / 74 files | JS AST, visitors (F13) | B11 (`node/ast.d.ts`), B5 |

## 13. Global invariants

1. Importance is structural: separate vectors and handlers, normal printed first; nothing moves a
   declaration across lists or creates one without deciding importance (N5 violates it).
2. Only the immediately previous output rule is merged.
3. `rules` indices are stable within one `CssRuleList::minify` (`Ignored` placeholders).
4. One handler pair per sheet; every `finalize` fully resets; side lists are drained only by the Style
   arm (`reset()`, mod.rs:841): any other declaration-minifying path must drain or suppress them
   (#1023, RA1).
5. Handler output order (§3) is safe only if no owned property resets an unowned one.
6. Merged selector lists must be valid in every target; unknown/prefixed pseudos never merge.
7. Minify is idempotent and its output re-parses (#907, #1235 break it).
8. `minify()` and the printer get the same targets.
9. Unparsed is opaque: it flushes the handler and overrides earlier declarations (IACVT).
10. Prefixed copies print before the unprefixed one.
11. `should_compile!` pairs identically named `compat::Feature`/`targets::Features` variants.
12. `derive(Parse)` variant order is parse priority; output is deterministic except where `ahash`
    seeds reach dedupe (#1235).

## 14. Fragile spots

| file:line | Hazard |
|---|---|
| rules/mod.rs:875 | `unsafe { &*(&rules as *const _) }` aliases the vec while it is mutated |
| rules/mod.rs:804-816 | `rules.pop()` leaves the key (N1, #1235) |
| rules/mod.rs:643-648, :973-978 | in-place `@keyframes`/`@property` replacement (N2, N3, F15) |
| rules/mod.rs:716-729 | `has_layers` only for named layers (N6) |
| rules/mod.rs:779-789, :1064-1071 | side rules for empty selectors (#907); clones after drain (#1260) |
| rules/nesting.rs:73-84, rules/keyframes.rs:120-130 | side lists filled, never drained (#1023, RA1) |
| rules/supports.rs:236-252 | operand prefix lost (#710), and/or-agnostic merge (N4) |
| context.rs:94, :106-112 | `:dir` specificity TODO; side rules never `!important` (N5) |
| parser.rs:496-498 | any item error clears the block's declarations; with `error_recovery` the warning names only the at-rule (#1358, verified; without it parsing fails) |
| properties/prefix_handler.rs:54 | empty `finalize`; indices survive into the next block |
| properties/masking.rs:566/569 | `MaskMode` and `MaskBorderSource` share bit 1<<7 |
| values/color.rs:703 | float rgb/hsl/hwb with `none` printed as hex |
| selectors/parser.rs:2846, :2898, :2934 | forgiving `:has`/`:nth-child(of)` (F8); AFTER_NESTING lost (F9) |
| printer.rs:143-178, :376, :382 | byte vs char columns; unsafe transmutes |
| scripts/build-prefixes.js:433-437, :449-450 | partial/prefixed MDN = support; mobile overwrites desktop |

Panics: internal `unreachable!()` (vendor_prefix.rs:50, rules/mod.rs:1197, :1226; grid.rs:1251-1275
via visitor/serde ASTs). Release is `panic = 'abort'` (Cargo.toml:126-129); debug adds
`debug_assert!` and overflow checks.

## 15. Test helpers → probe modes

Every module-level stylesheet helper in src/lib.rs runs parse → `minify()` → `to_css()`. The
harness records leaf helpers only; local helpers shadow module ones (`test` in `test_relative_color`).

| Helper (src/lib.rs) | minify() targets | Printer | Probe mode |
|---|---|---|---|
| `test` (:76) → `test_with_options` (:131-145); `nesting_test_no_targets` (:295) | none | pretty | none (`lower` needs targets); `minify` = same transforms |
| `minify_test` (:163) → `minify_test_with_options` (:168) → `minify_test_with_options_and_browsers(None)` (:173-200) | none | compact | `minify` (+flags) |
| `minify_test_with_options_and_browsers(.., Some(b))` | b | compact, b | `lower-minify` |
| `prefix_test` (:217-237) | b | pretty, b | `lower` |
| `nesting_test` (:260-271) | chrome 95 | pretty, chrome 95 | `lower`, `targets: chrome 95` |
| `nesting_test_with_targets` (:273-293) | full `Targets` | same | `lower`; include/exclude only via tuples |
| `test_with_printer_options` (:147-161); `custom_media_test` (:387-414) | none; chrome 95 | caller's; **none** | none (one-sided targets, tuple `printer_targets`); flag `custom-media` |
| `css_modules_test` (:346-385) | none | per arg | flag `css-modules`; exports unchecked |
| `attr_test` (:239-258) | b | b | adapter kind `attr` |
| `property_range_test` (:101-129) | — | compact | adapter kind `value` (typed vs Unparsed) |
| `error_test*`, `css_modules_error_test` | — | — | `expect: parse-error` (not `#[track_caller]`) |
| `minify_error_test_with_options` (:202-215), `error_recovery_test` (:432-456) | — | — | tuples only; flag `error-recovery`; warnings unchecked |
| bundler `bundle` (bundler.rs:957-961) | no `minify()` | pretty | none (L7) |
| — | — | — | `print`: no `minify()`, adapter only; with `targets:` isolates print-time lowering |

