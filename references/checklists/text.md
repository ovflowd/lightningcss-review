# Checklist: text (prefix TEXT)
`src/properties/text.rs` (TextDecorationHandler, TextShadow) and text members of `prefix_handler.rs`. Spec: `references/spec/fonts-text.md` §3.
FAIL only when head introduces or widens a violation; a defect base already has is PASS with an unchanged case.

- [TEXT-01] (BLOCKER) `text-decoration` and `text-emphasis` print every non-initial component even with line/style `none` or omitted (`none red`, `dotted red`), a fill-only emphasis style gets no shape, and `text-underline-position: left` is not rewritten.
  verify: probes text/{text-decoration-none-drops-color,sft-text-emphasis-none-keeps-color,sft-text-emphasis-style-fill-only}; test the shorthand alone (a later longhand merge hides it)
- [TEXT-02] (BLOCKER) Values browsers reject stay unparsed and never delete the earlier declaration: repeated or `none`/error-combined decoration lines, empty `text-transform:`/`text-decoration:`, text-shadow spread or `inset`.
  verify: probes text/{sft-text-decoration-line-none-combo-keeps-fallback,sft-text-decoration-line-spelling-error-combo,empty-text-transform-becomes-none,sft-text-shadow-spread-keeps-fallback}; https://drafts.csswg.org/css-text-decor-4/#text-decoration-line-property
- [TEXT-03] (MAJOR) A zero blur or spread is omitted whatever its unit, so a 2-3 length input never prints a 4-length shadow.
  verify: read `TextShadow::to_css` (unit-independent zero test); a px→rem visitor test
- [TEXT-04] (BLOCKER) Text-shadow color fallbacks never panic for lists mixing a lowered color with `currentColor`, a system color or `light-dark()`, in the RGB, P3 and LAB branches.
  verify: probe effects-masking/text-shadow-oklch-currentcolor; grep the diff and sibling handlers for `to_rgb()/to_p3()/to_lab()` + `unwrap()`
- [TEXT-05] (MAJOR) `Unparsed` decoration/emphasis values next to an authored prefixed copy add no second copy, in either order, and re-minifying changes nothing.
  verify: probe text/text-decoration-prefixed-inherit-idempotent; mutation prefixed-sibling; write the `x:var(--d);-webkit-x:var(--d)` order
- [TEXT-06] (BLOCKER) PrefixHandler properties (tab-size, hyphens, text-align-last, skip-ink, text-overflow, text-size-adjust) keep source order around a `var()` of the same property; different values per prefix are not merged.
  verify: probe rule-merging/prefix-handler-in-place-update-reorders-unparsed; mutations var-before, var-after
- [TEXT-07] (MAJOR) Prefix decisions come from generated compat data, and authored prefixes an untargeted family may need (`-webkit-text-size-adjust` for iOS) are kept.
  verify: probe prefixing-compat/text-size-adjust-webkit-ios; read PrefixHandler
- [TEXT-08] (MAJOR) The decoration shorthand is emitted only in forms every target parses (thickness, style/color, `-webkit-` alias), a merged shorthand carries only prefixes the longhands had, and thickness % is lowered only without TextDecorationThicknessPercent.
  verify: probe text/sft-text-decoration-thickness-shorthand-old-safari, values-numeric/percentage-int-value-serialization; mutations engine-legacy-2021, retarget-legacy
- [TEXT-09] (MAJOR) text-emphasis lowering matches targets: `-webkit-` where needed for every side, `over right` → `over` only where one keyword parses.
  verify: mutation retarget-legacy; https://drafts.csswg.org/css-text-decor-4/#text-emphasis-position-property
- [TEXT-10] (MAJOR) Lengths keep their type: `tab-size:0px` stays a length, unitless letter-/word-spacing, text-indent, thickness are not turned into px.
  verify: probes text/sft-tab-size-zero-length-stays-length, values-numeric/unitless-nonzero-length-not-px
- [TEXT-11] (MAJOR) white-space, text-wrap and their longhands, and text-align vs text-align-last, keep relative order.
  verify: probe text/sft-white-space-text-wrap-order; mutation reverse-decls; https://drafts.csswg.org/css-text-4/#text-wrap-shorthand
- [TEXT-12] (MAJOR) Newly typed Text 4 / Decoration 4 / Inline 3 syntax follows the current ED, keeps significant keywords (`text-box: none …`), and adds no prefix lacking the value.
  verify: probe text/sft-text-box-none-trim-kept; mutations reverse-decls, var-after; https://drafts.csswg.org/css-inline-3/#text-box-shorthand
- [TEXT-13] (MINOR) `text-align: start|end` lowering targets only LogicalTextAlign engines with selectors they parse, and keeps order against later `text-align`.
  verify: mutation retarget-legacy
