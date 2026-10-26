# Spec digest: fonts, text, writing modes, logical (+ lists)

Anchors: `fonts-4#x` = `https://drafts.csswg.org/css-fonts-4/#x` (likewise `text-4`, `text-decor-4`, `inline-3`,
`logical-1`, `writing-modes-4`, `lists-3`); cite full URLs. Typed grammars follow older drafts: judge new typing
against the current ED.

## 1. Mechanisms across these areas
- **Typed invalid value deletes the fallback.** A parser accepting what browsers reject yields a typed value; the
  handler keeps the last one, or FallbackHandler overwrites the earlier slot, so `prop:<valid>;prop:<invalid>` loses
  the valid one. Typed→`Unparsed` pairs survive.
- **Buffered handlers reorder.** Owned properties are emitted at flush, unowned ones (other longhands, aliases such as
  `font-width`, `-webkit-margin-start`) at once, ahead of a buffered property that resets or shares a slot with them. PrefixHandler updates
  in place with no `Unparsed` arm, so a later typed value jumps before an intervening `var()`.
- **Ranges** (`css-values-4#calc-range`): out-of-range literals are invalid, out-of-range calc() clamps. Font: weight
  [1,1000], oblique [-90deg,90deg]. Test idiom `property_range_test`.
- **Length types**: `0px` → `0` changes meaning where a number is also valid (line-height, tab-size); unitless → px
  makes invalid input valid (letter-spacing, text-indent).
- **Never fold context-dependent values**: `from-font`, `font-size: math`, `palette-mix()`, fill-only emphasis style.

## 2. Fonts
- `font` (`fonts-4#font-prop`): `[style || <font-variant-css2> || weight || <font-width-css3>]? size[/line-height]?
  family#`, or a system font as the **whole** value (`font: 12px menu` = family "menu"). Caps normal|small-caps,
  width keywords only (**no %**), no CSS-wide family; `normal` may fill any slot.
- `font` also **resets** font-feature-settings, -kerning, -language-override, -optical-sizing, -size-adjust, all 7
  -variant-*, -variation-settings (not font-palette, font-synthesis-*). `font-variant` resets its 7 sub-properties.
  `font-stretch` aliases `font-width` (one cascade slot). Feature tags are case-sensitive.
- `font-family` (`#font-family-name-syntax`): unquoted = identifiers joined by single spaces, **none** of which may be a
  generic, system-font, CSS-wide (`revert-rule`) keyword or `default` (`Serif Gothic` stays quoted); a quoted generic
  is a family name. A lone `monospace` selects the 13px default size (`#generic-font-families`); `monospace,
  monospace` does not, so duplicates are load-bearing.
- `line-height` (`inline-3#line-height-property`): a number inherits as a factor, %/length as a length.
- `@font-face` (`#font-face-src-parsing`): an `src` with no usable entry is invalid, so an earlier `src` wins.
- `@font-feature-values` (`#font-feature-values-syntax`): a generic family in the prelude invalidates the rule; the
  block accepts `font-display`; values are non-negative integers (exactly 1 for @swash/@ornaments/@stylistic/
  @annotation, 1-2 @character-variant); invalid declarations are ignored; last-defined wins per (family, block, name)
  across the document. Spec conflict: grammar bounds @styleset [0,20], @character-variant [0,99]; prose says larger
  is no syntax error (maintainer decision).
- `@font-palette-values`: family is a list, indexes `<integer [0,∞]>`, `override-colors` absolute.
- Lowering: `system-ui` gets `-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Noto Sans,Ubuntu,Cantarell,Helvetica
  Neue` after it when FontFamilySystemUi must be compiled. Stretch % needs FontStretchPercentage.
- Oracle: family quoting reads back differently per engine (compare name lists); `oblique 14deg` reads back `oblique`
  or `italic`; Chrome exposes `font-stretch`, Firefox/WebKit `font-width`. The WPT container sets `font:16px serif`
  (hides the monospace quirk). WPE renders system-ui names via fontconfig: assert on output. Font at-rules give no
  oracle signal.

