# Spec digest: selectors

Anchors: `https://drafts.csswg.org/<spec>/#<anchor>`. C/F/W = current Chrome/Firefox/WebKit.
"Code:" = current behavior a PR may touch; judge the PR's change, not these.

## Validity and lists

- One invalid selector invalidates its list (selectors-4#invalid). Validity is per engine, so merging
  `A{d} B{d}` kills A wherever B is invalid. Code: with no targets `is_compatible` is true for every
  typed component; only `Custom`, prefixed, experimental and unlisted pseudos (`return false`) are kept apart,
  and those split lists for any targets. Splitting `.t, .t::-moz-x` revives `.t`: by design.
- Only `:is()`/`:where()` forgive (#forgiving-selector). `:not()`, `:has()`, `:nth-child(of S)` are
  unforgiving: one bad item kills the selector. An emptied forgiving list is valid and matches nothing:
  print `:is()`, never drop the compound. Code: `:has()` and `of S` parse with `IgnoreInvalidSelector`,
  dropping bad items, which revives rules browsers drop.
- `:has()` takes no pseudo-elements and no `:has()`, also through `:is()` (#relational).
- Unknown non-functional `::-webkit-*` is valid everywhere (#compat); other vendors' are not.

## Pseudo-elements (css-pseudo-4)

- One colon only for `before`, `after`, `first-line`, `first-letter` (#css2-compat). Whitespace before a
  pseudo-element is a descendant combinator: `.a ::before` = `.a *::before`.
- After a pseudo-element: user-action pseudo-classes, logical combinations and what that pseudo-element
  defines (#pseudo-element-states). Sub-pseudo-elements only where defined: `::before::marker`,
  `::after::marker`, `::first-letter::prefix/::suffix`, `::slotted(x)::<tree-abiding>`. Element-backed
  ones (`::details-content`, `::part()`) take anything syntactically (#element-backed).
- Code: after an unknown pseudo-element anything may follow (`AFTER_UNKNOWN_PSEUDO_ELEMENT`); a
  known one applies `SelectorParsingState`, so making a pseudo known turns accepted input into errors.
  `accepts_state_pseudo_classes` is true for every pseudo-element: `::before:hover` is accepted and merged though C/F/W reject it.

## Specificity (selectors-4#specificity-rules)

- `:is`/`:not`/`:has` = max of the whole argument, not of what matched; `:nth-child(of S)` = (0,1,0) +
  max(S); `:where()`, `*`, namespaces = 0; `&` = max of the parent list (css-nesting-1#nest-selector);
  `:host(X)` (0,1,0)+X, `::slotted(X)` (0,0,1)+X; `::highlight(*)` 0.
- Repeats count (`.a.a`); `:first-child:last-child` (0,2,0) ≠ `:only-child`; `:root` ≠ `html`.
- Code: `selectors/builder.rs` `specificity` counts `:has()` and `&` as 0, which the `:is()`-wrap guard
  in `src/rules/mod.rs` trusts. Visitor/serde round trips lose the pseudo-element flag.

## Arguments, case, serialization

- `:dir(<ident>)`: any ident parses, only `ltr`/`rtl` match (code: ltr|rtl only). `:lang()` takes idents
  or strings, `""` = untagged (code prints `:lang()`, invalid). `*` must be quoted or escaped.
- Case-sensitive: `:state()`, `::part()` names (all kept), `::highlight()`, view-transition names,
  classes/IDs outside quirks. Type selectors and attribute names fold only against HTML elements
  (HTML#case-sensitivity-of-selectors): F/W do not match `svg foreignobject`, C does, so a lowercasing bug
  shows only in F/W.
- `i`/`s` attribute flags change matching; unquote an attribute value only if it is a valid ident.
- Escapes are part of the name. Code writes unknown pseudo names raw:
  `.t:hover\:focus` (invalid) → `.t:hover:focus` (valid).
- An+B output must re-parse to the same set and close its function (css-syntax-3#serializing-anb).
- An explicit `:scope` in `:has()`/`of S` is the outer scoping root, not the anchor; code strips a
  leading `:scope` compound there (`.u:has(:scope)` → `.u:has()`).
- `:nth-child(An+B of S)` ≠ `S:nth-child(An+B)`. `:nth-child(2of.x)` tokenizes as a dimension: invalid.
- `:host()`, `::slotted()` take one compound; `:host(.a)` ≠ `:host.a` (css-shadow-1#host-selector).

## Namespaces (css-namespaces-3)

- An undeclared prefix invalidates the selector; prefixes are case-sensitive and per sheet (#scope).
  Code: `namespace_for_prefix` accepts any prefix, so `ns|div` merges into a list.
- The default namespace applies to the subject compound inside `:is/:where/:not/:has` only with an
  explicit `*` or type (selectors-4#matches): `:not(*.a)` ≠ `:not(.a)`; code elides that `*`.
- Bundling must not hoist an imported sheet's `@namespace` over the importer.

## Nesting, selector side

- `&` ≡ `:is(<parent list>)`; inlining one parent is exact only leftmost in an absolute selector (code also
  inlines `.p .q{.a:has(+ &){}}` → `.a:has(+.p .q)`). `&` cannot represent pseudo-elements:
  `.a::before{&:hover{}}` matches nothing natively. Top-level `&` and `&` in an `@scope` body are
  `:where(:scope)`, zero specificity (css-nesting-1#nesting-at-scope); code lowers them to `:scope`.
- `&div` is invalid in C/F/W; code accepts and merges it, and swaps `&a` only in the first compound, so
  `.foo{> &a{}}` → `.foo>.fooa`.
- `&` inside `:nth-child(of)` or raw arguments counts as containing `&`; code adds an implicit `& `.
- `serialize_nesting` emits `:is(parent)` even for targets without `:is()`: no exact lowering exists.

## Engine divergences (decide O9 with this; validity via `insertRule`)

| Selector | C | F | W |
|---|---|---|---|
| `:lang(de, fr)`, `:lang("x")`, `[a=b s]` | ✗ | ✓ | ✓ |
| `::before::marker`, `::details-content:open` | ✓ | ✓ | ✗ |
| `::search-text:current`, `::picker(select):popover-open` | ✓ | ✗ | ✗ |
| `::slotted(:has(.a))`, `:host(:has(.a))` | ✗ | ✓ | ✓ |
| `:nth-child(2 of .a, ::before)` | ✓ | ✗ | ✗ |
| `:host-context()` / `:has-slotted` / `:heading()` | C only | F only | W only |
| `:-webkit-any(.a)` / `:-webkit-any(.a .b)` | ✓ / ✗ | ✗ | ✓ / ✓ |
| `:dir(auto)`, `::part(x):state(s)`, `::details-content::before` | ✓ | ✓ | ✓ |
| `&div`, `:hover` after `::before`/`::marker`/`::selection` | ✗ | ✗ | ✗ |

## Lowering: what is exact

- `:not(a,b)` → `:not(:is(a,b))` exact; `:not(a):not(b)` sums specificity (wrong).
- `:is()` → `:-webkit-any()`/`:-moz-any()` copies + unprefixed rule last. `:-webkit-any()` is (0,1,0) in
  C and W, so the copy competes in current engines; unforgiving and compound-only
  in Chrome. Exact only for compound arguments of max (0,1,0). Authored `-any` round-trips without targets.
- `:lang(a,b)` → `:is(:lang(a),:lang(b))` exact, needed for Chrome. Strings, wildcards: no fallback.
- `:dir()` → `:lang(<RTL languages>)`: a documented heuristic, never equivalent, raises specificity.
- Incompatible selector in a list: one clone each, or `:is(list)` only if `:is()` is supported, no
  member has a pseudo-element (also behind `:global()`) and all have equal specificity.
- Prefixed pseudos: one rule per prefix. `:-moz-placeholder` ≠ `::-moz-placeholder`,
  `:-ms-input-placeholder` ≠ `::-ms-input-placeholder`; none yields an unprefixed copy. Code:
  `merge_style_rules` ORs prefixes, so merged `::selection` + `::-moz-selection` prints `::selection` twice.
- No fallback exists for `:where()`, `:has()`, `:nth-child(of)`, `[s]`, `::part()`, `:host*`,
  `::slotted()`, `:state()`: leave the rule alone and never merge it.
- Targets: none keeps authored prefixes and never splits; `targets: {}` strips them and splits prefixed
  lists; excluding one selector Feature disables all selector lowering (`should_compile_selectors`).
  Probes cannot set `{}`, `include` or `exclude`: use the PR's tests.

## Harness limits

- The oracle sees no shadow trees, skips CSS modules, does not validity-probe `&` selectors; no
  selector WPT lane: read `css/selectors/parsing/*`, `css/css-pseudo/parsing/*` by hand.
- A probe whose input base rejects at parse gives `unverified`: judge the pair with `lcr show`.
- B7 can be red on base (test `DummyParser` knows only `::before`/`::after`): compare failing test names.
