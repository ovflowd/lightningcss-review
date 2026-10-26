# Layout, sizing, UI and other at-rules: spec digest

Areas: `flex-grid-align` §2-4, `display-layout` §5-7, `box-model-size` §6/§8, `ui-misc` §9, `at-rules-other` §10
(outline rows in §9 belong to `border-outline`). From the research reports (lost), re-checked 2026-10-26 with the
master driver and the harness oracle (`lcr baseline`: Chromium 156, Firefox 157, WebKit 27.2). `file:line` = master
`cbeaf83`. `<spec>#<anchor>` = `https://drafts.csswg.org/<spec>/#<anchor>`. **FAILS** = master output wrong
(verified); ok = verified correct. Compat numbers: BCD 8.0.7 (pinned in yarn.lock).

## 0. Read first

1. **Class A: invalid input becomes a typed value and deletes the valid fallback.** A WPT pair scan
   (`.t{P:valid;P:invalid}`, 3,232 invalid cases, 20 layout spec dirs, re-run 2026-10-26) loses the valid
   declaration in 129 cases: auto-repeat 42, scroll-margin 33, caret-color 11, unitless px 10, grid idents/span 10,
   trailing line names 8, `list-item` 7, `symbols()` 6, flex 1, outline-style 1. Empty values are typed too. The
   one-declaration WPT oracle (PR #1328) cannot see this class.
2. **Class B/C: ordering.** Owned properties are buffered and emitted at flush/finalize in handler order
   (`declaration.rs:695-731`; list in `architecture.md` §3). Unknown names, legacy aliases
   (`grid-gap`, `-webkit-margin-start`, `-webkit-logical-width`), reset-only sub-properties and Unparsed values are
   pushed at once, so they jump ahead of a buffered value (B). FallbackHandler and PrefixHandler write a later value
   back into the first slot (`prefix_handler.rs:24-38`, `:120`, `:151`) (C).
3. **Targets.** `browsers: None` makes every feature supported (`targets.rs:226-228`): authored fallbacks and
   prefixed duplicates collapse by design (#826); `targets: {}` also strips authored prefixes. Fallback probes need
   targets.
4. **Print mode is not neutral**: pretty `grid-template` output can be invalid (INV-GRID-001b).
5. **Oracle blind spots** (`equivalent` today): no engine implements the `caret` shorthand, `position` resetting
   `position-anchor`, `outline:auto` setting `outline-color:auto`, or `size`. Use output assertions.

## 1. Specs read (drafts.csswg.org, webref grammars; EDs unless noted)

css-flexbox-1 2026-05-08, -2 2026-10-21 · css-align-3 2026-10-21 · css-gaps-1 2026-10-08 ·
css-grid-2 CRD 2023-10-30, -3 2026-10-21 · css-display-3/-4 2026-06-05 · css-sizing-3
2026-10-08, -4 2026-10-10 · css-values-5 2026-09-04 · css-box-4 2026-08-06 · css-position-3 2026-05-14, -4
2025-12-25 · css-anchor-position-1 WD 2026-09-06 · css-overflow-3/-4/-5 2026-08..10 · css-contain-2 2026-10-15 ·
css-scroll-snap-1 2026-09-08 · css-page-3 2026-10-21 · css-ui-4 WD 2026-10-15 · css-lists-3 2026-04-28 ·
css-counter-styles-3 2026-10-08 · css-color-adjust-1 CRS 2026-05-07 · css-view-transitions-2 2026-08-31.

## 2. Flexbox (`src/properties/flex.rs`)

Grammar ([css-flexbox-1#flex-property](https://drafts.csswg.org/css-flexbox-1/#flex-property)):
`flex: none | [ <'flex-grow'> <'flex-shrink'>? || <'flex-basis'> ]`; initial `0 1 auto`; `none` = `0 0 auto`;
omitted grow/shrink = 1; omitted basis = `0` per spec but `0%` in every engine (`flex:1` reads back `1 1 0%`).
"A unitless zero that is not already preceded by two flex factors must be interpreted as a flex factor."
`flex-basis: content | <'width'>`. `order: <integer>`. css-flexbox-1#webkit-aliases: `-webkit-flex*`/`-webkit-order`.

- INV-FLEX-001 ok: a zero basis keeps its unit or all three values print (`flex:1 0px` ≠ `flex:1 0`; 84298d2).
- INV-FLEX-002 **FAILS**: `0%` ≠ `0px` basis (a % basis against an indefinite container acts as `content`,
  #flex-basis-property). `flex:1 1 calc(0% + 10px)` → `flex:10px` (`percentage.rs:408` drops zero operands).
- INV-FLEX-003 **FAILS**: empty values are invalid. `flex-flow:column;flex-flow:` → `flex-flow:row`
  (`flex.rs:78-103`); `flex:2;flex:` → `flex:1`.
- INV-FLEX-004 **FAILS** (no targets): in `display:-webkit-box`, engines lay out from `-webkit-box-pack/-align/
  -orient/-ordinal-group`. AlignHandler clears box_pack/flex_pack on `justify-content` and box_align/flex_align on
  `align-items` without a target check (`align.rs:910-913`, `:940-943`); FlexHandler clears only with targets
  (`flex.rs:531-596`). Oracle: the box falls back to `start`/`stretch` in all three engines.
- INV-FLEX-005 **FAILS**: `order:n` must lower to `-webkit-box-ordinal-group:n+1` (2009 groups start at 1;
  autoprefixer adds 1). Copied 1:1 (`flex.rs:353-358`): `order:0` → group 0 (invalid), `order:1` stays in group 1.
- INV-FLEX-006: `-webkit-box-pack:start/end` follow box-direction, `justify-content:start/end` the writing mode,
  so the lowering is only right for non-reversed boxes (needs a 2009 engine; documentation only).
- INV-FLEX-007 ok: `flex-wrap: wrap balance` (flexbox-2) passes through in order.
- line-clamp **FAILS** (targets): `-webkit-box-orient:vertical` must survive `flex-direction`/`flex-flow`
  (css-overflow-4#propdef--webkit-line-clamp); `flex.rs:531-536` clears it. #710 is the `@supports` variant
  (`supports.rs:225-252`).

Conformance: flex*/order typed (`mod.rs:1331-1338`; grow/shrink/basis `NonNegative`, #1329); 2009 `box-*` and 2012
`flex-*` typed legacy (`:1355-1374`). 2009 lowering needs `is_flex_2009` (Chrome 4-20, Safari 3.1-6.0, iOS 3.2-6.0,
Android 2.1-4.2, no Firefox; `prefixes.rs:2248`); space-around/-evenly and `baseline` have no 2009 mapping. IE 10
gets `-ms-flex:1 1 0` from `flex:1 1 0px` (IE 10-11 drop a unitless basis, flexbugs #4). Firefox-only targets get
`-moz-box-*` longhands but no `display:-moz-box` (`display.rs:436`).

## 3. Box alignment and gaps (`src/properties/align.rs`)

Grammar (css-align-3): `*-self: auto | normal | stretch | <baseline-position> | <overflow-position>?
<self-position>` (+ `left | right` for justify-*). `place-self`/`place-items`: an omitted second value copies the
first (#place-self-property, #place-items-property). `place-content`: copies the first, but a
`<baseline-position>` gives `start`. `justify-items: legacy` alone is valid; `first baseline` serializes as
`baseline`. Gaps (css-gaps-1#column-row-gap): `normal | <length-percentage [0,∞]> | <line-width>`;
`gap: <'row-gap'> <'column-gap'>?`; `grid-gap`/`grid-row-gap`/`grid-column-gap` are legacy name aliases.

- INV-ALIGN-001 **FAILS** (#1182 open, PR #1302): `X auto` ≠ `X`, `normal stretch` ≠ `normal`. `PlaceSelf::to_css`
  treats `JustifySelf::Auto` as equal and compares Stretch with `AlignSelf::Normal` (`align.rs:509-512`);
  `PlaceItems` has the same Stretch arm (`:779-780`). `align-self:self-start;justify-self:auto` →
  `place-self:self-start` (Chrome: item width 200px → 8px).
- INV-ALIGN-002 ok: `place-content:baseline` prints `baseline start` (correct, not shortest).
- INV-ALIGN-003 ok: `flex-start`/`flex-end` are not rewritten to flow-* (Issue 14052).
- INV-GAP-001 **FAILS**: `row-gap`+`column-gap` always merge into `gap` (`align.rs:1168-1181`); compat.rs has no gap
  feature. `gap` multicol Chrome 66/Firefox 61/Safari 14.1, grid 66/61/12, flex 84/63/14.1; unprefixed multicol
  `column-gap` 50/52/10.
- INV-GAP-002 **FAILS** (class B): `gap:10px;grid-gap:20px` → `grid-gap:20px;gap:10px`.
- INV-GAP-003 ok: `<line-width>` gaps pass through with the fallback kept.

Conformance: align/justify/place/gap typed (`mod.rs:1341-1352`); `GapValue` = `normal | <length-percentage [0,∞]>`.
`place-*` are emitted only when compatible (`align.rs:1142`, `:1155`, `:1162`; PlaceSelf/PlaceItems Chrome 59,
Firefox 45, Safari 11), else longhands. `anchor-center`, `flow-start`, bare `legacy` pass through.

## 4. Grid (`src/properties/grid.rs`)

Grammar ([css-grid-2](https://drafts.csswg.org/css-grid-2/)):
- `repeat()` takes `<integer [1,∞]>` and at least one track size (#repeat-syntax). `<auto-track-list>` has exactly
  one `<auto-repeat>`, every other entry fixed (#typedef-auto-track-list); grid-3 relaxes this only for lanes.
- Line-name and `<grid-line>` idents exclude `span` and `auto`; `span` takes `<integer [1,∞]>`
  (#typedef-grid-row-start-grid-line). An omitted end copies a custom-ident start, else `auto`
  (#placement-shorthands).
- Areas are filled rectangles with equal column counts (#grid-template-areas-property).
- `grid-template` areas form `[ <line-names>? <string> <track-size>? <line-names>? ]+ [ / <explicit-track-list> ]?`:
  leading names belong to the line before the row, trailing names to the line after (#explicit-grid-shorthand).
- Area rows that `grid-template-rows` does not size use `grid-auto-rows` (#auto-tracks). `grid` resets grid-auto-*,
  not gaps.

- INV-GRID-001 **FAILS** (unfiled, since v1.0.1, 79b00f9): no slot 0 when row 1 has no leading names
  (`grid.rs:746-752`), so `"a" 10px [mid] "b" 20px` → `[mid]"a"10px"b"20px`; every later name shifts up a line
  (23 WPT valid cases).
- INV-GRID-001b **FAILS** (print only, e351bc3): `grid.rs:859-864` splits every two-name list as trailing + leading,
  so `[a b] "a"` prints `[a]` newline `[b] "a"` (invalid; 4 WPT cases in lower mode).
- INV-GRID-002 **FAILS**: `RepeatCount` takes any integer (`:190-197`), `TrackRepeat::parse` checks nothing
  (`:306-334`): `repeat(0,1fr)`, `repeat(2,)` are typed.
- INV-GRID-003 **FAILS**: `TrackList::parse` (`:425-451`) does not enforce the auto-repeat rules (42 WPT cases;
  `repeat(auto-fill,1fr)` is typed).
- INV-GRID-004 **FAILS**: `CustomIdent::parse` (`values/ident.rs:30-45`) excludes only CSS-wide keywords and
  `default`; `span 1 auto` → `span auto`.
- INV-GRID-005 **FAILS**: only `span 0` is rejected (`grid.rs:1403`); `span -1` is typed.
- INV-GRID-006 **FAILS**: only the column count is checked (`:561-585`); `"a b" "b a"` accepted.
- INV-GRID-007 **FAILS**: `TrackSizeList::parse` (`:502-513`) and `GridTemplateAreas::parse` accept empty input.
- INV-GRID-008 **FAILS**: folding makes rows sized by `grid-auto-rows` explicit `auto` (`:1785-1796`):
  rows `1fr`, areas `"a" "b"`, `grid-auto-rows:100px` → `grid-template:"a"1fr"b"/1fr`. The reverse (more rows
  than areas, #1130) is fixed by #1132's '.' padding (`:1856-1879`), which changes the computed
  `grid-template-areas` string with identical layout.
- INV-GRID-009 ok: `grid-row: a / auto` keeps `/ auto` (`can_omit_end`, `:1476-1484`).
- INV-GRID-010 ok: lists with auto-repeat, subgrid or repeat() rows are not folded into `grid-template`.
  INV-GRID-011 ok: `grid` does not reset gaps, so moving `grid-gap` before `grid` is harmless.
- auto-flow **FAILS** (regression from #1132, v1.31.0): `Grid::is_valid` returns early without checking
  auto_columns (`:1305-1311`), so `grid:auto-flow / 1fr 2fr;grid-auto-columns:10px;grid-template-areas:"a b"`
  drops `grid-auto-columns` (it panicked before, #1096).
- tokens **FAILS**: `grid-row:2;grid-row:1.0` → `grid-row:2;grid-row:1`: the Unparsed printer drops the number
  type flag (`custom.rs:544`), turning invalid into valid. `flex-grow:2e3.4` → `2000.4` (same printer).

Conformance: all grid properties typed (`mod.rs:1376-1390`). Six printing `unreachable!()` (`grid.rs:678`, `:835`,
`:887`, `:1251`, `:1261`, `:1275`) are reachable from visitor/serde ASTs (#1096 reached `:835` from CSS). CSS modules:
`var()` in `grid-template` makes it Unparsed and area names stay global (#762 open).

## 5. Display and visibility (`src/properties/display.rs`)

Grammar ([css-display-3#the-display-properties](https://drafts.csswg.org/css-display-3/#the-display-properties)):
`<display-outside> || [<display-inside> | math]`, or `<display-outside>? && [flow | flow-root]? && list-item`, or
internal/box/legacy keywords. Each keyword at most once; `list-item` only with flow/flow-root; `ruby` defaults to
inline. Serialize the short form, "most backwards-compatible, then shortest" (#display-value-summary).

- INV-DISP-001 **FAILS**: `DisplayPair::parse` accepts repeated `list-item` (`display.rs:135-138`):
  `display:grid;display:list-item list-item` → `display:list-item` (7 WPT cases).
- INV-DISP-002 ok: multi-keyword values map to the exact short form (`inline flow-root` → `inline-block`,
  `block flow list-item` → `list-item`); `block ruby` stays two keywords. Baseline is `different` only in WebKit
  27.2, which rejects `block flow list-item`, `inline flow list-item`, `inline list-item` and `block ruby` (O9).
- INV-DISP-003 **FAILS** (#1291 open, PR #1385): a later prefixed value overrides `display:flex` only where the
  engine accepts it. All three engines accept `-webkit-box`, `-webkit-inline-box`, `-webkit-flex` and reject
  `-moz-box`, `-ms-flexbox`. With targets, `display.rs:380-392` clears the earlier value:
  `display:flex;display:-ms-flexbox` (chrome 100) → `display:-ms-flexbox` (same for `-moz-box`; the `-webkit-box`
  variant is equivalent). Cross-rule, no targets: `.t{display:flex}.u{color:red}.t{display:-ms-flexbox}` drops the
  first rule (dedupe compares property ids only, `style.rs:152-171`; with an empty `.u{}` the rules merge instead).

Conformance: `display` typed (`mod.rs:1218`); `math`, `grid-lanes` pass through. DisplayHandler emits at finalize,
adding `-webkit-box`/`-moz-box` (2009 targets), `-webkit-flex`, `-ms-flexbox` (`display.rs:417-470`); without targets
`display:-webkit-box;display:flex` keeps both. `visibility` typed, unowned.

## 6. Position, inset, anchors (`position.rs`, `margin_padding.rs` InsetHandler)

- #1225 **FAILS** (open, PR #1387): a later `position: var()` must keep winning. PositionHandler has no Unparsed
  arm (`position.rs:98-114`); `direction`/`unicode-bidi` are buffered (`declaration.rs:646-657`) and pushed first
  (`:695-701`). position: every tested version; direction: since d7aeff3 (v1.25.0). Display, overflow, size, side,
  flex, grid, align and list handlers keep `X;X:var()` in order (checked).
- INV-POS-001 **FAILS per spec**: `position` resets `position-anchor` ("a reset-only sub-property of position",
  css-anchor-position-1#propdef-position-anchor), yet `position:absolute;position-anchor:--a` →
  `position-anchor:--a;position:absolute`. No engine resets it yet (baseline `equivalent`; BCD position-anchor:
  Chrome 125+ partial, Firefox 147 partial / 151, Safari 26 partial).
- INV-POS-002 **FAILS**: physical offsets merge into `inset` when LogicalInset is supported, but that feature comes
  from BCD `inset-inline-start` (`build-prefixes.js:286`: Chrome 87, Firefox 63, Safari 14.1) while the `inset`
  shorthand shipped in Firefox 66. `firefox 64` → `inset:0` (verified, unfiled).
- INV-POS-003 ok: renamed draft values pass through unnormalized (`position-area`, `position-try-fallbacks`,
  `anchor-valid`/`-visible`, `fit-tolerance`, `grid-lanes`).
- sticky ok: `-webkit-sticky` for Safari 6.1-12.1 / iOS 6.0-12.2 (`prefixes.rs:1358-1369`).

Conformance: `position` typed (`mod.rs:1242`), emitted at finalize. Offsets/`inset*` typed
`LengthPercentageOrAuto` (`:1243-1253`); `anchor()`/`anchor-size()` make them Unparsed. position-anchor,
position-area, position-try*, anchor-name, position-visibility pass through. `z-index` typed integer, unowned;
`z-index:calc(1)` stays Unparsed (`CSSInteger` has no calc, `values/number.rs:217`). PR #1122 adds integer calc:
round to nearest, ties toward +∞ (css-values-4#css-round-to-the-nearest-integer), unresolved with relative units.

## 7. Overflow, contain, scroll snap

Grammar: `overflow: <'overflow-block'>{1,2}` (x then y, css-overflow-3#propdef-overflow); `overlay` = legacy alias
of `auto`; Issue 12289 allows `clip` with a scrollable other axis. `text-overflow`: one value = end edge; two
values are Gecko-only. `scroll-margin-*: <length>` (no %, no auto, negatives allowed,
css-scroll-snap-1#propdef-scroll-margin); `scroll-padding-*: auto | <length-percentage [0,∞]>`.

- INV-OVF-001: the two-value form is ok: gated by OverflowShorthand (`overflow.rs:122`; Chrome 68, Firefox 61,
  Safari 13.1 = BCD `multiple_keywords`); #1319's floors (Chrome 90, Firefox 72, Safari 15.4) contradict BCD.
  **`clip` FAILS** (unfiled): `overflow:hidden;overflow:clip` (safari 15) →
  `overflow:clip`, `overflow-x:clip;overflow-y:auto` → `overflow:clip auto` (clip: 90/81/16).
- INV-OVF-002 ok (area `text`): a one-value `text-overflow` fallback survives a two-value declaration.
- INV-OVF-003: see line-clamp in §2.
- INV-OVF-004 **FAILS** (N8, unfiled): `overflow:hidden;overflow-inline:auto` → `overflow-inline:auto;overflow:hidden`;
  logical overflow is not lowered either (#540).
- INV-SNAP-001 **FAILS**: scroll-margin-* typed `LengthPercentageOrAuto` (`mod.rs:1416-1426`):
  `scroll-margin:5px;scroll-margin:auto` → `auto` (33 WPT cases). scroll-padding is typed right (`:1428-1438`).

Conformance: overflow, -x, -y typed (`mod.rs:1236-1238`); `overlay` Unparsed. `text-overflow` takes clip/ellipsis
only. Pass through (unknown, no dedupe, #688): overflow-clip-margin, scrollbar-*, line-clamp, `-webkit-line-clamp`,
contain, content-visibility, float, clear, columns/column-* (except column-gap), break-*, page-break-*.
`container-type` takes one keyword (`inline-size scroll-state` Unparsed; Devon on #1218: use bitflags).

## 8. Sizing and box model (`size.rs`, `margin_padding.rs`)

Grammar (css-sizing-3#sizing-values): `<box-size> = <length-percentage [0,∞]> | stretch | min-content |
max-content | fit-content`; sizing-4 adds `contain`, `stretch()`, `fit-content()`, and the `size`/`min-size`/
`max-size` shorthands (css-sizing-4#propdef-size). `min-*` initial `auto`. `aspect-ratio: auto || <ratio>`
(degenerate ratios = auto). `contain-intrinsic-*: auto? [none | <length [0,∞]>]`.

- INV-SIZE-001 **FAILS** (#1199/#682 open): unitless non-zero numbers parse as px (`length.rs:145-148`):
  `width:3` → `3px`, `grid:1 / 1` → `1px/1px`. Also typed: `calc(100px - 0)`, `calc(1px + 1)` (#928 closed not
  planned; `lib.rs:8538` pins it), so `margin-left:3px;margin-left:calc(100px - 0)` loses the 3px.
- INV-SIZE-002 ok on master (#1329, b0939ab, unreleased): negative calc() clamps (`width:calc(5px - 10px)` → `0`);
  negative literals stay Unparsed (#1000). css-values-4#calc-range.
- INV-SIZE-003 ok: a fallback before `contain` survives with targets (`Size::Contain` never compatible,
  `size.rs:153`, `:286`); without targets it is dropped by design (#826).
- INV-SIZE-004: ladders with targets ok (`stretch` → `-webkit-fill-available` + `-moz-available`; `fit-content` →
  `-moz-fit-content`; min/max-content → `-webkit-`/`-moz-`; #630: e255210 broke it in v1.22.1, 08efeeb fixed it in
  v1.23.0). **Panics** with `include: VendorPrefixes`: `targets.prefixes()` returns all four prefixes
  (`targets.rs:245-246`) and `Size/MaxSize::to_css` reach `unreachable!()` for `-o-`/`-ms-` stretch (`size.rs:124`,
  `:257`; #1371 open, PR #1377).
- INV-SIZE-005 ok: degenerate ratios kept (`1/0`; `0/1` → `0`, same ratio); `calc(4/3)` → `1.33333`.
- INV-SIZE-006: sizing-4 `size` is unknown and pushed first: `width:30px;size:10px 20px` → `size:10px 20px;
  width:30px` (matters once engines ship it; BCD has no entry; the @page `size` descriptor is different, §10).
- INV-SIZE-007 ok: `contain-intrinsic-size: auto <length>` passes through.
- INV-SIZE-008 **FAILS** (new, unfiled; class B): unknown legacy aliases are pushed before the buffered standard
  property: `margin-inline-start:10px;-webkit-margin-start:20px` → the alias first; same for `-webkit-padding-start`,
  `-webkit-logical-width` (vs `inline-size` or `width`), `-webkit-logical-height`. Oracle: Chromium 156 and WebKit
  27.2 `different` (they alias these names), Firefox 157 `equivalent`.
- order ok (#805/#547/#572: d18c223 v1.21.0 → fixed 22a8b6f v1.28.0): SizeHandler flushes on Unparsed
  (`size.rs:499`); side_handler! flushes before pushing an Unparsed physical side (`margin_padding.rs:271-285`).

Conformance: sizes typed `Size`/`MaxSize` with `NonNegative` lengths (#1329); `stretch()`, `fit-content()`,
calc-size() pass through. `box-sizing` is PrefixHandler (class C: `border-box;var(--x);content-box` →
`content-box;var(--x)`). `aspect-ratio` typed, unowned. margin/padding typed (`mod.rs:1392-1414`); shorthands only
when all four sides are set and compatible; logical sides lower through `:dir()`/`:lang()` (area `logical`).

## 9. UI, lists, counters, color-scheme, SVG (ui-misc; outline = border-outline)

- INV-UI-001/002 (outline, area border-outline): see `spec/images-effects.md` §5. New: the `outline:auto` collapse
  of INV-UI-002 is `equivalent` in all three engines today (none implements `outline-color:auto`).
- INV-UI-003 **FAILS**: any Unparsed value overwrites the slot of its FallbackHandler property (color, fill,
  stroke, caret-color, …; `prefix_handler.rs:148-152`), so an invalid or empty value replaces a valid one:
  `caret-color:red;caret-color:` → `caret-color:` (oracle: `different` in all three).
- caret **FAILS** (#1362 open, PR #1363, regression 2694a18 v1.21.0): `caret = <'caret-color'> ||
  <'caret-animation'> || <'caret-shape'>` (css-ui-4#propdef-caret). caret and caret-color have separate slots with
  write-back (`:120`, `:151`); caret-shape is unowned; `Caret` lacks caret-animation (`ui.rs:245-253`).
  `caret:red;caret-color:blue;caret:green` → `caret:green;caret-color:#00f`; `caret:` → `caret:auto`. Oracle-blind:
  no engine has `caret` (BCD: caret-shape Chrome 144+, caret-animation Chrome 140+ only).
- PrefixHandler **FAILS** (class C, all 17 of its properties): the first slot is updated in place
  (`prefix_handler.rs:24-38`): `user-select:none;user-select:var(--x);user-select:text` →
  `user-select:text;user-select:var(--x)`. #977 (open; PR #1091 is tests only): `-webkit-appearance:none;
  appearance:textfield` (chrome 87, firefox 78, safari 14) → a generated `-webkit-appearance:textfield` overrides
  the author's `none`.
- INV-LISTS-001 **FAILS** (unfiled): `list-style` omits the default position (`list.rs:414-440`), so `outside
  outside` → `outside` (type lost) and `outside inside` → `inside` (position flips) (css-lists-3#list-style-property);
  `list-style:` → `outside`. Oracle: `different` in all three.
- INV-LISTS-002 ok: `none` fills whichever of image/type is unset (#890: 97891d8 v1.29.0 → e3b1e88 v1.29.1).
- INV-LISTS-003 ok: `counter-increment: a a` adds 2; `reversed(x)` ≠ `reversed(x) 0` (passthrough).
- INV-CONTENT-001 ok: `content` alt text (`/ ""`) and repeated fallbacks survive (passthrough).
- color-scheme (`normal | [ light | dark | <custom-ident> ]+ && only?`, an ordered list) **FAILS**: order
  normalized (`ui.rs:486`: `dark light` → `light dark`). #1152 (v1.32.0) fixed `inherit` → `normal` (808ce79,
  v1.24.0) by making custom-ident values Unparsed, so the light-dark() polyfill now emits `var(--lightningcss-light,…)`
  without defining the variables (chrome 90, unfiled). Lowering is not idempotent (EM-132); `!important` is not
  carried into the dark rule (N5, `context.rs:84-112`). See `spec/color.md` C12-C13.
- SVG: #1108 made three keyword enums case-insensitive (output lowercased); `ColorRendering`/`ImageRendering` lack
  `#[css(case = lower)]` (`svg.rs:243`, `:306`): `optimize-speed` (invalid) is typed, `optimizeSpeed` stays Unparsed.

Conformance: typed in `mod.rs:1524-1564`, `:1621-1622`. counter-*, content, quotes, `object-fit`, `object-position`
pass through (typing them changes the visitor AST, #1046/#1047). Prefix data: `user-select` had a closed Safari range
(≤18.1 from 4159bc5 v1.28.2 to c03a7e7 v1.29.3; #925 open); `-moz-print-color-adjust` (Firefox 48-96, emitted
since #1102, v1.31.0) never shipped (BCD: `color-adjust`).

## 10. At-rules (at-rules-other)

- `@page` (css-page-3#typedef-page-selector): `<page-selector> = [ <ident-token>? <pseudo-page>* ]!`,
  `<pseudo-page> = : [left | right | first | blank]`; no whitespace inside; names case-sensitive, pseudos not;
  repeated pseudos add specificity; 16 margin at-rules; `size: <length [0,∞]>{1,2} | auto | [<page-size> ||
  [portrait | landscape]]`.
  - INV-PAGE-001 **FAILS**: names printed with `write_str` (`page.rs:290`): `@page \31 a` → `@page 1a` (LightningCSS
    rejects its own output), `a\7d b` → `a}b`, `a\:b` → `a:b`.
  - INV-PAGE-002 ok: `@page foo :first` is rejected. INV-PAGE-003 ok: `:first:first` kept.
  - INV-PAGE-004: non-standard `:last` accepted (`page.rs:39-50`). `:nth()` (GCPM) and nested unknown at-rules
    (`@footnote`, #678 open) are hard errors (errorRecovery drops just that rule). Declarations print before margin
    rules (harmless); never merged or lowered.
- `@position-try` (css-anchor-position-1#fallback-rule): `<dashed-ident>` name; same-name rules cascade like
  @keyframes; only inset, margin, sizing, self-alignment, position-anchor and position-area apply; `!important`
  invalidates that declaration. INV-POS-004: a generic DeclarationBlock (any property; `!important` kept, moved
  last); values minified, never merged into `inset` or lowered (verified, safari 12). The name is hashed with
  `position-try-fallbacks` under CSS modules dashedIdents and removable by unusedSymbols (#1238).
- `@counter-style` (css-counter-styles-3#the-counter-style-rule): same-name rules replace each other atomically
  (INV-COUNTER-001, ok: never merged); names are case-sensitive; `none` and the non-overridable names (`decimal`,
  `disc`, `circle`, `square`, `disclosure-open`, `disclosure-closed`) make the rule invalid
  (#non-overridable-counter-styles); an unknown descriptor is ignored (master keeps it). Descriptors are parsed as
  style properties (`counter_style.rs:22` TODO). CSS modules leave `system: extends X`, `fallback: X`,
  `counter(c, X)` unrenamed (EM-140).
- `@namespace`: must precede all rules except @charset/@import/@layer statements (`parser.rs:330-333`; later =
  hard error, dropped under errorRecovery); prefixes are case-sensitive (css-namespaces-3#prefixes); the URL prints
  as a string. INV-NS-001 **FAILS** (unfiled): `namespace_for_prefix` accepts any prefix (`selector.rs:378-380`), so
  `.t{color:red} ns|div{color:red}` (undeclared) or `SVG|rect` (declared `svg`) merges into `.t,ns|div{…}`, which
  browsers drop whole.
- `@-moz-document`: only `url-prefix()`/`url-prefix("")` parse (`parser.rs:641-660`), printed `url-prefix()`;
  `domain()` is a hard error even with customAtRules (the built-in name shadows them, #1171).
- `@view-transition` (css-view-transitions-2#vt-rule-algo): only the last rule counts and descriptors do not
  cascade (INV-VT-004, ok: not merged); unknown descriptors dropped; invalid values kept raw.
- Unknown at-rules: prelude and block kept as tokens; statements end with `;` (`unknown.rs:56-58`). **FAILS**: raw
  name (`unknown.rs:40`): `@a\7d z;` → `@a}z;` closes the enclosing block; Chrome loses the next rule (EM-04).
  Kept inside the parent when nesting is lowered (#1233, v1.33.0; 1.28.2-1.32.0 hoisted it: #1232, #896), but
  printed without the parent selector inside a nested `@media`. A napi custom at-rule without a body prints no `;`
  (`napi/src/at_rule_parser.rs:163-195`).
- Nesting context (css-nesting-1#nested-group-rules): only group rules nest in style rules. The early returns for
  `property`/`position-try` (`parser.rs:731-739`) skip the `allowed_in_style_rule` check (`:262`, used at `:744`):
  nested @property is accepted silently since #1090 (v1.31.0) and hoisted when nesting is lowered (#962 open, PR
  #1314). @property in @layer/@media/@supports is valid (#968, fixed by #1090). Context errors say "Unknown at rule"
  (#966).
- `@function` (css-mixins-1#function-rule, draft): PR #1356 puts it behind `drafts.customFunctions`; flag off =
  passthrough.

## 11. Engine divergences that affect the oracle

- Shorthand strings differ (`grid`, `flex-flow: row wrap` = `wrap` in Firefox/WebKit, `list-style`, `outline`).
- WebKit 27.2 rejects multi-keyword `list-item` forms and `block ruby` (§5). Firefox 157 rejects `width:stretch`,
  accepts `-moz-available` and `-webkit-fill-available` (BCD: alternative name since 146).
- `-webkit-box-*` are standalone legacy properties in Chrome/WebKit and `-moz-box-*` aliases in Gecko, never
  aliases of flex longhands. A correct 2009 lowering adds separate properties and can read as `different`: decide
  with output assertions and the 2009 WD (w3.org/TR/2009/WD-css3-flexbox-20090723).
- Only Chromium/WebKit alias `-webkit-margin-start`-style names (INV-SIZE-008 = O9 split). WebKit computes
  `user-select` and `-webkit-user-select` independently: an added prefix reads `different`.
- legacy-2021 (Chromium 97, Firefox 93, WebKit 15.4) supports `gap`, `inset`, `place-*`, two-value `overflow`: O4
  cannot test those gates (use `output-contains`). WebKit 15.4 lacks `overflow: clip`.
- No print media or anchor layout: @page, @position-try, @counter-style and @view-transition need output
  assertions (L5, L6).

## 12. Spec changes since 2023 that LightningCSS lags

- Do not canonicalize before engines ship: flow-start/flow-end (flex-* now legacy aliases, css-align-3 Issue 14052).
  Reject rather than type loosely: "fundamentally unsupported values must not be parsed as valid" (Issue 13421).
- New resets (reorder hazards): `position` → position-anchor (initial `normal`, INV-POS-001); `outline:auto` → color
  `auto` (INV-UI-002); `size`/`min-size`/`max-size` (INV-SIZE-006).
- Grammar a typed parser must accept: `<line-width>` gaps, gap decorations, list-valued column-rule (css-gaps-1,
  Issues 13089, 13312, 13477); `flex-wrap: balance`, `flex-line-count` (flexbox-2); `caret` with caret-animation,
  two-value `caret-color` (ui-4); `clip` beside a scrollable axis (Issue 12289); `stretch()`, new `fit-content()`.
- Not to be validated against older levels: `display: grid-lanes`, `fit-tolerance`, intrinsic auto-repeat
  (css-grid-3, Issues 10884, 10915); `anchor-center` only on `*-self` (Issue 13514).
- Passthrough only: position-visibility renames, line-clamp without max-lines, reading-order/-flow,
  `visibility: force-hidden`, margin-trim block+inline.
