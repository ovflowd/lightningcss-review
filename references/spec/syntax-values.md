# Spec digest: syntax, values, math, custom properties, serialization

Anchors `KEY#id`: SYN https://drafts.csswg.org/css-syntax-3/, V4 https://drafts.csswg.org/css-values-4/,
V5 https://drafts.csswg.org/css-values-5/, VAR https://drafts.csswg.org/css-variables-1/,
PV https://drafts.css-houdini.org/css-properties-values-api-1/, OM https://drafts.csswg.org/cssom-1/,
ENV https://drafts.csswg.org/css-env-1/. **Weak spot**: current code breaks the rule; a PR must not
extend it; a fix covers the class.

## 1. parser-syntax

- SYN#consume-block-contents: a bad declaration skips to `;`; an invalid nested rule or disallowed
  at-rule drops only itself. Weak spot: with `errorRecovery`, `src/parser.rs`
  clears the whole block on any item error.
- A known property's value that fails its grammar becomes `Property::Unparsed`, not a sheet error.
  Weak spots: `all` takes only CSS-wide keywords; `url()` request modifiers (V5) are a hard error,
  in token lists too (`Url::parse`).
- SYN#consume-declaration: `!important` = `!` + ASCII case-insensitive `important` as the last two
  non-whitespace tokens. Custom properties may hold `{}`; a non-custom value with a top-level `{}`
  plus other tokens is invalid, never a rule; `--foo:hover{}` is a declaration.
- SYN#consume-number: a fraction or exponent makes a `number` (`1.0`, `1e3` are not `<integer>`);
  `1e` is 1 with unit `e`; the sign is part of the token (`1px+2px` is two dimensions).
- No `@charset` rule exists; a BOM never enters a selector.
- Case: property, at-rule, function names and keywords are ASCII case-insensitive; `--*` names,
  `<custom-ident>`, env() names and `@property` data type names are case-sensitive.

## 2. printer-serialization

- SYN#serialization: output re-tokenizes to the same tokens. Separator needed when ident, number,
  dimension, hash, at-keyword, `#`, `-` or `@` precedes ident, function, url, number, percentage,
  dimension, `-` or CDC; also ident + `(`, number + `%`, `.`/`+` + numeric, `/` + `*`. A unit that
  reads as an exponent (`e`, `e`+digit, `e-`) is escaped (`1\65 `). Weak spot: cssparser escapes
  only `e`/`e-` units (`1e\32` prints `1e2`).
- OM#serialize-an-identifier (leading digit, `-digit`, lone `-`, controls) for every output name:
  a raw `\7d` closes the block.
- Strings: `"`-quoted, `"` and `\` escaped; a hex escape takes a space before a hex digit or
  whitespace. Unquoted `url()` escapes whitespace, quotes, parens. Never unescape to `</style`.
- OM#serialize-a-css-value: shorten only to a same-meaning form every target parses (`image-set()`
  `1x`, quoted `format()`, `x` vs `dppx`, `<ratio>` `a / 1` -> `a`; exponents need Chrome 43,
  Firefox 29, Safari 10.1).

## 3. values-numeric

- Literal out-of-range values are invalid; only math clamps, at computed time (V4#numeric-ranges).
- Units are optional only for zero; a `0` that could be `<number>` or `<length>` is a `<number>`
  (V4#lengths); unitless lengths are quirks-only (V4#deprecated-quirky-length). Weak spot:
  `LengthValue::parse_with_range` maps `Token::Number` to px.
- `0` vs `0px` differ where `<number>` is also valid (`line-height`, `tab-size`, lone flex basis,
  `@property <number> | <length>`): interpolation turns discrete. Unitless zero is invalid for
  time, resolution, inside math, and for angles outside legacy `rotate()`/`skew()`.
- `0%` != `0` when the basis can be indefinite (heights, grid tracks, flex-basis); V4#combine-mixed.
  In `background-position`/`transform-origin` it changes only the computed string.
- Exact conversions: px <-> in/pt/pc, deg <-> turn, s <-> ms, x <-> dppx. Values are f32, printed
  with 6 significant digits. Weak spots: integers print via `as i32` and saturate
  (`serialize_dimension`, `Percentage::to_css`; the latter doubles `-` on negative exponents).

## 4. calc-math

- V4#calc-type-checking: `+`/`-` need one type; numbers never become lengths (`calc(1px + 1)` is
  invalid; weak spot: a length-plus-number Sum is typed). Engines accept `<dim> / <dim>`.
- V4#calc-simplification: percentages and basis-relative units may resolve against a negative or zero
  basis, so only same-unit or absolute values fold or compare; "zero-valued terms cannot be simply
  removed from a Sum". Weak spots: `DimensionPercentage::add` drops a zero
  operand; `Calc::reduce_args` compares percentages in min/max/clamp.
- V4#calc-range: only the top-level calculation clamps or rounds.
- V4#calc-ieee: NaN, inf, -0 live only inside a calculation; at top level NaN -> 0, inf clamps; print
  `calc(NaN)` (V4#calc-serialize); `round/mod/rem(x, 0)` = NaN. Weak spot: unranged slots print
  NaN as ~`5e38`.
- V4#typedef-rounding-strategy: `nearest` ties toward +inf (`round(-2.5px, 1px)` = -2px; weak
  spot: `f32::round` gives -3px); mod() takes the sign of B, rem() of A.
- V4#comp-func: `clamp(MIN, VAL, MAX)` = `max(MIN, min(VAL, MAX))`, MIN wins; reduce only when every
  comparison is known. `none` args, one-argument `round()`, `round(line-width, …)`: pass through.

## 5. custom-properties

- VAR#serializing-custom-props: values print as specified, only trimmed: no comment dropping,
  whitespace, numeric or case changes (JS and `style()` read the text). Weak spot:
  `TokenList::parse_into` types colors, dimensions, urls, numbers (`#FF0000` -> `red`, `1000ms` -> `1s`).
