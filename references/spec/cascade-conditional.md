# Spec digest: cascade, layers, @scope, @supports, @container, media queries, nesting

`KEY#anchor` = `https://drafts.csswg.org/<spec>/#<anchor>`: C5/C6 css-cascade-5/-6, CO3/CO4/CO5
css-conditional-3/-4/-5 (CO5 = container queries), MQ4/MQ5 mediaqueries-4/-5, NEST css-nesting-1, SYN css-syntax-3.

## Cascade (C5)

- Sort (C5#cascade-sort): origin+importance > context > style attribute > layer (normal: later wins;
  `!important`: earlier wins; unlayered = implicit last) > specificity > scope proximity (C6) > order.
- CSS-wide keywords: `initial inherit unset revert revert-layer revert-rule`. `revert-rule` acts as if the
  current rule were absent (C5#revert-rule-keyword): merging it with a same-selector rule or deleting an
  earlier duplicate changes its result.
- A shorthand sets every sub-property, reset-only ones too (`font` → `font-variant-*`, `border` →
  `border-image`) (C5#shorthand). Longhands sharing a CSS-wide keyword never fold with other values.
- `all` resets everything except `direction`, `unicode-bidi`, custom properties (C5#all-shorthand).
- Importance is per declaration (C5#importance); dedupe keys must include it.
- Filtering (C5#filtering): a rejected declaration does not override. Removing an earlier value is safe
  only if every target accepts the later one.

## @import and @layer (C5)

`@import <url> [layer | layer(<name>)]? [supports(…)]? <media-query-list>?;` `<layer-name> = <ident> ['.' <ident>]*`
- `@import` precedes every valid rule except `@charset`, `@layer` statements, `@supports-condition`
  (C5#at-import); invalid rules do not count, an empty `@layer x {}` does. L5 parsers accept only layer →
  supports → media. `supports(decl)` ≡ `supports((decl))`, never evaluated (C5#conditional-import).
- Layer order = first declaration by any route: statement, block, `@import layer()`, dotted sublayer,
  nested block (C5#layer-ordering); inside `@media`/`@supports` only while true, inside `@container`
  always. An empty block declares the layer (C5#layer-empty).
- Each anonymous `@layer {}` is its own layer (C5#unnamed-layers), visible with `!important`.
- CSS-wide keywords are not layer names (C5#typedef-layer-name). Same-name `@keyframes`/`@property`/
  `@font-face` in different layers resolve by layer order.

## @scope (C6)

`@scope [(<scope-start>)]? [to (<scope-end>)]? { <block-contents> }`; preludes are unforgiving selector lists.
- `&` in the body and `<scope-end>` = `:where(:scope)`, zero specificity (C6#scope-effects); the prelude
  adds none; proximity ranks after specificity (C6#scope-proximity).
- Nested in a style rule, `&` in `<scope-start>` = parent rule; elsewhere `:where(:scope)` (NEST#nesting-at-scope).
- One invalid selector, a pseudo-element or a relative `<scope-start>` voids the rule (C6#scope-syntax).
- Bare declarations (C6#scoped-declarations) and relative selectors (C6#scoped-rules) are valid in the body.
- No selector equivalent for limits or proximity: never lowered (C6#scope-limits).

## @supports (CO3, CO4)

`not <in-parens> | <in-parens> [and <in-parens>]* | <in-parens> [or <in-parens>]*`; features: `(<declaration>)`,
`selector()`, `font-tech()`, `font-format()`, `at-rule()`, `named-feature()`, `env()`.
- Two-valued: general-enclosed and unknown functions are false, so `not (foo bar)` is true
  (CO3#typedef-supports-condition). Mixed `and`/`or` at one level is invalid; `not(` is a function token.
- Support = property and whole value accepted, tested as written (CO3#dfn-support). `selector()` is
  unforgiving (CO4#dfn-support-selector).
- "Any prefix" of one declaration is an `or`; inside `and` it changes the truth value.

## @container (CO5)

`@container <container-condition># {…}`, condition = `[<container-name>? <container-query>?]!`; queries:
size features, `style()`, `scroll-state()`, general-enclosed.
- Each listed condition selects its own container (CO5#container-rule); a list is not one `or`.
- Unknown features select nothing; keep them. Name-only `@container card {}` is valid.
- `var()`, relative units and tree-counting functions resolve against the container: never pre-compute.
- Style features compare computed values, tokens for unregistered custom properties: `style(--x: #ff0000)`
  ≠ `style(--x: red)` (CO5#style-container). `revert*` in a style feature is false.
- `container: none / size` keeps the `none` name (CO5#container-shorthand).

## Media queries (MQ4, MQ5)

`[not | only]? <media-type> [and <condition-without-or>]? | <condition>`; `@custom-media --x <list> | true | false;`
- Kleene logic: general-enclosed = unknown, `not unknown` = unknown, top-level unknown = false (MQ4#evaluating).
- Empty list = true. An invalid query becomes `not all` alone (MQ4#error-handling).
- `not` negates the whole query, type included (MQ4#mq-not). `not (w < X)` ≡ `(w >= X)`; `not (w = X)`
  has no single-comparison form.
- `min-`/`max-` = `>=`/`<=`, invalid on discrete features and in boolean context (MQ4#mq-min-max).
  Unitless non-zero lengths are invalid. Ranges are false in the negative range (MQ4#false-in-the-negative-range).
- Relative units use the initial font size: `em` → `px` is inexact (MQ4#units).
- Custom media substitute logically: a list inside `and` = `(a or b)`; undefined or cyclic names are unknown, so the whole query is `not all`, even under `not` (MQ5#custom-mq).
- Custom media names are case-sensitive; types and features are not.

## Nesting (NEST, SYN)

- `&` = `:is(<parent list>)`: max specificity of the list; it cannot represent pseudo-elements
  (NEST#nest-selector), so `.a::before{&:hover{}}` matches nothing. Top-level `&` = `:scope`, zero
  specificity. `&div` is invalid, `div&` valid.
- Declarations after nested rules are nested declarations rules in place: `a{color:green; &{color:blue}
  color:red}` ends red (NEST#mixing). They match the parent's elements and pseudo-elements with each
  parent selector's own specificity (NEST#nested-declarations-rule).
- An invalid nested item is dropped alone; earlier declarations survive (SYN#consume-block-contents).
- Nested group rules take bare declarations; `&` comes from the nearest style rule (NEST#conditionals).

## Lowering: what an exact fallback must preserve

- Nesting: exact only with `:is()`; a parent is inlined only at the leftmost position of an absolute
  selector. Order: parent, nested rules, trailing declarations. Engines with nesting but without
  `CSSNestedDeclarations` (C120-129, F117-131, S17.2-18.1) hoist trailing declarations above nested rules.
  No exact lowering below `:is()` or for pseudo-element parents.
- Media range: `>=`/`<=` → `min-`/`max-` exact; `not (max-…)` is MQ4-only. MQ3-safe: `not all and
  (max-width:X)`, `(min-color:N+1)` for integers, nested `@media` for type + range. No epsilons;
  negative bounds have no MQ3 form.
- Resolution: `dpi`/`dpcm` → `dppx`; prefixed device-pixel-ratio queries only as extra list entries.
- `@supports`: fallbacks omitted only for features an `and` chain or single condition guarantees.
- Never lowered or evaluated: `@layer`, `@scope`, `@container`, `revert-layer`/`revert-rule`, `@import`
  conditions (bundling only wraps), `selector()`/`font-tech()`/`at-rule()`, `@when`/`@else`.

## Engine support that decides oracle coverage

| Feature | C | F | S | Note |
|---|---|---|---|---|
| `@layer`, `revert-layer` | 99 | 97 | 15.4 | C97/F93 lack it |
| `revert-rule` / `@scope` | 148 / 118 | 150 / 146 | 27 / 26.4 | latest only |
| nesting / nested decls | 120 / 130 | 117 / 132 | 17.2 / 18.2 | no engine in the hoisting window |
| MQ4 range/interval | 104 | 63/102 | 16.4 | C97/WK15.4 reject; `not (…)` no compat key |
| `@container` size / style | 105 / 111 | 110 / 151 | 16 / 18 | Firefox differs on unknown features |
| style range, `scroll-state()` | 142, 133 | 151, no | no | expect O9 |
| `:is()` | 88 | 78 | 14 | all engines have it: use output assertions |
| `@custom-media`, `@when`, `@supports-condition` | no | no | no | output assertions only |
