# Checklist: font (prefix FONT)
`src/properties/font.rs` (FontHandler, `FamilyName`, `Font`), `src/rules/font_{face,feature_values,palette_values}.rs`. Spec: `references/spec/fonts-text.md` §2.
FAIL only when head introduces or widens a violation; a defect base already has is PASS with an unchanged case.

- [FONT-01] (BLOCKER) Longhands `font` resets, `font-variant-*` before `font-variant`, and `font-stretch`/`font-width` keep source order against the buffered shorthand, typed or not; a fix flushes, never discards authored longhands.
  verify: probes font/{font-shorthand-reset-only-longhands-keep-order,font-width-not-moved-before-font,sft-font-variant-shorthand-after-caps}; mutation reverse-decls; https://drafts.csswg.org/css-fonts-4/#font-prop
- [FONT-02] (BLOCKER) Longhands fold into `font` only when every reset-only longhand is also set in the block or provably initial.
  verify: probes font/{font-longhands-merge-resets-variant-numeric,font-longhands-not-folded}; read FontHandler `flush`
- [FONT-03] (BLOCKER) Family lists round-trip: an unquoted name re-parses to the same names (no edge/double spaces, no word that is a generic, system-font, CSS-wide keyword or `default`), a quoted generic stays quoted, authored duplicates survive.
  verify: probes font/{sft-font-family-leading-space-stays-quoted,font-family-generic-first-word,font-family-monospace-monospace-kept}; read `FamilyName::to_css`; https://drafts.csswg.org/css-fonts-4/#font-family-name-syntax
- [FONT-04] (BLOCKER) `font` is printed only in the shorthand sub-grammar (width keyword not %, CSS2 caps, no CSS-wide family) and parsed per spec (system font only as the whole value, `normal` in any slot); font-stretch % only when every target has FontStretchPercentage.
  verify: probes font/{font-shorthand-stretch-keyword-2,font-family-inherit-not-folded,sft-font-shorthand-keeps-css3-caps-out,font-stretch-percentage-legacy-target,sft-system-font-keyword-as-family}
- [FONT-05] (BLOCKER) Out-of-range or invalid values (weight outside [1,1000], oblique outside ±90deg, CSS-wide keyword in a family list, empty) stay unparsed and never delete the earlier declaration; out-of-range calc() clamps.
  verify: probes font/{sft-font-weight-zero-keeps-fallback,sft-oblique-angle-out-of-range-keeps-fallback,sft-oblique-calc-out-of-range-clamped}; https://drafts.csswg.org/css-values-4/#calc-range
- [FONT-06] (BLOCKER) Typed and `var()` declarations of FontHandler-owned properties keep relative order.
  verify: mutations var-before, var-after, read the order in `lcr show`; read `is_font_property`
- [FONT-07] (MAJOR) The system-ui stack is added only when FontFamilySystemUi must be compiled, right after `system-ui`, once per block.
  verify: mutations retarget-modern, retarget-legacy; read `compatible_font_family`
- [FONT-08] (MAJOR) `line-height` keeps its type: number stays number, `0px` stays a length, % stays %.
  verify: probes font/sft-line-height-percentage-not-number, values-numeric/line-height-zero-interpolation
- [FONT-09] (BLOCKER) `@font-face`: no descriptor dedupe (every `src` kept in order), no rule merging, unicode-range keeps its code points, unknown names escaped.
  verify: probes font/{sft-font-face-src-fallback-kept,sft-font-face-unicode-range-compression}, at-rules-other/font-face-unknown-descriptor-escaped; https://drafts.csswg.org/css-fonts-4/#font-face-src-parsing
- [FONT-10] (BLOCKER) `@font-feature-values`: a generic family in the prelude stays invalid (never quoted); an invalid declaration (`font-display`, negative, wrong count) is ignored without failing the sheet or replacing a valid one; merge only identical family lists with no overlapping rule between.
  verify: probes font/{sft-font-feature-values-font-display,sft-font-feature-values-negative-index-ignored,sft-font-feature-values-merge-keeps-cross-family-order}; https://drafts.csswg.org/css-fonts-4/#font-feature-values-syntax
- [FONT-11] (BLOCKER) `@font-palette-values` keeps a family list, indexes above 65535, and fallback colors in the right space.
  verify: probes font/{sft-font-palette-values-family-list,sft-font-palette-values-large-integers}; mutation retarget-legacy
- [FONT-12] (MAJOR) Newly typed font syntax gets an owner that keeps order against `font` and aliases, keeps feature-tag quoting/case, never folds `from-font`/`math`/`palette-mix()`, and follows the current ED.
  verify: mutations reverse-decls, var-after, important; https://drafts.csswg.org/css-fonts-5/#font-size-adjust-prop
