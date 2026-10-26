# Spec digest: syntax, values, math, custom properties, serialization

Areas: `parser-syntax`, `printer-serialization`, `values-numeric`, `calc-math`, `custom-properties`.
Code refs: `~/GitHub/lightningcss` master `cbeaf83`. **PASS**/**FAIL** = checked on a master build
(research driver; every FAIL below was re-run for this digest). UNVERIFIED = not checked. Open bugs are
pre-existing: judge a PR on whether it fixes, keeps or worsens them. Probe ids live in the checklists.

## 0. Specs read (Editor's Drafts fetched 2026-10-25)

| key | spec | status | base URL |
|---|---|---|---|
| SYN | CSS Syntax 3 | CRD 2026-10-01, ED 2026-10-20 | https://drafts.csswg.org/css-syntax-3/ |
| V4 | CSS Values and Units 4 | ED 2026-08-24 | https://drafts.csswg.org/css-values-4/ |
| V5 | CSS Values and Units 5 | ED 2026-09-04 ("early exploration") | https://drafts.csswg.org/css-values-5/ |
| VAR | CSS Custom Properties 1 (L2 ED: variable units) | CR 2022-06-16, ED 2026-10-09 | https://drafts.csswg.org/css-variables-1/ |
| PV | Properties and Values API 1 (`@property`) | WD 2020-10-13, ED 2026-08-06 | https://drafts.css-houdini.org/css-properties-values-api-1/ |
| OM | CSSOM 1 (serialization) | WD 2021-08-26, ED 2026-10-13 | https://drafts.csswg.org/cssom-1/ |
| ENV | CSS Environment Variables 1 | ED 2026-10-08 | https://drafts.csswg.org/css-env-1/ |

Anchors are written `KEY#anchor`.

## 1. parser-syntax (css-syntax-3)

Grammar to check:
- Preprocessing: CR/FF/CRLF -> LF; U+0000, surrogates -> U+FFFD. Encoding: HTTP charset > BOM > exact
  `@charset "x";` > referrer > utf-8; no `@charset` rule exists (SYN#determine-the-fallback-encoding).
- Numbers (SYN#consume-number): `[+-]? d* (.d+)? ([eE][+-]?d+)?`; the exponent needs a digit after
  `e`/sign (`1e` = unit `e`); a fraction or exponent makes the type `number` (`1.0`, `1e3` are not
  `<integer>`); `+`/`-`/`.` start a number only before a digit.
- `url(` + quote = function token (only form with modifiers); unquoted whitespace, quotes, `(` or bad
  escape -> bad-url (SYN#consume-url-token). Escapes: 1-6 hex + one optional whitespace; 0, surrogate,
  > U+10FFFF -> U+FFFD (SYN#consume-escaped-code-point).
- Declarations (SYN#consume-declaration): `!important` = last two non-whitespace tokens `!` + ASCII
  case-insensitive `important`; custom properties keep original text; a non-custom value with a top-level
  `{}` plus other tokens is invalid (csswg #9317); `--foo:hover{}` is a declaration (#9336). A bad
  declaration skips to `;`; an invalid nested rule keeps the declarations before it
  (SYN#consume-block-contents). CDO/CDC are dropped only at top level (SYN#consume-stylesheet-contents).
- `unicode-range` is re-tokenized from source (SYN#consume-unicode-range-value).

Invariants:
- **INV-SYN-003** `! IMPORTANT`, `!/**/important` are important; `a!important b` is invalid. PASS.
- **INV-SYN-004** A bad declaration or invalid nested/at-rule drops only itself. **FAIL** with
  errorRecovery: any item error runs `declarations.clear()` (`src/parser.rs:496-498`, since a8b7ea0
  v1.22.0; #1358, PR #1374). Triggers: `foo;`, `$$$;`, `*zoom:1`, `:hover;`, `{}` in typed values,
  disallowed at-rules, url() modifiers, `all:var(--x)`.
- **INV-SYN-005** CDO/CDC inside blocks are ordinary tokens (`--x:<!-- -->` kept). PASS.
- **INV-SYN-006** Custom properties may contain `{}`; typed values with `{}` are invalid, never reparsed
  as a rule. PASS, but with errorRecovery INV-SYN-004 also deletes a valid `--x:{a} b` in the same block.
- **INV-SYN-010** `@charset` is always dropped (`src/parser.rs:340-345`) and raw UTF-8 written; a leading
  BOM passes through, a mid-bundle BOM ends up inside a selector (#338, PR #1301). The oracle cannot see
  U+FEFF in inline `<style>`: use output assertions.
- **INV-SYN-011** Valid `unicode-range` lists round-trip (`u+0025-00ff` -> `U+25-FF`); a list with an
  invalid range falls back to tokens and loses every `+` (`U25-0FF,U4??,U110000`) but stays invalid.
- **INV-SYN-012** Custom values trim leading/trailing whitespace; `--x:;` is valid and differs from the
  guaranteed-invalid value; `--` is reserved (VAR#guaranteed-invalid). PASS.

Conformance:

| item | status | where |
|---|---|---|
| tokenizer | cssparser 0.37.0; all non-ASCII are ident code points (as in engines) | `Cargo.toml:65` |
| invalid value of a known property | `Property::Unparsed`, never dropped | `src/properties/mod.rs:719-724` |
| `all` | CSS-wide keyword only: `all:var(--x)` is a parse error | `mod.rs:714` (d7aeff3 v1.25.0, #752) |
| block error recovery | partial (clears the block) | `src/parser.rs:489-521` |
| nested parsers | keyframe blocks use `ParserOptions::default()`; bad keyframes (`filter_map(Result::ok)`) and `@font-face` descriptors (`if let Ok`) dropped | `src/rules/keyframes.rs:403-415`, `src/parser.rs:798-808`, `:879-889` (#1103) |
| recursion guard | TokenList only (`MaximumNestingDepth`) | `custom.rs:322`, `:370`; none for calc, selectors, nesting (#1297), printer (#1155) |
| url() modifiers | **missing**, hard error also in token lists | `src/values/url.rs:33-37`, `custom.rs:383-385` |

## 2. printer-serialization (SYN §9, CSSOM)

Rules:
- SYN#serialization: output must re-tokenize to the same tokens. Separator needed between first in {ident,
  at-keyword, hash, dimension, `#`, `-`, number, `@`} and second in {ident, function, url, `-`, number,
  percentage, dimension, CDC} (not number x `-`, `@` x numeric), plus ident x `(`, number x `%`, `.`/`+` x
  numeric, `/` x `*`. A unit that could read as an exponent is escaped (`\65 `).
