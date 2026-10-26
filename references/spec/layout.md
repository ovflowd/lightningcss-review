# Layout, sizing, UI and other at-rules: spec digest

`<spec>#<anchor>` = `https://drafts.csswg.org/<spec>/#<anchor>`.

## Cross-cutting

- **Invalid stays invalid.** A value an engine rejects must stay Unparsed, so the earlier valid declaration keeps
  winning. A loose or empty-accepting grammar deletes it. Probe `P:valid;P:invalid`.
- **Order.** Buffered (owned) properties print at finalize, after unknown names, aliases and Unparsed values
  pushed at once; FallbackHandler/PrefixHandler write a later value into the first slot.
- **Reset-only sub-properties** a shorthand resets without naming: `position` → `position-anchor`; sizing-4 `size`. No
  engine implements these yet: the oracle reads `equivalent`, so assert output order.
- **Oracle limits.** legacy-2021 supports `gap`, `inset`, `place-*` and two-value `overflow` (not `clip`), so O4
  cannot test those gates: assert output. Shorthand strings differ by engine (`grid`, `flex-flow`).

## Flexbox

- `flex: none | [ <'flex-grow'> <'flex-shrink'>? || <'flex-basis'> ]`; omitted grow/shrink = 1, omitted basis
  `0` (engines read `flex:1` back as `1 1 0%`). A unitless zero not preceded by two factors is a factor, so
  `flex:1 0px` ≠ `flex:1 0` (css-flexbox-1#flex-property).
- A % basis against an indefinite container behaves as `content`: `0%` ≠ `0px`, and `calc(0% + X)` must keep its
  `0%` (css-flexbox-1#flex-basis-property).
- 2009 lowering (w3.org/TR/2009/WD-css3-flexbox-20090723): ordinal groups start at 1 (`order:n` → `n+1`); no
  equivalent for space-around/-evenly or `baseline`; IE ignores a unitless `-ms-flex` basis.
- Engines lay out `display:-webkit-box` from `-webkit-box-*` (standalone, never flex longhand
  aliases): a correct lowering can read as `different`. `-webkit-box-orient:vertical` is part of the line-clamp idiom (css-overflow-4#propdef--webkit-line-clamp).

## Alignment and gaps

- `place-self`/`place-items`: an omitted second value copies the first; `place-content`: copies it, but a
  `<baseline-position>` gives `start` (css-align-3#place-self-property, #place-items-property). `auto` ≠
  any other value and `stretch` ≠ `normal`.
- `flex-start`/`flex-end` are legacy aliases of `flow-start`/`flow-end`: do not canonicalize before engines ship.
  `anchor-center` is valid only on `*-self`.
- `gap: <'row-gap'> <'column-gap'>?` of `normal | <length-percentage [0,∞]> |
  <line-width>` (css-gaps-1#column-row-gap); support differs by layout context. `grid-gap`/`grid-row-gap`/`grid-column-gap` are name aliases: order against `gap` decides.

## Grid

- `repeat()` takes `<integer [1,∞]>` and at least one track size (css-grid-2#repeat-syntax); an
  `<auto-track-list>` has exactly one `<auto-repeat>` and only fixed sizes beside it (#typedef-auto-track-list;
  grid-3 relaxes this only for grid lanes).
- Line-name and `<grid-line>` idents exclude `span` and `auto`; `span` takes `<integer [1,∞]>`. An omitted end
  copies a custom-ident start, else `auto` (#placement-shorthands).
- Areas are filled rectangles with equal column counts (#grid-template-areas-property).
- Areas form `[ <line-names>? <string> <track-size>? <line-names>? ]+ [ / <explicit-track-list> ]?`: leading
  names name the line before the row, trailing names the line after (#explicit-grid-shorthand).
- Area rows not sized by `grid-template-rows` use `grid-auto-rows` (#auto-tracks); folding must not make them
  explicit `auto`. `grid` resets `grid-auto-*`, not gaps. `.` padding changes the computed areas string, not layout.

## Display

- `<display-outside> || [<display-inside> | math]`, or `<display-outside>? && [flow | flow-root]? && list-item`;
  each keyword once, `list-item` only with flow/flow-root (css-display-3#the-display-properties). Serialize the
  most backwards-compatible, then shortest, form (#display-value-summary).
- Prefixed `display` values override `display:flex` only where accepted: all engines accept `-webkit-box`,
  `-webkit-inline-box`, `-webkit-flex`; none accepts `-moz-box` or `-ms-flexbox`.
- `overflow: <'overflow-block'>{1,2}` (x then y); `overlay` = legacy `auto`; `clip` may pair with a scrollable
  axis. `clip` is newer than `hidden`: a `hidden` fallback must survive for older targets. `overflow` resets
  `overflow-inline`/`-block`, which are not lowered.
- `position` resets `position-anchor` (css-anchor-position-1#propdef-position-anchor).
- `<integer>` calc() rounds to nearest, ties toward +∞ (css-values-4#css-round-to-the-nearest-integer);
  `column-count` is `<integer [1,∞]>`.

## Sizing

- `<box-size> = <length-percentage [0,∞]> | stretch | min-content | max-content | fit-content`
  (css-sizing-3#sizing-values); sizing-4 adds `contain`, `stretch()`, `fit-content()`, `size`/`min-size`/
  `max-size` (css-sizing-4#propdef-size; the @page `size` descriptor is unrelated).
- Prefixed ladders: `stretch` → `-webkit-fill-available`, `-moz-available`; `fit-content` → `-moz-fit-content`.
  Firefox rejects `width:stretch` and accepts both prefixed forms; Chromium/WebKit reject `-moz-available`.
- Unitless non-zero numbers are lengths only in quirks mode. `scroll-margin-*: <length>` (negatives, no `%`, no
  `auto`, css-scroll-snap-1#propdef-scroll-margin); `scroll-padding-*: auto | <length-percentage [0,∞]>`.
- Out-of-range calc() is clamped at computed time (css-values-4#calc-range); a negative literal is invalid.
- `aspect-ratio: auto || <ratio>`; degenerate ratios behave as `auto`. `contain-intrinsic-*: auto? [none | <length [0,∞]>]`.
- Only Chromium/WebKit alias `-webkit-margin-start`/`-webkit-logical-width` (O9 split).

## UI

- `caret = <'caret-color'> || <'caret-animation'> || <'caret-shape'>` (css-ui-4#propdef-caret); no engine
  implements the shorthand. `caret-color` takes two values in css-ui-4.
- WebKit computes `user-select` and `-webkit-user-select` independently: an added prefix reads `different`.
  Old Firefox uses `color-adjust`; `-moz-print-color-adjust` never shipped.
- `list-style`: `none` sets whichever of image/type is not otherwise set; a counter style named
  `inside`/`outside` makes an omitted position ambiguous (css-lists-3#list-style-property).
- `counter-increment: a a` adds 2; `reversed(x)` ≠ `reversed(x) 0`; `content: X / ""` is decorative.
- `color-scheme: normal | [ light | dark | <custom-ident> ]+ && only?` is an ordered list
  (css-color-adjust-1#color-scheme-prop). The light-dark() polyfill works only where `color-scheme` is declared,
  not through inheritance.
- SVG keywords (`optimizeSpeed`, `crispEdges`, `geometricPrecision`) are ASCII case-insensitive.

## At-rules

- Only group rules nest in style rules (css-nesting-1#nested-group-rules); @property is valid inside
  @media/@layer/@supports, not in a style rule.
- `@page` (css-page-3#typedef-page-selector): `[ <ident-token>? <pseudo-page>* ]!` with no whitespace; pseudos
  `:left | :right | :first | :blank`, case-insensitive, repeats add specificity; names case-sensitive; 16 margin
  at-rules.
- `@position-try` (css-anchor-position-1#fallback-rule): same-name rules cascade like @keyframes; only inset,
  margin, sizing, self-alignment, position-anchor and position-area apply; `!important` invalidates that one.
- `@counter-style` (css-counter-styles-3#the-counter-style-rule): same-name rules replace each other whole; names
  case-sensitive; `none` and the non-overridable names (`decimal`, `disc`, `circle`, `square`,
  `disclosure-open`, `disclosure-closed`) invalidate the rule; unknown descriptors are ignored.
- `@namespace` precedes all but @charset/@import/@layer statements; prefixes are case-sensitive
  (css-namespaces-3#prefixes); an undeclared prefix invalidates the whole selector list.
- `@view-transition` (css-view-transitions-2#vt-rule-algo): only the last rule counts, no descriptor cascade.
- `@function` (css-mixins-1#function-rule) is a draft: behind a flag; `var()` resolves against the element.
- A printed name with an unescaped `}` closes the enclosing block: re-escape names.
