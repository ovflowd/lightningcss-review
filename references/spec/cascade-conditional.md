# Spec digest: cascade, layers, @scope, @supports, @container, media queries, nesting, rule merging

Areas: `cascade-layers-scope`, `supports-container`, `media-queries`, `nesting`, `rule-merging` (rule level).
`file:line` = `~/GitHub/lightningcss` at `cbeaf83`; "verified" = output of a CLI built from `cbeaf83` sources.
✗ = pre-existing master defect: judge a PR on whether it fixes, keeps or worsens it. Probe ids live in the
area checklists (`references/checklists/<area>.md`).

## 0. Specs read (Editor's Drafts fetched 2026-10-25; URL = `https://drafts.csswg.org/<spec>/#<anchor>`)

| key | spec | status |
|---|---|---|
| C5 | css-cascade-5 | ED 2026-04-13, CR track (`revert-layer` at risk) |
| C6 | css-cascade-6 | ED 2026-04-28, diff over L5 |
| CO3 / CO4 | css-conditional-3 / -4 | ED 2026-10-08 (L3 CR, no normative change since CRD 2024-08-15; L4 adds `selector()`) |
| CO5 | css-conditional-5 | WD 2026-10-08 (container queries live here; css-contain-3 is a placeholder) |
| MQ4 / MQ5 | mediaqueries-4 / -5 | CRD 2026-10-08 / WD 2026-10-19 (`@custom-media`) |
| NEST | css-nesting-1 | ED 2026-10-08 |
| SYN | css-syntax-3 | ED 2026-10-20 (§5.5 block contents) |

Anchors `KEY#anchor` were checked against the fetched drafts. Engines: BCD main, wpt.fyi stable 2026-10-24/25.

## 1. Master defects (verified; unfiled unless an issue is named)

| # | Input → master output | Where |
|---|---|---|
| D1 | `@media not (width = 100px)` → `(width=100px)` (since `7f29035`, v1.29.0) | `media_query.rs:944-952` via `:869-875` |
| D2 | `@media {}` (true) → `@media not all {}` with the pretty printer (print, `lower`, `transform({minify:false})`) | `media_query.rs:167-169`; unwrap needs `dest.minify` (`rules/media.rs:53`) |
| D3 | `@supports (-ms-transform:none) and (transform:none)` → `((-ms-transform:none) or (transform:none))` | `supports.rs:237-252`, printer `:389-416` (`6bd2761`, v1.24.1) |
| D4 | `@scope (.a) to (& > .b)` → `to (.a>.b)` without targets; nested `.p{@scope (& > .s) to (& .l){}}` → `to (:is(&>.s) .l)` | `scope.rs:86-90` |
| D5 | `@scope (.a, .c <> .d)` → `@scope(.a)`; pseudo-elements accepted; `(> .a)` → `(:scope>.a)` | `parser.rs:697,706` (`IgnoreInvalidSelector`, TODO `:696`) |
| D6 | `revert-rule` unknown: `all: revert-rule` hard error; merge/dedupe change what it reverts to; `font-family:"revert-rule"` unquoted (EM-70) | `properties/mod.rs:1684-1695`, `:714`; keyword lists (EM-80) |
| D7 | `style(--x: #ff0000)` → `style(--x:red)` | `container.rs:298` (`Property::parse`), `:394` |
| D8 | errorRecovery: an item error clears every earlier declaration (`.a{color:red;@keyframes k{}height:2px}` → `.a{height:2px}`) | `parser.rs:496-498` (`a8b7ea0`, v1.22.0); #1358, PR #1374 |
| D9 | `.a{&div{}}` (invalid) lowered → `div.a`; `.foo{> &a{}}` → `.foo>.fooa` (EM-110) | `selector.rs:1547-1560`, first compound only `:1478`; #489 |
| D10 | `@import` after an invalid style rule, an unknown block at-rule or `@supports-condition` → `UnexpectedImportRule` (dropped under errorRecovery) | `parser.rs:447`, `:365` set `State::Body` first |
| D11 | `@custom-media --x true;` → `@media true` (never matches) | `media_query.rs:1827-1837` |
| D12 | `@media (min-width: 10)` (invalid) → `(width>=10px)` | `values/length.rs:145-148`; #1199/#682 |
| D13 | `MediaQuery::and` negates the type only: `not print` ∧ `(min-width:250px)` → `not print and (width>=250px)` = ¬(print∧w≥250); `not all` ∧ `(min-width:100px)` → `not all and (width>=100px)` (never → matches below 100px) | `media_query.rs:367-417`, via `bundler.rs:490` |
| D14 | `MediaList::and` ANDs every right-hand query into each left one: `print` ∧ `(min-width:100px), (max-width:50px)` → `print and (width>=100px) and (width<=50px)` | `media_query.rs:132-149` (bundler) |
| D15 | `CUSTOM_MEDIA`+targets: `@import "x.css" (--mq)` keeps `(--mq)` while `@custom-media --mq` is removed | only `MediaRule::minify` substitutes (`media.rs:38-40`); `mod.rs:667-671` |