- OM#serialize-an-identifier (escape leading digit, `-digit`, lone `-`, controls); strings always `"` with
  `"` and `\` escaped; a hex escape ends with a space before a hex digit or whitespace.
- OM#serialize-a-css-component-value: keywords lowercase; `<integer>` shortest base-10; `<number>` at most
  6 **decimals**, no exponent; canonical units. OM#serialize-a-css-value: shorten only when meaning is
  unchanged, never when the short form is "less backwards-compatible".

Invariants:
- **INV-SYN-001** Adjacent tokens that would re-tokenize differently stay separated. **FAIL**: minify
  prints nothing for `Token::Comment` (`custom.rs:898-902`, regression 32f1f52 v1.31.0):
  `font:12px/**/var(--f)` -> `12pxvar(--f)`, `--f:Arial/**/Black` -> `ArialBlack`, `--n:1/**/2` -> `12`,
  `--a:x//**/*y` -> `x/*y` (opens a comment that eats the rest of the sheet). Print mode keeps comments.
- **INV-SYN-002** A sign belongs to its numeric token (`margin:1px+2px` is two lengths). **FAIL** in
  print and minify: token lists print Number via `CSSNumber::to_css` and Dimension via
  `serialize_dimension` without `has_sign` (`custom.rs:541-546`): `1px+2px` -> `1px2px`, `1+2` -> `12`.
  LightningCSS never calls cssparser `needs_separator_when_before`.
- **INV-SYN-007** Escapes round-trip (`\31 23`, `\E9 x`, `\0`). PASS (cssparser). Open PR #1025 drops the
  space after a hex escape before whitespace (`"\1 Z"`).
