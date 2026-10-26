# Checklist: flex-grid-align (prefix LAYOUT)
FlexHandler (`src/properties/flex.rs`), AlignHandler (`align.rs`: align/justify/place, gaps), GridHandler (`grid.rs`). Spec: `spec/layout.md` §Flexbox, §Alignment, §Grid. FAIL only when head introduces or widens a violation.

- [LAYOUT-01] (BLOCKER) `place-self`/`-items`/`-content` print one value only when the omitted one is exactly what the parser fills in (a copy of the first; `start` after a baseline in place-content): `self-start auto` and `normal stretch` keep both. Emitted only when every target supports the shorthand, else longhands.
  verify: `flex-grid-align/place-*`; keyword pairs per shorthand; retarget-legacy; https://drafts.csswg.org/css-align-3/#place-self-property.
- [LAYOUT-02] (BLOCKER) Folding into `grid`/`grid-template` re-expands to the same longhands: no row track or `grid-auto-*` dropped, no row sized by `grid-auto-rows` made explicit `auto`; else keep the longhands. '.' padding of areas is layout-equal (classify with the spec).
  verify: `flex-grid-align/grid-template-*`, `grid-auto-*`; enumerate every combination a changed `Grid::is_valid` admits; https://drafts.csswg.org/css-grid-2/#auto-tracks.
- [LAYOUT-03] (BLOCKER) In the areas form every line name keeps its line (leading names: line before the row; trailing: line after); pretty output keeps a leading two-name group as one bracket list; `grid-row`/`-column`/`-area` omit an end only when a custom-ident start copies to it.
  verify: `flex-grid-align/grid-template-*line-names*`, `grid-template-pretty-*` (mode print), `grid-placement-*`; https://drafts.csswg.org/css-grid-2/#explicit-grid-shorthand.
- [LAYOUT-04] (MAJOR) Engine-invalid values stay Unparsed and never replace an earlier valid one: `repeat()` count < 1 or no track, a second `<auto-repeat>` or flexible track beside one, `span`/`auto` as idents, negative `span`, non-rectangular areas, empty values (`flex:`, `gap:`), unitless lengths; Unparsed printing keeps number types (`grid-row:1.0` stays invalid).
  verify: `flex-grid-align/*override-valid`, `*empty-value`, `printer-serialization/token-number-*`; `P:valid;P:invalid` pairs; https://drafts.csswg.org/css-grid-2/#repeat-syntax.
- [LAYOUT-05] (BLOCKER) `flex` round-trips: a zero basis keeps its unit or all three values print (`flex:1 0` reads 0 as shrink), `0%` ≠ `0px` basis, `calc(0% + X)` keeps `0%`.
  verify: `flex-grid-align/flex-*`, `calc-math/zero-percentage-*`; https://drafts.csswg.org/css-flexbox-1/#flex-property.
- [LAYOUT-06] (BLOCKER) Engines lay out `display:-webkit-box` from the legacy properties, so authored `-webkit-box-pack`/`-align`/`-orient` (and `-ms-flex-*`) survive a later standard property unless targets are set and the handler regenerates them; prefixed `@supports` operands keep their prefix.
  verify: `flex-grid-align/webkit-box-*`, `supports-container/supports-prefixed-operand*`; reverse-decls, retarget-none, prefixed-sibling.
- [LAYOUT-07] (MAJOR) `row-gap`+`column-gap` merge into `gap` only where the shorthand is supported in that layout context; unowned aliases (`grid-gap`, `grid-row-gap`) keep their order against `gap`.
  verify: `flex-grid-align/gap-*`, `grid-gap-*`; reverse-decls; https://drafts.csswg.org/css-gaps-1/#gap-shorthand.
- [LAYOUT-08] (MAJOR) 2009/2012 lowering only for targets in `is_flex_2009` or the `-ms-` ranges, only for values with a legacy equivalent (none for space-around/-evenly, `baseline`), `order:n` → `*-box-ordinal-group:n+1`, `display:-moz-box` beside `-moz-box-*`, unit kept on a zero `-ms-flex` basis. Engines may read correct 2009 output as `different`: assert output.
  verify: `flex-grid-align/*ordinal*`, `firefox-2009-*`; retarget-none, retarget-legacy; https://www.w3.org/TR/2009/WD-css3-flexbox-20090723/.
- [LAYOUT-09] (BLOCKER) No `unreachable!()`/`unwrap()` in grid printing is reachable from visitor- or serde-built ASTs.
  verify: grep the diff; a visitor or serde round-trip test when grid types change.
- [LAYOUT-10] (MAJOR) Under CSS modules, area names, line names and their implicit `-start`/`-end` forms are renamed consistently across all grid properties.
  verify: css_modules_test with `grid-template-areas` and `grid-row-start:a-start` (oracle-blind, L8).
- [LAYOUT-11] (MINOR) Newer values pass through uncanonicalized: `flow-start`/`flow-end` (`flex-start` not rewritten), `anchor-center` (only on `*-self`), `flex-wrap: balance`, `<line-width>` gaps, `grid-lanes`.
  verify: minify round trips; O3.