Unfiled findings the checklists cite (research ids): N1 stale dedupe key deletes a live rule; N2/N3 in-place
`@keyframes` replacement; N5 `!important` lost on `:dir()`/dark side rules; N6 anonymous `@layer` never minified.

## 2. @import and @layer (C5)

```
@import [<url>|<string>] [layer | layer(<layer-name>)]? [supports(<supports-condition> | <declaration>)]? <media-query-list>? ;
@layer <layer-name>? { <rule-list> }    @layer <layer-name>#;    <layer-name> = <ident> ['.' <ident>]*   (no whitespace)
```
- `@import` precedes every other *valid* rule except `@charset`, `@layer` statements, `@supports-condition`
  (invalid rules do not count; an empty `@layer x {}` block does). A failing condition = sheet wrapped in
  `@media`/`@supports`; a false `supports()` must not fetch.
- Cascade sort (C5#cascade-sort): origin+importance > context > style attribute > **layer** (normal: later
  wins; important: earlier wins; unlayered = implicit last) > specificity > [C6: scope proximity] > order.
- Layer order = first declaration (statement, block, `@import layer()`, inside a *true* conditional;
  `@container` always counts). Each anonymous block is its own layer; `a{}` and `a.b{}` share a hierarchy.

| INV | Statement | Anchor | Master |
|---|---|---|---|
| INV-IMP-001 | `@import` stays valid after invalid rules, `@charset`, layer statements, `@supports-condition` (WPT `CSS2/cascade/at-import-009/010`) | C5#at-import | ✗ D10 |
| INV-IMP-002 | Print `layer` → `supports()` → media; L5 parsers read a later `layer()` as general-enclosed media | C5#at-import | ✓ `import.rs:64-87` |
| INV-IMP-003 | `supports(decl)` ≡ `supports((decl))`; never drop or evaluate `supports()` | C5#conditional-import | ✓ |
| INV-IMP-004 | Conditional `@import … layer(a) screen` does not make a later unconditional `@layer a` redundant | C5#at-import | ✓ `mod.rs:1028-1036` |
| INV-IMP-005 | Per-query media error handling; dropping `all` allowed (master keeps it); empty list never `not all` | MQ4#mq-list | ✓ `import.rs:83` |
| INV-LAY-001 | Hoisting a statement or merging a later block never moves a first declaration across rules that may declare layers (conditionals, imports, unknown at-rules, nested style rules) | C5#layer-ordering | ✓ since `32aecd9` (#974), `mod.rs:614-624` |
| INV-LAY-002 | Empty `@layer x {}` (also in a true `@media`) declares `x`: may become `@layer x;`, removed only if declared unconditionally before | C5#layer-empty | ✓ `mod.rs:993-1022` |
| INV-LAY-003 | Layers declared in `@container` always count; in `@media`/`@supports` only while true | C5#layer-ordering | ✓ |
| INV-LAY-004 | Anonymous blocks never merge (visible with `!important`); empty ones may go | C5#unnamed-layers | ✓ `mod.rs:716`, `:1019-1022` |
| INV-LAY-005 | Same-name blocks may merge across unlayered rules and other layers, never across a sublayer declaration (`@layer a.y` between `a` blocks), a conditional or an import | C5#cascade-sort | ✓ |
| INV-LAY-006 | CSS-wide keywords are reserved: `@layer initial {}` is invalid | C5#typedef-layer-name | ✗ accepted and merged (`layer.rs:36-60`) |
| INV-LAY-007 | No layer statement between `@import`/`@namespace` rules | C5#at-import | ✓ `parser.rs:409-416` |
| INV-LAY-008 | Merging same-layer rules around `revert-layer` is safe; moving a rule into another layer is not | C5#revert-layer | ✓ |
| INV-LAY-009 | Same-name `@keyframes`/`@font-face`/`@property` in different layers resolve by layer order: dedupe per list | C5#layer-ordering | ✓ `mod.rs:606-610` |