## 3. Text and decoration
- `white-space` (`text-4#white-space-property`) and `text-wrap` both set text-wrap-mode; `text-align` resets
  text-align-last: relative order matters.
- `text-decoration-line` (`text-decor-4#text-decoration-line-property`): `none | [underline || overline ||
  line-through || blink] | spelling-error | grammar-error`; repeats and combos are invalid.
- `text-decoration` (`#text-decoration-property`) = line || thickness || style || color (L3: no thickness); omitted
  line = `none`, so `none red`/`dotted red` keep color/style. Thickness `%` is of 1em.
- `text-emphasis-style`: fill without shape = circle (horizontal) or sesame (vertical), so `filled` ≠ `filled circle`.
  `text-emphasis-position`: omitted side = right; the one-keyword form is newer than the property.
- `text-shadow`: L4 spread and `inset` are unsupported everywhere. `text-box` (`inline-3#text-box-shorthand`):
  omitted trim = trim-both, so `none` is significant.
- Lowering: `-webkit-text-decoration` (WebKit alias) for older Safari when style/color is set; thickness leaves the
  shorthand without TextDecorationThicknessShorthand; `%` → `calc()` of 1em without TextDecorationThicknessPercent
  (computed value differs, rendering does not). Engines without the L3 shorthand drop it whole (no CSS2 fallback).
  Not lowered: white-space L4, text-wrap, `initial-letter` (`-webkit-initial-letter` lacks `drop`).
- Oracle: `text-emphasis: filled` reads back `dot`, `circle` or `filled dot` per engine; WPE rejects
  `-webkit-text-size-adjust` (iOS-only data).

## 4. Writing modes and logical
- `writing-modes-4#logical-to-physical`: horizontal-tb: block-start top, inline-start left (ltr) / right (rtl);
  vertical-rl: block-start right, inline-start top. Lowering assumes horizontal-tb (documented).
- `logical-1#box`: a logical/physical pair shares one computed value cascaded together, so source order decides per
  direction: `margin-inline-start:1px; margin-left:2px; margin-inline-end:3px` → margin-left 2px (ltr), 3px (rtl).
  float/clear `inline-*` use the containing block, caption-side the table wrapper. `:dir()` follows `dir`, not lang.
- Mechanism: `side_handler!` flushes on a logical↔physical switch; inline start == end becomes left/right in place;
  otherwise `get_additional_rules` emits `:dir(ltr|rtl)` copies after the base rule with **normal declarations only**
  and one extra pseudo-class of specificity. `:dir()` lowers to `:lang(<RTL languages>)`/`:not(:lang(…))` (list only
  with LangSelectorList, else `:is()`/`:-webkit-any()` copies). `var()` longhands keep the `var()`; `var()` shorthands
  pass through. Only the style-rule arm drains side rules, so declarations after a nested rule can lose them.
- An exact fallback preserves, in ltr and rtl: the source-order winner, specificity (no neutral form exists for old
  targets), `!important`, the subject, unsplit `var()` shorthands, inline-axis → width (also in `transition`).
- Oracle: page is `<html lang="en">` without `dir`, so RTL needs a `dom:` line; `dir=rtl` without an RTL lang never
  matches the `:lang()` heuristic (by design). Chromium rejects `:lang()` lists; WebKit 15.4 parses `:dir()` but never matches it. Legacy engine profiles all support
  logical properties: judge the `:lang()` fallback in current engines.

## 5. Lists and counters
`list-style` (`lists-3#list-style-property`) must re-parse to the same parts; a counter style may be named
`inside`/`outside`/`none`. Counter duplicates add up (`a a` = +2); `reversed(x)` ≠ `reversed(x) 0`.

## 6. WPT lane gaps (write probes)
Fallback deletion needs `prop:<valid>;prop:<invalid>` probes (WPT checks the invalid value alone); resets and order
need multi-declaration probes; font at-rules are probe-only; number vs length needs a child via `dom:`; no
`dir`/`lang`/`writing-mode`.
