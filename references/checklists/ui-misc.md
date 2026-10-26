# Checklist: ui-misc (prefix UI)
`src/properties/ui.rs` (caret, user-select, appearance, color-scheme, print-color-adjust), `list.rs`, `svg.rs`, their FallbackHandler/PrefixHandler entries (`prefix_handler.rs`), passthrough counter-*, content, quotes, object-*. Spec: `spec/layout.md` §UI. FAIL only when head introduces or widens a violation.

- [UI-01] (BLOCKER) Interleaved `caret`, `caret-color` and `caret-shape` keep source order (separate slots with write-back reorder them), an empty or invalid `caret` stays invalid, and a merged `caret` holds only components the type owns. No engine implements `caret`: assert output.
  verify: `ui-misc/caret-*`; reverse-decls, var-after; https://drafts.csswg.org/css-ui-4/#propdef-caret.
- [UI-02] (BLOCKER) PrefixHandler properties (user-select, appearance, print-color-adjust, box-sizing…) keep cascade order around `var()` (no in-place update of the first slot), and an author prefixed value that differs from the unprefixed one survives in place; no generated `-webkit-appearance` overrides the author's. WebKit computes `user-select` and `-webkit-user-select` separately (O9).
  verify: `rule-merging/prefix-handler-in-place-update-reorders-unparsed`; var-before, var-after, prefixed-sibling.
- [UI-03] (MAJOR) FallbackHandler properties (caret-color, fill, stroke) never let an invalid, empty or newer-syntax later value delete the earlier valid one: write-back that treats every Unparsed value as overriding does; a two-value `caret-color` keeps a one-value fallback.
  verify: `rule-merging/invalid-color-*`; probes `caret-color:red;caret-color:` and `fill:red;fill:foo`.
- [UI-04] (BLOCKER) `list-style` round-trips: `none` fills whichever of image/type is unset, a type named `inside`/`outside` keeps the position keyword, an omitted default position never makes the value ambiguous (`outside outside`), and `list-style:` stays invalid.
  verify: `ui-misc/*list-style*`; every ambiguous keyword pair; https://drafts.csswg.org/css-lists-3/#list-style-property.
- [UI-05] (MAJOR) UI prefixes match real engines: `-webkit-user-select` for every Safari/iOS version (no closed upper range), `color-adjust` rather than `-moz-print-color-adjust` for old Firefox, `src/prefixes.rs` regenerated, not hand-edited.
  verify: `prefixing-compat/user-select-*`, `print-color-adjust-*`; a target newer than the data snapshot; engine-legacy-2021.
- [UI-06] (MAJOR) `color-scheme` keeps CSS-wide keywords, custom idents and keyword order; its light-dark() lowering defines `--lightningcss-light`/`-dark` whenever it emits them (a value that became Unparsed skips the handler), keeps `!important`, survives after a nested rule and is idempotent.
  verify: `ui-misc/color-scheme-*`, `color/*color-scheme*`, `nesting/light-dark-*`; nest; https://drafts.csswg.org/css-color-adjust-1/#color-scheme-prop.
- [UI-07] (MAJOR) Counters and content keep meaning: duplicate `counter-increment` names add up, `reversed(x)` ≠ `reversed(x) 0`, `content` alt text (`/ ""` = decorative) and fallbacks survive.
  verify: `ui-misc/sft-*`; duplicate-nonadjacent; https://drafts.csswg.org/css-lists-3/#propdef-counter-increment.
- [UI-08] (MAJOR) Typing a passthrough property (object-fit, object-position, counter-*, content, quotes) prints nothing longer or different (`top` not `50% 0%`), keeps engine-invalid input Unparsed and names its owning handler.
  verify: a `P:valid;P:invalid` probe per grammar; O7; B11.
- [UI-09] (MINOR) SVG keyword enums parse ASCII case-insensitively and type only spec spellings (`optimizeSpeed`, `crispEdges`, `geometricPrecision`; invalid `optimize-speed` stays Unparsed): every enum needs `#[css(case = lower)]`.
  verify: `ui-misc/svg-*`; `color-rendering:auto;color-rendering:optimize-speed`.
- [UI-10] (MINOR) `cursor` keeps its URL list, hotspots and final keyword; fallback pairs (`-webkit-grab;grab`) and newer values (`appearance: base-select`, `caret-animation`, `user-select: contain`, `resize: inline`) pass through.
  verify: duplicate-nonadjacent; O3; minify round trips.