Conformance: `@import` L5 order only (C6 `scope()`/any order not parsed; `supports() layer()` errors). Layer
minify: statements become placeholder blocks (`mod.rs:731-750`); a block merges into its root's remembered block
only with an equal full name (`:712-730`); `layer_rules` is cleared by every rule except LayerBlock/
LayerStatement/Ignored/style rules without nested rules (`:615-624`); the post-pass (`:986-1044`, only if a named
layer exists: N6) combines empty named blocks into statements across Ignored and plain style rules. Open: #655,
#582 (`@custom-media` inside `@layer` not collected).

## 3. @scope (C6)

```
@scope [(<scope-start>)]? [to (<scope-end>)]? { <block-contents> }    <scope-start>, <scope-end> = <selector-list> (unforgiving)
```
- In `@scope`, `&` = `:where(:scope)` (Issue 9740) in the body and `<scope-end>`; the prelude adds no
  specificity; proximity sits after specificity, before order. No `<scope-start>`: root = owner's parent/host.
- Nested in a style rule: `&` in `<scope-start>` = parent; in `<scope-end>`/body = `:where(:scope)`
  (`@scope (& > .s) to (& .l)` ≡ `@scope (.p > .s) to (:where(:scope) .l)`, NEST#nesting-at-scope).

| INV | Statement | Anchor | Master |
|---|---|---|---|
| INV-SCO-001 | `&` in `@scope` = `:where(:scope)` (0 specificity), body and `<scope-end>` | C6#scope-effects | ✗ #1189 (lowered `&` → `:scope`, `selector.rs:1767-1768`); ✗ D4 |
| INV-SCO-002 | One invalid prelude selector invalidates the rule | C6#scope-syntax | ✗ D5 |
| INV-SCO-003 | Pseudo-elements invalid in preludes; `<scope-start>` is not relative | C6#scope-syntax | ✗ D5 |
| INV-SCO-004 | Changing scoped-selector specificity can flip results through proximity | C6#scope-proximity | via #1189 |
| INV-SCO-005 | `@scope` is never lowered (proximity and limits have no selector equivalent) | C6#scope-limits | ✓ |
| INV-SCO-006 | Implicit `@scope {}` is document-dependent: never rewritten to `:root` or flattened | C6#scope-limits | ✓ |
| INV-SCO-007 | Declarations directly in `@scope` are valid | C6#scoped-declarations | ✗ #1165 (`parser.rs:191`) |
| INV-SCO-008 | Adjacent equal-prelude `@scope` rules are not merged | C6#scope-syntax | ✓ |

Also: top-level `@scope (.a) { > .b {} }` → `EmptySelector` (C6#scoped-rules allows relative selectors).
Lowered (chrome 100) `.p{@scope (& > .s) to (& .l){.x{}}}` → `@scope(.p>.s) to (.p>.s .l){:scope .x{}}` (verified).

## 4. CSS-wide keywords, shorthands, `!important` (C5)

Keywords: `initial | inherit | unset | revert | revert-layer | revert-rule` (`revert-rule`: as if the current
style rule were absent; C148/F150/S27). A shorthand sets every sub-property, reset-only ones included (`border`
→ `border-image`, `font` → `font-variant-*`); a keyword or `!important` on it applies to all.

| INV | Statement | Anchor | Master |
|---|---|---|---|
| INV-CAS-001 | Merging `.a{x}.a{color:revert-rule}`, or removing an earlier duplicate, changes what `revert-rule` reverts to; `all: revert-rule` parses; merging inside one rule is safe | C5#revert-rule-keyword | ✗ D6 |
| INV-CAS-002 | Longhands sharing a CSS-wide keyword are never collapsed into the shorthand | C5#shorthand | ✓ |
| INV-CAS-003 | Before `all:` only `direction`/`unicode-bidi`/custom properties survive (they may move after it) | C5#all-shorthand | ✓ `declaration.rs:646-674` |
| INV-CAS-004 | Importance is per property; dedupe compares (property, importance) | C5#importance | ✓ since `93b9e66`, `style.rs:152-171` |
| INV-CAS-005 | A later value the engine rejects does not override: dropping an earlier declaration/rule needs every target to accept the later value (`Unparsed` too); no targets = perfect engine (#826) | C5#filtering | partial (#1291, #928) |
| INV-CAS-006 | `revert`/`revert-layer` revert aliases and logical pairs: lowering that splits a pair keeps it | C5#default | ✓ |

Conformance: no `revert-rule` in `CSSWideKeyword` (`properties/mod.rs:1684-1695`): other properties keep it as
`Unparsed`; `Property::All` parses only `CSSWideKeyword` (`:714`), so `all: revert-rule` and `all: var(--x)`
(#752, `d7aeff3` v1.25.0) are hard errors. `handle_all` drops earlier declarations with no targets check.

## 5. @supports (CO3/CO4/CO5)

```
<supports-condition> = not <supports-in-parens> | <supports-in-parens> [and <supports-in-parens>]* | <supports-in-parens> [or <supports-in-parens>]*
<supports-feature>   = selector(<complex-selector>) | font-tech() | font-format() | at-rule() | named-feature() | env() | (<declaration>)
```
Two-valued: `<general-enclosed>` and unknown functions are false (`not (foo bar)` is true). Mixing `and`/`or`
at one level is invalid; `not`/`and`/`or` need whitespace after them (`not(` is a function token = general-
enclosed). Support = property *and* full value accepted; `selector()` is recursive (`:is(.a,:x)` false).
`conditionText` forbids logical simplification. `@when`/`@else` chains break on any token in between.

| INV | Statement | Anchor | Master |
|---|---|---|---|
| INV-SUP-001 | `and`/`or`/`not` is semantic; merging prefixed variants into "any prefix" is valid only in `or` | CO3#typedef-supports-condition | ✗ D3; ✗ #710 (`supports.rs:239` shadows `property_id`; `and` operand `(-webkit-box-orient:vertical)` → `(box-orient:vertical)`) |
| INV-SUP-002 | Never simplify `@supports` with Kleene logic, or media/container with two-valued logic | CO3#at-supports | ✓ |
| INV-SUP-003 | Never evaluate a condition from LightningCSS's feature data | CO3#the-csssupportsrule-interface | ✓ (only fallback generation narrows) |
| INV-SUP-004 | `selector()` argument kept verbatim | CO4#dfn-support-selector | ✓ `supports.rs:281-291` |
| INV-SUP-005 | Declaration values tested as written | CO3#dfn-support | ✓ raw slice `supports.rs:317-329` |
| INV-SUP-006 | Only *adjacent* identical `@media`/`@supports`/`@container` (name+condition) merge | CO3#processing | ✓ `mod.rs:544-597` (#1263), `:672-711` |
| INV-SUP-007 | `(p:v)` → `((-webkit-p:v) or (p:v))` for targets is intended, also under `not` (`supports.rs:153-169`) | CO3#at-supports | by design; contested in #977 (no maintainer reply) |

Conformance: unknown features and general-enclosed kept raw (`SupportsCondition::Unknown`, `supports.rs:296-314`).
`TargetsWithSupportsScope` (`targets.rs:257-289`; `supports.rs:46-57,76-80`) excludes the features of an
`and`/single-declaration condition while minifying and printing the block; `not`/`or` give none (`:184-185`; #878,
`d398c1b`). `@supports-condition`, `@when`/`@else` are preserved unknown rules.

## 6. @container (CO5)

```
@container <container-condition># { <rule-list> }      <container-condition> = [ <container-name>? <container-query>? ]!
<query-in-parens> = (<container-query>) | (<size-feature>) | style(<style-query>) | scroll-state(…) | <general-enclosed>
container-type: normal | [[size | inline-size] || scroll-state]      container: <'container-name'> [/ <'container-type'>]?
```
Each listed condition picks its own container; unknown features select none (unknown). `var()`, relative units
and tree-counting functions resolve against the container. Style features compare computed values (tokens for
unregistered custom properties); `revert*` in a style feature → false.

| INV | Statement | Anchor | Master |
|---|---|---|---|
| INV-CQ-001 | `style(--x: v)` values of unregistered custom properties are verbatim | CO5#style-container | ✗ D7 |
| INV-CQ-002 | `container-name:none; container-type:size` → `none / size`; omitted type = `normal` | CO5#container-shorthand | ✓ `contain.rs:145-157` |
| INV-CQ-003 | A condition list is not one `or` query; nested `@container` rules never merge into one condition | CO5#container-rule | n/a: lists rejected (#1210) |
| INV-CQ-004 | Unknown features preserved, never rewritten or dropped | CO5#container-rule | partial: error without errorRecovery (#1176) |
| INV-CQ-005 | Container conditions are never range-lowered | CO5#size-container | ✓ `container.rs:491-495` |
| INV-CQ-006 | Name-only `@container card {}` is valid | CO5#container-rule | ✓; errorRecovery: false warning, `@container card   {` (#1370) |
| INV-CQ-007 | `container-type: inline-size scroll-state` stays valid | CO5#propdef-container-type | ✓ kept `Unparsed` |
| INV-CQ-008 | `revert*` in a style feature → false; never repaired | CO5#style-container | ✓ |

Conformance: size features typed (`container.rs:83-101`); `style()` re-parsed and minified (D7), no range form
(#1069), `!important` dropped; `scroll-state()` accepts any ident; errors for `var()` (#1325),
general-enclosed/`anchored()` (#1176, PR #1218), lists (#1210). Name-only detection relies on condition parsing
failing (`parser.rs:669-683`), which errorRecovery defeats (`container.rs:340-347`; PR #1330 rejected, PR #1379
open). `ContainerName` is CSS-module hashed unless `container:false` (`:445-459`, #835).

## 7. Media queries and custom media (MQ4/MQ5)

```
<media-query> = <media-condition> | [not | only]? <media-type> [and <media-condition-without-or>]?
<media-in-parens> = (<media-condition>) | (<media-feature>) | <general-enclosed>
@custom-media <extension-name> [<media-query-list> | true | false] ;
```
- Kleene logic: general-enclosed = unknown, `not unknown` = unknown, top-level unknown = false. Empty list =
  true. An invalid query becomes `not all` **for that query only**. `not` negates the whole query.
- `min-`/`max-` = `>=`/`<=`, invalid on discrete features and in a boolean context (`(min-width)` is a syntax
  error). Range features are false in the negative range. Relative units use the initial font size. Custom
  media are logical (`--m: (color), (hover)` in `and` = `((color) or (hover))`); undefined or cyclic → unknown.

| INV | Statement | Anchor | Master |
|---|---|---|---|
| INV-MQ-001 | `not (w < X)` ↔ `(w >= X)`, `not (w > X)` ↔ `(w <= X)`; `=` has no single-comparison negation | MQ4#mq-range-context | ✗ D1 |
| INV-MQ-002 | An empty list never prints as `not all` | MQ4#mq-list | ✗ D2 |
| INV-MQ-003 | Bad query → `not all` for it alone; never drop the list, never make a bad query valid | MQ4#error-handling | partial: strict mode errors (`media_query.rs:68-71`); ✗ #1366 (`a84fbdb`, `:1042-1046`); ✗ D12 |
| INV-MQ-004 | `<general-enclosed>` is preserved | MQ4#evaluating | partial: error unless errorRecovery (#987, #1278; `:614-631`) |
| INV-MQ-005 | min/max ↔ range is exact; range needs C104, F63 (name-first; value-first 102), S16.4 | MQ4#mq-min-max | ✓; no-target output uses range syntax (by design) |
| INV-MQ-006 | Lowered exclusive bounds are exact *and* target-parsable: `(width > X)` ≡ `not all and (max-width: X)` (MQ3); `not (max-width: X)` is MQ4-only (`or_syntax` C104/F64/S16.4); `(color > 2)` ≡ `(min-color: 3)` | MQ4#mq-min-max | ✗ #1361 (`7f29035`) |
| INV-MQ-007 | `not (width <= -100px)` is true; MQ3 engines reject negative values | MQ4#false-in-the-negative-range | ✓ |
| INV-MQ-008 | `MediaQuery::and`/`MediaList::and` are a logical AND: `not` negates the whole query; lists AND as a cross product | MQ4#mq-not | ✗ D13, D14 |
| INV-MQ-009 | `only` stays before a media type; types/feature names ASCII case-insensitive, custom media names case-sensitive | MQ4#mq-only | ✓ |
| INV-MQ-010 | Custom media: lists wrapped `(a or b)` in `and`; negation negates the type too; `true`/`false` keywords; last wins; undefined/cyclic → `not all` | MQ5#custom-mq | ✓ lists; ✗ #213, D11, D15; ✗ undefined/cyclic error (`:1807-1817`); ✗ `(--s) or (…)` → `screen and (…)` |
| INV-MQ-011 | Never convert `em` → `px` in media or container queries | MQ4#units | ✓ |
| INV-MQ-012 | Resolution fallbacks are extra list entries (false where unknown, also under `not`) | MQ4#mq-list | ✓ `media_query.rs:95-115`, `:651-683` |

Conformance: MQ5 features typed except `ua-color-scheme`; `resolution: infinite` rejected (valid);
`MediaType::Custom` printed unescaped (`:443`, EM-04); ranges printed name-first (Firefox 63-101 safe).
`@custom-media` needs `CUSTOM_MEDIA` and targets (`stylesheet.rs:232-243`, #1349 by design), is pre-scanned at
the top level only and sets `State::Body` (`parser.rs:405`). `@media`: unwrapped when `always_matches` only by the
compact printer (`media.rs:52-56`); empty body or exactly `not all` removed (`:43`); no dead-query elimination
(#904). #379: `1/1` prints `1`; old-engine support of one-number `<ratio>` UNVERIFIED (issue: C<110/S<16.4).

## 8. Nesting (NEST)

- Nested rules take a `<relative-selector-list>` (non-relative if it contains `&` and starts without a
  combinator). An invalid nested rule is dropped; earlier declarations survive (SYN#consume-block-contents).
- Declarations after/between nested rules form nested declarations rules in order: `a{color:green; &{color:blue}
  color:red}` ≡ `a{green} :is(a){blue} a{red}`; they match the parent's elements *and pseudo-elements*.
- `&` = `:is(<parent list>)` (max specificity; 0 with no parent), cannot represent pseudo-elements; top-level `&`
  ≡ `:scope` with zero specificity; `&div` invalid (`div&` valid). Nested group rules (`@media`, `@supports`,
  `@container`, `@layer`, `@scope`) take bare declarations; `&` comes from the nearest style rule.

| INV | Statement | Anchor | Master |
|---|---|---|---|
| INV-NEST-001 | Lowered declarations after a nested rule stay after it | NEST#mixing | ✓ `parser.rs:1041-1081`, `nesting.rs:87-123` |
| INV-NEST-002 | Nested declarations lower to the parent list itself, not `:is(parent)` (keeps `::before`) | NEST#nested-declarations-rule | ✓ |
| INV-NEST-003 | `&` keeps `:is()` max specificity; no exact lowering without `:is()` | NEST#nest-selector | ✗ `:is()` emitted for C<88/F<78/S<14 (#202, #944, #1159) |
| INV-NEST-004 | `.foo::before{&:hover{}}` matches nothing natively; lowering must not make it match | NEST#nest-selector | ✗ #982; PR #1156 has the wrong premise |
| INV-NEST-005 | `&div` is dropped, not lowered to `div.a`; `div{span&{}}` → `span:is(div)` | NEST#nest-selector | ✗ D9 |
| INV-NEST-006 | Top-level `&` lowers to `:where(:scope)` | NEST#nest-selector | ✗ `:scope` (`selector.rs:1767-1768`) |
| INV-NEST-007 | An invalid nested item discards only itself | SYN#consume-block-contents | ✗ D8 = #1358 |
| INV-NEST-008 | Nested group rules keep relative nesting; nested `@layer` stays nested | NEST#conditionals | ✓ (#1138: no query merging, by design) |
| INV-NEST-009 | A style rule with nested rules is never merged or deduped | NEST#mixing | ✓ `mod.rs:1060-1061`, `:866-873` |
| INV-NEST-010 | In `@scope`, `&` is `:where(:scope)`; `<scope-start>` is not the parent | NEST#nesting-at-scope | see INV-SCO-001 |
| INV-NEST-011 | Before `CSSNestedDeclarations` (C130/F132/S18.2) engines hoisted trailing declarations; `Feature::Nesting` (C120/F117/S17.2, `compat.rs:1353`) ignores this | NEST#mixing | gap |

Conformance: lowering at print time (`style.rs:242-332`): parent block first; only `CssRule::Unknown` children
stay inside it (`:248`, #1233), all others (custom at-rules too) print after it; a prefixed rule prints its body
once per prefix (`:218-233`, EM-112). `serialize_nesting` (`selector.rs:1742-1773`) inlines one parent when `&`
leads or the parent is simple, else `:is()`, without a targets check. `NestedDeclarationsRule::minify`
(`nesting.rs:73-84`) runs the handlers, but only the `CssRule::Style` arm drains `handler_context`
(`mod.rs:822-841`): side rules are dropped or attach to the next sibling (#1023, #1049, #1246, #1381). Invisible
nested declarations need `;` before the next rule (`mod.rs:1155-1162`). `@property`/`@position-try` skip the
nested check at `parser.rs:744` (#962).

## 9. Rule-level merging, dedupe, reordering

| INV | Statement | Anchor | Master |
|---|---|---|---|
| INV-MRG-001 | Removing an earlier rule with the same selectors and (property, importance) list as a later one needs (a) same layer/scope (true per `CssRuleList`), (b) no `revert-rule`, (c) every target accepts every later value | C5#cascade-sort | ✗ (b) D6; (c) partial (INV-CAS-005) |
| INV-MRG-002 | Merging equal-declaration rules into one list needs every selector valid in every target (`is_compatible`) | C5#cascade-sort | partial: F11, F12 |
| INV-MRG-003 | Unwrapping `@media all {}` is safe at top level; in a style rule it makes nested declarations trailing parent ones (differs in C120-129): `.a{& .b{} @media all{color:red}}` → `.a{& .b{…}color:red}` | NEST#mixing | unwrapped (`media.rs:52-56`) |
| INV-MRG-004 | Re-minifying a merged list (`mod.rs:676,689,703,894,905`) is idempotent | — | ✗ #1235, EM-132 |
| INV-MRG-005 | A later same-name `@keyframes`/`@property` wins; replacing in place is fine only with no intervening conditional and a browser-valid later rule; never for `@font-face`/`@layer` | C5#layer-ordering | ✗ N2/N3 (`mod.rs:643-664`), F15 (`:968-979`) |

Code facts (`rules/mod.rs:599-1048`; walk-through in `references/architecture.md` §4):
- Pre-pass `:544-597` (#1263, master) concatenates equal adjacent conditional rules before minifying them.
- Merge partner = previous *output* rule only (#225): (A) equal selectors, both `is_compatible`, no nested
  rules, same CSS-modules source → append declarations, re-run `DeclarationBlock::minify` (`:1057-1075`); (B)
  prefix-equivalent selectors → union prefixes (`:1082-1094`, EM-101); (C) equal declarations → append selectors
  (`:1097-1104`); then merge backwards with `rules.pop()` (`:804-816`).
- Dedupe (`:864-890`): key = hash(selectors, (property id, importance)) with a per-process `ahash` seed
  (`style.rs:152-160`); values and prefixes not compared; popped indices stay in the map (N1:
  `.a{color:red}.b{color:blue}.b{color:red}.b{color:green}` → `.a,.b{color:red}`).
- Incompatible lists (`:759-793`): `:is()` wrap only with `:is()` support, no pseudo-element, equal specificities
  (`:has()` counts 0, #1324), else split; clones are built after merging drained the declarations (#1260).
  Order: base, `:dir/:lang`, `@supports` fallbacks, clones, nested-rules clone (`:822-913`).
- `DeclarationBlock::minify` (`declaration.rs:238-264`): unhandled properties are pushed at once, handled ones at
  `finalize` in fixed order (`:695-731`), inverting a shorthand and a later sub-property it does not own.

## 10. Engine divergences that affect the oracle

Harness: latest C156/F157/WK27.2; legacy-2023 C110/F108/WK16.4; legacy-2021 C97/F93/WK15.4.

| Feature | Chrome | Firefox | Safari | Harness engines with it / note |
|---|---|---|---|---|
| `@layer`, `revert-layer` | 99 | 97 | 15.4 | latest, legacy-2023, WK15.4 (C97/F93 lack it: base and head alike) |
| `revert-rule` | 148 | 150 | 27 | latest only |
| `@import supports()` | 122 | 115 | 17.5 | latest |
| `@scope` | 118 | 146 | 26.4 (26-26.4 partial) | latest; WPT `at-scope-parsing` 43/43 everywhere |
| nesting / `CSSNestedDeclarations` | 120 / 130 | 117 / 132 | 17.2 / 18.2 | latest only; no engine in the C120-129 window |
| MQ4 range / `or`, `not (…)` | 104 / 104 | 102 (63 name-first) / 64 | 16.4 / 16.4 | latest, legacy-2023, F93; C97/WK15.4 reject both (#1361) |
| `@container` size | 105 | 110 | 16 | latest, C110, WK16.4; Firefox fails `container-selection-unknown-features` 0/3 (O9) |
| name-only `@container` / style queries | 148 / 111 | 149 / 151 | 26.4 / 18 | latest; WebKit root is no style container (webkit.org/b/271040); comma lists: none |
| style range / `scroll-state()` / `anchored()` | 142 / 133 / 143 | 151 / no / no | no | Chromium (+Firefox ranges): expect O9 |
| `@supports selector()` / `font-tech()` / `at-rule()` | 83 / 108 / 148 | 69 / 106 / 157 | 14.1 / 17 / no | at-rule(): C156/F157 only |
| `@custom-media`, `@when`, `@supports-condition` | no | flag / no | no | none: output assertions only |
| `:is()` | 88 | 78 | 14 | every installed engine (legacy-2020 optional): #202 needs output assertions |

Oracle limits: L6 (800×600, screen, light) picks media branches; L7 (`@import` not followed): `import-*` probes
need output assertions.

## 11. Lowering semantics (what an exact fallback must preserve)

- **Nesting** (C120/F117/S17.2): exact only with `:is()`: one parent inlined at the leftmost position of an
  absolute selector, else `:is(parent)`; nested declarations → `parent-list {…}`; order parent, child, parent-tail.
  Below `:is()` no exact lowering exists (the maintainer keeps `:is()`, #202/#944); none for pseudo-element parents.
- **Media range** (`compat.rs:1826` C104/F63/S16.4; interval `:1871` F102): `>=`/`<=` → `min-`/`max-` exact;
  `>`/`<` → `not (max-…)`/`not (min-…)` exact but MQ4-only (#1361); intervals → `(not (max-width:A)) and (not
  (min-width:B))` (`media_query.rs:1522-1573`). MQ3-safe exact forms: `not all and (max-width:X)`,
  `(min-color:N+1)` for integers, nested `@media` for a type plus a range. No epsilons (`7f29035`, #228); negative
  bounds cannot be lowered for MQ3; parens decided at print time (#343; `needs_parens` `:1142-1156`; #1105/#1114).
- **Resolution**: dpi/dpcm → dppx; prefixed device-pixel-ratio queries added as list entries; `x` only where supported.
- **Custom media** (flag + targets): logical substitution; undefined/cyclic should give `not all`.
- **@supports**: prefixed alternatives for targets; fallbacks omitted for features an `and`/single condition guarantees.
- **Never lowered**: `@layer`, `@scope`, `@container`, `revert-layer`/`revert-rule`, `@import supports()/layer()`
  (only bundling may wrap them), `selector()`/`font-tech()`/`at-rule()`/`named-feature()`, `@when`/`@else`.

## 12. Spec changes since 2023 that LightningCSS lags

| Change (CSSWG issue) | LightningCSS |
|---|---|
| `revert-rule` keyword (10443) | ✗ D6 |
| `@import scope()`, any order of layer/scope/supports (7348) | ✗ not parsed |
| `&` = `:where(:scope)` in `@scope`; `<scope-start>` is not the nesting parent (9740) | ✗ D4, #1189 |
| Declarations directly in `@scope` (10389) | ✗ #1165 |
| Unforgiving `<scope-start>`/`<scope-end>` (10042) | ✗ D5 |
| `&div` invalid again (8662) | ✗ D9 |
| Style range syntax (8376) | ✗ #1069 |
| Comma-separated container conditions | ✗ #1210 |
| `var()` / tree-counting functions in container queries (8088, 10982) | ✗ error (#1325) |
| `@supports-condition` (12622, 12973) | ✗ blocks `@import` (D10) |

Done: nested declarations rule (`6c465c1`), name-only `@container` (9192), `scroll-state()`, raw `at-rule()`.