- Substitution is token-level: whitespace, comments and signs must not merge tokens. Weak spot: minified
  token lists drop comments, and numbers lose `has_sign` (`1px+2px` -> `1px2px`).
- VAR#using-variables: `var(--x,)` (empty fallback) != `var(--x)`, also for `env()`, `attr()`.
- V5#resolve-property: a value with a valid substitution function is assumed valid and may override;
  one without, failing its grammar, is invalid and must not. Weak spot: `FallbackHandler` treats all
  Unparsed as valid for color, fill, stroke, caret(-color), filter, backdrop-filter, text-shadow.
- V5#substitution-in-shorthands: a shorthand with `var()` is never split, merged, deduped against its
  longhands or logically lowered by guessing its arity.
- PV#at-property-rule: `syntax`, `inherits` required; `initial-value` required unless `*`, normal
  grammar, computationally independent (no `em`, `var()`); unknown descriptors ignored; last valid
  rule wins (PV#determining-registration). Weak spots: type names match case-insensitively,
  unknown descriptors error, `10em` passes, a later invalid rule still wins.
- ENV#env-function: names case-sensitive; unknown name or index count -> fallback; valid in
  descriptors and media queries. Weak spot: `UAEnvironmentVariable` is an `enum_property!` (lowercases).
- Pass through verbatim: `if()`, typed `attr()`, `random()` (keys bind to property and component index,
  V5#random-caching), `sibling-index()`, `progress()`, `calc-size()`, `{}` arguments, `...var()`.
  Relative URLs resolve where the variable is used.

## 6. Engine facts that affect the oracle

- Number drift under max(0.002, 1e-4 x value) and same-color spellings compare equal, also in
  custom properties: assert text with `output-contains`.
- Cyclic `width` percentages diverge from spec: probe `height`. Playwright `env(safe-area-inset-*)`
  is 0px: give env probes a non-zero fallback.
- Legacy Chromium/Firefox lack `round/mod/rem/abs/sign` and `infinity` (WebKit 15.4+ has
  them); the oldest profile lacks `e`/`pi`. Unlowered math drops there (O4).
- Invisible to the oracle: warnings, U+FEFF in inline styles.

## 7. Lowering

- `clamp()` -> `max(MIN, min(VAL, MAX))` (not in custom properties) is the only math fallback; for
  new units and other math an author fallback survives only if compat data is right.
- Custom-property colors: lowest supported color in place, an `@supports` copy right after the rule
  with the same selector, `!important` and nesting context.
- `light-dark()` in custom properties becomes toggles set with `color-scheme`, resolving where
  declared (by design; `Features::LightDark` opts out); never in `@property` descriptors.