- **INV-SYN-008** The ED restricts non-ASCII ident code points (2022 #7129). Harmless: Blink, Stylo and
  cssparser accept every non-ASCII code point.
- **INV-SYN-009** Unquoted `url()` escapes whitespace, quotes, parens. PASS (`url(a\)b.png)`).
- **INV-SER-001** (EM-01) Units starting with `e`+digit are escaped. **FAIL**: cssparser escapes only
  `e`, `E`, `e-*`, `E-*` (`serializer.rs:103-112`): `line-height:1e\32` (invalid) -> `1e2` (valid, 100).
- **INV-SER-002** (EM-04) Names reaching output use `serialize_identifier`. **FAIL** at raw `write_str`
  sites `src/properties/mod.rs:263-266` (PropertyId, e.g. `transition-property`), `src/rules/unknown.rs:40`,
  `src/rules/font_face.rs:570-572`, `src/rules/page.rs:290`, `src/selector.rs:866-870`, `:1305`,
  `src/media_query.rs:443`: `fake\7d name` -> `fake}name` closes the block; Chrome loses the next rule.
- **INV-SER-003** (wpt-engines) Adjacent numbers stay two tokens; a number keeps its type flag. **FAIL**:
  `flex-grow:2e3.4` -> `2000.4`, `grid-row:1.0` -> `1` (invalid became valid; `custom.rs:544`).
- **INV-SER-004** (EM-05, practice, not spec) Strings never re-serialize to `</style`. **FAIL**:
  `content:"<\/style>"` -> `"</style>"`.
- **INV-SER-005** Omitting defaults never leaves an empty or different value. **FAIL**
  `border-image:none` -> `border-image:` (#1146, PR #1336). Zero checks use `is_zero()`, not `== Px(0)`
  (#981, `src/properties/text.rs:1438-1445`).
- **INV-SER-006** Short forms must parse in target browsers: image-set `1x` (#264), quoted `format()`
  (34de9db), `dppx` when `x` is unsupported (`resolution.rs:85-91`); media `aspect-ratio:1/1` -> `1` has no
  target check (#379 open).

Conformance: idents/strings via cssparser serializers (always `"`, `src/values/string.rs`); `url()`
shorter of quoted/unquoted when minifying, quoted otherwise (#160) and with dependencies
(`src/values/url.rs:42-90`); only leading `/*!` comments kept (`src/stylesheet.rs:166-170`, by design
#43); token-list whitespace collapsed to one space when minifying (`custom.rs:891-897`, 32f1f52);
indentation `u8` unchecked (`src/printer.rs:76`, #1155); source-map columns in bytes (PR #1354).
Print-time lowering (nesting, media range, `#rrggbbaa`, `clamp()`, `light-dark()`, `x`, double-position
stops) needs targets in **PrinterOptions** as well as MinifyOptions.

## 3. values-numeric (V4 numeric types)

Grammar:
- Literal out-of-range values are invalid; math functions clamp at computed time (V4#numeric-ranges,
  V4#calc-range). `<integer>` rounds .5 toward +inf (V4#integers). `<zero>` matches only a literal `0`.
- Lengths: unit optional only for zero; "if a 0 could be parsed as either a `<number>` or a `<length>` ...
  it must parse as a `<number>`" (V4#lengths). Quirky lengths: quirks mode, listed longhands, never in
  shorthands or functions (V4#deprecated-quirky-length).
- A length-percentage mix computes to the dimension if the percentage part is zero, the percentage if the
  dimension part is zero, else `calc()` (V4#combine-mixed).
- Canonical units: px (1in = 96px = 2.54cm), deg (1turn = 360deg = 400grad), s, hz, dppx (1x = 96dpi).
  Exact in binary floating point only in/pt/pc <-> px, turn <-> deg, s <-> ms, x <-> dppx.
- `<ratio>` second part defaults to 1; 0 or inf = degenerate (V4#ratios). `<position>` has 1, 2 or 4
  components; the 3-value form exists only in `background-position` (V4#position).

Invariants:
- **INV-NUM-001** A unitless non-zero number is never a `<length>` in standards mode. **FAIL** (#1199,
  #682, #1042): `LengthValue::parse_with_range` maps `Token::Number` to px (`src/values/length.rs:145-147`,
  "TODO: quirks mode only?"): `width:20px;width:10` -> `width:10px`; also `translateZ(9)`, `gap`,
  `grid:1 / 1`, `@property` `<length>` initial values.
- **INV-NUM-002** `0px` and `0` differ where `<number>` is also accepted (`line-height`, `tab-size`,
  `border-image-width/-outset`, a lone flex basis, `@property <number> | <length>`): number <-> length
  interpolates discretely. **FAIL**: `LengthValue::to_css` prints `0` outside calc (`length.rs:493`),
  in keyframes too (`line-height:0px` -> `0`).
- **INV-NUM-003** Unitless zero is invalid for `<time>`, `<angle>` (outside legacy `rotate()`/`skew()`/
  gradient slots), `<resolution>` and inside math functions. PASS (`0ms` -> `0s`, `max(0px,10%)` kept).
- **INV-NUM-004** `0%` != `0` in `<length-percentage>` (indefinite-basis heights, cyclic percentages).
  PASS for sizes; `background-position:0% 0%` -> `0 0` changes the computed value, not rendering.
- **INV-NUM-005** Number output reproduces the value. **FAIL** (#949, #12, #170): `f32` printed with 6
  significant digits (`src/values/number.rs:122-142`): `123456.75px` -> `123457px`, `--z:1234567` ->
  `1234570`, `1234567ms` -> `1234.57s`. Integral dimensions print `value as i32` (`length.rs:518`) and
  **saturate** since cssparser 0.37 (#1200, v1.33.0): `rotate:3000000000deg` -> `2147483647deg` (120deg
  becomes 127deg). Chrome/Firefox computed values also use 6 significant digits; the build-time loss
  matters at large magnitudes. Same class: u16 palette indexes wrap (`font_palette_values.rs:191`).
- **INV-NUM-006** Negative numbers carry one `-`; exponent notation needs Chrome 43 / Firefox 29 /
  Safari 10.1 (not gated). Fixed for numbers (#901) and dimensions (#1192, b61c1c9); **FAIL** for
  percentages: `Percentage::to_css` writes `-` then `trim_start_matches("-0")` (`percentage.rs:66-71`):
  `-1e-7%` -> `--10e-8%` (#1219 open).
- **INV-NUM-007** Conversions only between compatible units, within engine precision. LightningCSS
  converts in calc (`length.rs:203-219`), prints the shorter of s/ms (`time.rs:107-135`), always prints
  rad as deg (`angle.rs:125-131`: the "even digits" test is always true), `dppx` as `x` when targets allow
  (`resolution.rs:85-91`). In token lists the rewrite is context-free: `image-set(... 2x)` and `--s:2x`
  -> `2dppx` for old targets (#1286, regression dcbb9b8 v1.17.0, PR #1384).
- **INV-NUM-008** `calc()` may be unwrapped only inside the literal range. Fixed for `[0,inf]` by #1329
  (`NonNegative<T>`, `number.rs:45-89`, unreleased); **FAIL** elsewhere:
  `font-weight:400;font-weight:calc(1001)` -> `font-weight:1001` (invalid; 400 deleted).
- **INV-NUM-009** Math in an `<integer>` slot rounds; never unwrap to a non-integer. PASS: `CSSInteger`
  has no calc (`number.rs:217`), `z-index:calc(1.5)` stays Unparsed. PR #1122 adds integer calc.
- **INV-NUM-010** `aspect-ratio:2/1` == `2`; degenerate ratios unchanged. PASS.
- **INV-V5-004** `transform-origin:left top 5px` is x, y, z. **FAIL** in print too: typed as 2D
  `Position` (`mod.rs:1474` "TODO: handle z offset syntax") -> `0 5px`.

Conformance: `<number>` f32 (`number.rs:91-142`, leading zero stripped); `<integer>` i32 without calc
(`:203-243`); `<length>` 49 units (`length.rs:363-482`), but `rex`/`rch`/`rcap`/`ric` have no compat
feature there although `compat.rs` defines `RexUnit`..`RicUnit`: **FAIL** `width:10px;width:1rch` for
Safari 16 drops the fallback (re-run, unfiled; `cap` keeps it); `<percentage>` and
DimensionPercentage (`percentage.rs:16-155`, zero terms dropped and percentages compared `:404-466`);
`<angle>`/`<time>`/`<resolution>`/`<ratio>` typed; `<frequency>` missing; `<position>` accepts the
3-value form everywhere (`src/values/position.rs:170-296`, reworked #1124); ranges are only
`NumericRange::{All, NonNegative}` (`number.rs:13-43`).

## 4. calc-math (V4 math functions)

Grammar (V4#calc-syntax): `calc min max clamp([<calc-sum>|none], <calc-sum>, [<calc-sum>|none])
round(<rounding-strategy>?, A, B?) mod rem sin cos tan asin acos atan atan2 pow sqrt hypot log exp abs
sign`; keywords `e pi infinity -infinity NaN`; whitespace required around `+`/`-`; 32 terms/levels minimum.
- Types (V4#calc-type-checking): `+`/`-` need matching types; numbers never become lengths (`calc(0 +
  5px)` invalid); typed arithmetic (`10px / 2px` = 5) is valid (Chrome 140, Firefox 158, Safari 26).
- IEEE (V4#calc-ieee): NaN/inf/-0 exist only inside a calculation; top level: NaN -> 0, inf -> clamp.
- Simplification (V4#calc-simplification): percentages "might resolve against a negative basis"; min/max
  combine only comparable same-unit children; "Zero-valued terms cannot be simply removed from a Sum".
  Only the top-level calculation clamps or rounds (V4#calc-range).
- Serialization (V4#calc-serialize): inf/NaN as `calc(infinity * 1px)` / `calc(NaN)`.

Invariants:
- **INV-CALC-001** Zero-valued terms stay unless another term has the same unit. **FAIL**:
  `DimensionPercentage::add` returns the other operand when one is zero (`percentage.rs:404-414`):
  `height:calc(10px + 0%)` -> `10px`, `calc(100% - 100% + 1px)` -> `1px`. Probe `height` (indefinite
  basis), not `width` (engines diverge from the spec, csswg #10969).
- **INV-CALC-002** Percentages are not compared or folded at parse time. **FAIL** for min/max/clamp:
  `Calc::reduce_args` uses `DimensionPercentage::partial_cmp` (`calc.rs:658-711`, `percentage.rs:458-466`;
  clamp `calc.rs:376-432`): `background-position:min(10%,20%) 0` -> `10% 0` (basis negative when the
  image is larger than the box). PASS for abs/sign.
- **INV-CALC-003** Typed math prints ` + `/` - `; token-list math keeps author whitespace (size cost #1378).
- **INV-CALC-004** Top-level NaN -> 0, inf -> clamp. **FAIL** for unrestricted ranges:
  `margin-left:mod(5px,0px)`, `calc(NaN*1px)`, `calc(sqrt(-1)*1px)` -> `5.10424e38px`. NonNegative slots hide it
  (`width:calc(NaN*1px)` -> `0`, because `f32::max(NaN, 0) = 0`).
- **INV-CALC-005** `round(nearest)` ties toward +inf (`round(-2.5px,1px)` = -2px). **FAIL**: `f32::round`
  (`calc.rs:116`) -> `-3px`; Blink and Stylo follow the spec. One-argument round and `line-width` pass through.
- **INV-CALC-006** mod() takes the sign of B, rem() of A. PASS (`calc.rs:121-122`).
- **INV-CALC-007** `clamp(MIN, VAL, MAX)` == `max(MIN, min(VAL, MAX))`, MIN wins. PASS (lowering
  `calc.rs:163-174`); incomparable center/max keeps the clamp (ddc9ce8, #836).
- **INV-CALC-008** Type errors are not repaired. **FAIL** for Sum(Value, Number): `calc(0 + 5px)`,
  `calc(100px - 0)` parse as typed Calc (pinned by `src/lib.rs:8538` `calc(1px + 1)`), so dedupe deletes
  the earlier valid value (`width:3px;width:calc(0 + 5px)` -> only the calc; #928 closed, unfiled).
  Typed division stays Unparsed (`calc.rs:597`, #1279).
- **INV-CALC-009** `e`/`pi`/exp are evaluated in f32 (`exp(100)` -> `3.40282e38`). Minor.
- **INV-CALC-010** `Product(n<1, f)` prints `f/(1/n)` (`calc.rs:984-990`); `calc(0*min(...))` ->
  `min(...)/3.40282e38`. Equivalent within precision.
- **INV-CALC-011** Nested math functions neither clamp nor round. PASS.
- **INV-CALC-012** Single-argument min()/max() simplify; absolute units compare. PASS.

Robustness (open): `Calc::add` (Sum, Sum) and `Length::add` (Calc, Calc) recurse forever on
`calc((1vh - 1rem) + (1vw + 1px))`: SIGSEGV (#910, #1092, PR #1245). `atan2` tries 5 types per level,
O(5^depth) (#1098; depth 8: 6.8 s); unclosed nested `calc(` ~x10 per 4 levels (depth 20: 1.5 s); `rgb( /`,
`hsl(atan2(` UNVERIFIED (EM-26). Percentage
math panics: #1044/#1129/#1166 fixed by #1131; #1312 fixed on master by #1329 (`percentage.rs:39-41`
returns InvalidValue; `opacity:sign(-50%)` stays as written).

Conformance: calc/min/max/hypot/abs/sign typed (`calc.rs:346-375`, `:497-535`); clamp without `none`;
round without ties-up, `line-width` or optional B; mod/rem typed; trig, pow, sqrt, log, exp only when
resolvable at parse time (else Unparsed); typed arithmetic missing.

## 5. custom-properties (VAR, PV, ENV, V5 substitution functions)

Grammar:
- `--*`: `<declaration-value>?`, initial guaranteed-invalid, inherited, computed = specified with
  substitutions, discrete. Names compare code point by code point; values keep "original author-given
  casing"; specified and computed values serialize "exactly as specified ... dropping comments,
  normalizing whitespace, reserializing numeric tokens ... must not occur" (VAR#serializing-custom-props).
- `var(<custom-property-name>, <declaration-value>?)`: a bare trailing comma = empty fallback, not no
  fallback (VAR#using-variables); same for `env()`, `attr()`, `inherit()`.
- A value with a valid substitution function is assumed valid at parse time (V5#resolve-property);
  failing later behaves like `unset` (V5#invalid-substitution); shorthands get pending-substitution
  longhands (V5#substitution-in-shorthands).
- `@property` as engines implement it: `syntax` and `inherits` required, `initial-value` required unless
  `*`, parsed per syntax, computationally independent; unknown descriptors ignored; last valid rule wins,
  registrations are global (PV#at-property-rule, PV#determining-registration); data type names are
  case-sensitive (`"<LENGTH>"` invalid, WPT).
- `env(<custom-ident> <integer [0,inf]>*, <declaration-value>?)`: names case-sensitive; unknown name or
  index count -> fallback; valid in descriptors and media queries (ENV#env-function).
- V5 ASFs (`if()`, typed `attr()`, `random()`, `first-valid()`, `inherit()`, `ident()`) and numeric
  functions (`sibling-index()`, `progress()`, `calc-size()`): `{}` arguments are syntax, `...var()` is
  three adjacent dots, `random()` `auto` keys bind to property and component index (V5#random-caching).

Invariants:
- **INV-VAR-001** Only values with a valid substitution function are assumed valid; other unparsed values
  must not delete earlier declarations. **FAIL** for `color`, `fill`, `stroke`, `caret`, `caret-color`,
  `filter`, `backdrop-filter`, `text-shadow`: FallbackHandler "Unparsed properties are always valid"
  (`src/properties/prefix_handler.rs:147-155`, list `:172-181`): `color:green;color:notacolor` ->
  `color:notacolor`. PASS for width, background, border.
- **INV-VAR-002** `var(--x,)` != `var(--x)`. PASS (`custom.rs:1211-1225`; idempotent since #1142).
- **INV-VAR-003** Names are case-sensitive (`--X` and `--x` both kept). PASS.
- **INV-VAR-004** Token text and casing are kept. **FAIL**: `TokenList::parse_into` (`custom.rs:363-463`)
  turns hashes and color functions into colors, dimensions into lengths/angles/times/resolutions, plus
  urls and numbers: `#FF0000` -> `red`, `1000ms` -> `1s`, `url( "a" )` -> `url(a)`, `1e3` -> `1000`,
  `12345678-12e3-...` -> `12345700-12000-...`. #807 closed (f32), #949 open.
- **INV-VAR-005** CSS-wide keywords in custom properties are ASCII case-insensitive. PASS.
- **INV-VAR-006** A var() declaration may replace an earlier one, but keeps its order against a later
  literal. **FAIL** for `position`, `direction`, `unicode-bidi` (#1225: `position.rs:104-114` has no
  Unparsed arm; `declaration.rs:645-657` buffers direction/unicode-bidi).
- **INV-VAR-007** A shorthand with var() is never split, merged or deduped against longhands. PASS;
  logical shorthands with var() are left unlowered (#927, #1070).
- **INV-VAR-008** Substitution is token-level (`var(--gap)px` is two tokens). PASS.
- **INV-VAR-009** `{}` arguments and `...var()` are neither stripped nor added. PASS.
- **INV-VAR-010** Relative URLs in unregistered custom properties resolve at the use site; dependency
  analysis errors with `AmbiguousUrlInCustomProperty` (`custom.rs:500-507`, #1154 by design).
- **INV-VAR-011** Variable units (`1.2--fem`, VAR L2) pass through; CSS-modules renaming UNVERIFIED.
- **INV-PROP-001** `syntax:"<LENGTH>"` is invalid. **FAIL**: `match_ignore_ascii_case!`
  (`src/values/syntax.rs:346`) accepts it and prints `"<length>"`, creating a registration.
- **INV-PROP-002** `initial-value` parses with the normal grammar. **FAIL** via INV-NUM-001:
  `initial-value:10` -> `10px` for `<length>`.
- **INV-PROP-003** The printed initial value re-parses to the same alternative. **FAIL**: `<number> |
  <length>` with `0px` -> `initial-value:0` (a number).
- **INV-PROP-004** Unknown descriptors are ignored. **FAIL**: `InvalidDeclaration`
  (`src/rules/property.rs:198`); errorRecovery drops the whole rule.
- **INV-PROP-005** Validity follows engines. Implemented (`property.rs:66-100`) except the
  computational-independence check (`10em` accepted); `initial-value` is reparsed from a substring without
  the token-list fallback (#921: `color-mix(in srgb, currentColor 15%, transparent)` is a stylesheet
  error); `light-dark()` in `initial-value` is lowered to `var()` for old targets, which invalidates the
  registration (EM-08).
- **INV-PROP-006** The last valid `@property` wins. PASS (replaced at the earlier index,
  `src/rules/mod.rs:968-979`), but a later rule engines reject (`10em`, `"<LENGTH>"`) also wins.
- **INV-PROP-007** `@property` nested in a style rule is ignored by engines; kept nested, no warning
  (hoisted for Chrome < 120; #962 open).
- **INV-ENV-001** env() names are case-sensitive. **FAIL**: `UAEnvironmentVariable` is `enum_property!`
  (`custom.rs:1281-1305`): `env(SAFE-AREA-INSET-TOP, 7px)` is lowercased and the real 0px replaces 7px.
- **INV-ENV-002** Unknown names (`keyboard-inset-*`, `titlebar-area-*`, `preferred-text-scale`) and
  index counts are preserved. PASS. **INV-ENV-003** env() in media queries and descriptors kept. PASS.
- **INV-URL-001** `url("")` == `url()`, never `none`. PASS. **INV-URL-002** fragment-only URLs keep the
  local flag. PASS. **INV-URL-003** URL modifiers are preserved. **FAIL**: hard parse error (shipped
  Chrome 150, Safari 26.2).
- **INV-V5-001** Unmodelled functions pass through verbatim, never evaluated or dropped. PASS via
  `Property::Unparsed`, except the INV-VAR-001 properties.
- **INV-V5-002** `random()` with auto keys: no shorthand/longhand conversion, component dedupe or
  reorder. PASS. **INV-V5-003** `attr()` empty fallback and unit spacing (`attr(data-w px)`) kept. PASS
  (#1126). **INV-V5-005** `interpolate-size` and `calc-size()` pass through. PASS.

Conformance: `--*` TokenList (`custom.rs:40-60`, `:207-463`); `var()` typed (`:1186-1233`; the name match
`f == "var"` is case-sensitive, so `VAR(--x)` is an opaque function, harmless); `env()` partial
(`:1245-1411`); `@property` partial (single name `property.rs:31`); `<syntax>` partial (`syntax.rs:57-90`,
`:339-373`: no escapes, CSS-wide idents accepted); V5 functions passthrough.

## 6. Engine facts that affect the oracle

| area | fact | consequence |
|---|---|---|
| custom-properties | Unregistered values read back verbatim; whitespace and leading comments trimmed, internal comments kept (all three); Firefox 157 keeps a trailing comment; WebKit re-serializes strings and escapes | token drift shows as `different`; base and head normalize alike, so most drift is `still-different` |
| values-numeric | Oracle numbers are `noise` within max(0.002, 1e-4 x value) | 6-significant-digit drift is invisible: use `output-contains` |
| values-numeric | `0%` vs `0px` in `background-position`/`transform-origin` differ as computed strings | render-equivalent; cite V4#combine-mixed |
| calc-math | Cyclic percentages for `width` diverge from the spec (csswg #10969) | probe `height` with an indefinite basis |
| values-numeric | Chrome uses doubles, Firefox f32 lengths; LayoutUnit 1/64 px (Gecko 1/60) | compare used lengths at layout-unit granularity |
| custom-properties | Registered values compute canonically (`1em` -> `10px`, `<integer>` `calc(1.6)` -> `2`) | registered drift is less visible |
| custom-properties | `@property` validity = pre-2026 rules in all engines; ED #13211 unimplemented (UNVERIFIED) | judge against engines, note the ED |
| custom-properties | Playwright desktop `env(safe-area-inset-*)` = 0px | env probes need a non-zero fallback |
| calc-math | legacy Chromium/Firefox lack `round/mod/rem/abs/sign` (WebKit 15.4+ has them); Firefox 108 and legacy-2021 also lack `infinity`, legacy-2021 `e`/`pi` | unlowered math is dropped there (O4): no lowering exists |

## 7. Lowering and fallbacks (what an exact fallback must keep)

- **clamp() -> max(MIN, min(VAL, MAX))** when `ClampFunction` is unsupported (`calc.rs:163-174`): exact.
  Not applied inside custom properties.
- **Custom-property colors** (`custom.rs:1052-1089`): lowest supported color in place, `@supports (color:
  lab(0% 0 0))` copies right after the rule. Must keep selector, position before later rules,
  `!important` (verified) and nesting context (lost after a nested rule #1381, PR #1386; leaks to the next
  sibling's selector, arch-core #1023). An author pair `--x:red;--x:lab(...)` is replaced (#109).
- **light-dark()** (`custom.rs:1606-1617`, `src/properties/ui.rs:568-575`): `var(--lightningcss-light, L)
  var(--lightningcss-dark, D)` plus `--lightningcss-light:initial;--lightningcss-dark: ;` where
  `color-scheme` is set. Values resolve where the custom property is declared, so a child with another
  `color-scheme` diverges (#821, #873, by design; opt out with `Features::LightDark`); invalid inside
  `@property initial-value`; the dark `@media` rule drops `!important` (arch-core N5); re-minifying
  repeats the toggles (EM-132).
- **`x` -> `dppx`**: exact, gated by `XResolutionUnit`; context-free in token lists (#1286).
- **NonNegative clamping** (#1329): resolvable negative calc -> `0`; negative percentages keep `calc()`
  (`percentage.rs:273-280`). Other ranges are not handled.
- **No fallbacks** for new units (`dvh`, container units, `lh`), round/mod/rem/abs/sign/trig, calc keywords
  or exponent notation. An author fallback (`height:100vh;height:100dvh`) survives only if compat data is
  right for every target (`compat.rs` gives desktop Opera Android's dvh version 73, not 94).

## 8. Spec changes since 2023 that LightningCSS lags

| date | spec | change | ref | LightningCSS |
|---|---|---|---|---|
| 2022-03 | SYN | non-ASCII ident code points restricted | #7129 | not implemented (nor in engines) |
| 2023-05 | SYN | nesting parser; unicode-range re-tokenized; numeric tokens keep the sign | #8738 #8835 | sign dropped in token lists |
| 2023-10 | SYN | `{}` only as a whole non-custom value | #9317 #9336 | errors (recovery clears the block) |
| 2023-12 | V4 | `clamp(none, ...)` | #9713 | passthrough |
| 2024 | V4 | `round(A)` for numbers; percentage type inference | #9668 #10017 | passthrough |
| 2024-26 | V5 | ASFs, `if()`, typed `attr()`, `random()` keys, `progress(no-clamp)`, `cycle()`, `ident()` | #10679 #11500 #13132 #11825 #14288 #14213 | passthrough |
| 2026-03 | V4, ENV | `round(line-width, ...)`; env() argument grammar | #3720 #13642 | passthrough |
| 2026-06 | V4 | generic functional-notation serialization | #9720 | output may differ |
| 2026-07 | PV | `@property --a, --b` | #14227 | parse error |
| 2026-08 | PV | all descriptors optional, descriptor-local failure | #13211 | old rules (= engines) |
| 2026-08 | V5 | numeric functions (`sibling-index()`) clamp/round like math | #13978 | passthrough |
| L2 ED | VAR | variable units; empty value serializes as "" | css-variables-2 | passthrough |
| 2024-26 | V5 | `<request-url-modifier>` | V5#request-url-modifiers | parse error (INV-URL-003) |
