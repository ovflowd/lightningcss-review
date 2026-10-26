# Spec digest: selectors (Selectors 4/5, pseudo-elements, shadow, namespaces, nesting selector side)

Areas: `selectors` (§A), `nesting` selector side (§B), `@namespace` (§C), harness notes (§D). Cascade side of nesting,
`@scope`, merging: `spec/cascade-conditional.md` §3, §8, §9. Ids: S1-S10 (spec-selectors), F1-F20
(arch-selectors-rules), EM-* (ecosystem-minifiers). Code: master `cbeaf83`. C/F/W = Chrome 156 / Firefox 157 /
WebKit 27.2; BCD 8.0.7. Probe ids without an area are `selectors/…`. ✓ master conforms, ✗ violates; every ✗ is
**verified on master** (CLI 2026-10-25/26; probe-backed ones also fail in `lcr baseline`, §D) unless UNVERIFIED.

## 0. Specs read

selectors-4 ED 2026-09-18 (WD 2026-01-22; Appendix B `-webkit-` quirks normative) · selectors-5 ED 2026-08-27 (FPWD
2026-02-17) · css-pseudo-4 ED 2026-10-15 · css-shadow-1 ED 2026-04-28 (absorbs css-scoping-1, css-shadow-parts-1) ·
css-namespaces-3 ED 2024-10-25 (REC 2014) · css-nesting-1 ED 2026-10-08 · cssom-1 ED 2026-10-13 #serialize-a-selector
(behind engines: no ` s`, lists `>>`) · HTML LS #case-sensitivity-of-selectors.

## A. selectors

### A.1 Grammar essentials

```
<complex-selector-unit>    = [ <compound-selector>? <pseudo-compound-selector>* ]!
<compound-selector>        = [ <type-selector>? <subclass-selector>* ]!      type or * first, once
<pseudo-compound-selector> = <pseudo-element-selector> <pseudo-class-selector>*
<complex-real-selector>    = no pseudo-elements          (:not(), :nth-child(of S), :is()/:where() items)
<relative-selector>        = <combinator>? <complex-selector>   (:has(), nested rules)
<attribute-selector>       = '[' <wq-name> [ <attr-matcher> [<string-token>|<ident-token>] [i|s]? ]? ']'
```

- Whitespace = descendant combinator: `.foo ::before` = `.foo *::before`. None inside a compound or after `:`/`::`.
- After a pseudo-element: logical combinations, user-action pseudo-classes and what that pseudo-element allows
  (#pseudo-element-states). Sub-pseudo-elements only where defined: `::before::marker`, `::after::marker`,
  `::first-letter::prefix/::suffix`, `::slotted(x)::<tree-abiding>`, `::column::scroll-marker`. **Element-backed**
  ones (`::details-content`, `::part()`; the ED names no others) take any pseudo-class or pseudo-element
  syntactically; structural ones, `:has()`, `:scope`, `:host*` never match there (css-pseudo-4 #element-backed).

| Pseudo | Argument | Forgiving | Specificity |
|---|---|---|---|
| `:is()` / `:where()` | `<forgiving-selector-list>`; empty = valid, matches nothing | yes | max of list / 0 |
| `:not()` | `<complex-real-selector-list>` | **no** | max |
| `:has()` | `<relative-selector-list>`; no pseudo-elements, no `:has()` (also via `:is()`) | **no** (Issue 7676) | max |
| `:nth-child()`, `:nth-last-child()` | `An+B [of S]` | **no** | (0,1,0)+max(S) |
| `:nth-of-type()` etc. | `An+B` only (`of` invalid) | – | (0,1,0) |
| `:host()`, `:host-context()` / `::slotted()` | one `<compound-selector>` | – | (0,1,0)+arg / (0,0,1)+arg |
| `:dir(<ident>)` | any ident; only `ltr`/`rtl` match | – | (0,1,0) |
| `:lang(<ident>\|<string>#)` | `*` quoted or escaped; `""` = untagged | – | (0,1,0) |
| `:state(<ident>)`, `::part(<ident>+)` | case-sensitive; all part names kept | – | (0,1,0) / (0,0,1) |
| `::highlight(<custom-ident>\|*)`, `::view-transition-*()` | `*` without class | – | **0**, else (0,0,1) |

Specificity (#specificity-rules): `*`, namespaces 0; inside `:is/:not/:has/:nth-*(of)` the max of the whole argument,
not of what matched (Issue 1027); invalid forgiving items count 0. Case (#case-sensitive, HTML
#case-sensitivity-of-selectors): syntax is case-insensitive; type/attribute names fold only against HTML elements;
classes/IDs case-sensitive outside quirks; 46 HTML attributes have case-insensitive values (`selectors/build.rs` = HTML LS).

### A.2 Invariants (anchors: drafts.csswg.org/selectors-4/ unless named)

**List validity and merging**
- **INV-SEL-001** One invalid selector invalidates the list (#grouping, #invalid): merging `A{d} B{d}` kills A wherever
  B is invalid.
- **INV-SEL-002** Validity is per engine (#invalid, #w3c-partial). ✗ no targets ⇒ `Targets::is_compatible` is true
  (`src/targets.rs:226-228`): `:has()`, `[a=b s]`, `:lang(a,b)` merge (`.x{c}.y:lang(de,fr){c}` → `.x,.y:lang(de,fr)`,
  `.x` dies in Chrome); only `Custom`, prefixed and "experimental" pseudos are protected (`src/selector.rs:1975-1994,2022`).
  Probes `rule-merging/ss-engine-specific-selectors-not-merged` (guard), `rule-merging/asr-attr-s-flag-merge` (F11).
- **INV-SEL-003** A spec-invalid selector may be accepted only if it is never merged, split or unwrapped. ✗ accepted and
  merged: `.u::before:hover`, undeclared `ns|a`, `SVG|a`, `:has(:has())`, `:has(::before)`, top-level `&div`,
  `::picker(foo)` (S2; WPT: 219 invalid accepted, 94 merge; 34 valid rejected). Probes `rule-merging/ss-no-merge-*` (5).
- **INV-SEL-004** What may follow a pseudo-element is per pseudo-element and engine (A.4). ✗ `accepts_state_pseudo_classes`
  is true for all (`src/selector.rs:1316-1319`); `is_compatible` ignores the combination.
- **INV-SEL-005** Only `:is()`/`:where()` forgive (#forgiving-selector). ✗ `:has()` (`selectors/parser.rs:2846`) and
  `of S` (`:2934`) use `IgnoreInvalidSelector`: `:has(.x, 1)` → `:has(.x)`, `:nth-child(1 of .t, 1)` → `(1 of .t)`
  revive dropped rules (F8). Probes `ss-not-argument-is-unforgiving` (guard), `asr-*-unforgiving*` (2),
  `has-pseudo-element-argument-not-emptied`.
- **INV-SEL-006** `:is(X)` → `X` only if X is valid there in every target engine (#matches). ✗ `should_unwrap_is`
  (`src/selector.rs:1731-1740`) checks one selector, no type, no combinator: `:is(:unknown),p` → `:unknown,p` (#345);
  unwrapped `::before:is(:hover)`, `:has(:is(:has(.a)))`, `::part(x):is(:first-child)` are invalid in C/F/W,
  `:is(:lang(de,fr))`, `:is([a=b s])` in Chrome. Probes `ss-is-not-unwrapped-*` (4), `issues-important-is-unwrap-forgiving-list`.
- **INV-SEL-007** An empty or emptied forgiving list is valid and matches nothing: print `:is()`, never drop the compound
  or emit `:is(`. ✓ (`.u:is(::before)` → `.u:is()` like browsers, #906).
- **INV-SEL-008** Non-functional `::-webkit-*` is valid in every engine (#compat, normative); `::-webkit-x()` and other
  vendors' unknown ones are invalid. ✓ (`Custom`, `src/selector.rs:315-320`, never merged). Probes
  `ss-unknown-*-pseudo-element-keeps-list-*` (2).
- **INV-SEL-009** With targets, splitting "repairs" lists invalid everywhere (`.t, .t::-moz-x`, #311): deliberate, never
  without targets ✓; not a regression.

**Pseudo-elements**
- **INV-SEL-010** Only the four CSS2 pseudo-elements may lose a colon (css-pseudo-4 #css2-compat). ✓
  (`src/selector.rs:1212-1215`). Probe `ss-single-colon-only-for-css2-pseudo-elements`.
- **INV-SEL-011** Whitespace before a pseudo-element is a combinator. ✓ Probe `ss-descendant-whitespace-*`.
- **INV-SEL-012** Sub-pseudo-element chains are valid exactly where defined (A.1, #sub-pseudo-elements). ✗ hard errors:
  `::before::marker` (#990), `::details-content::before` (#1244), `::slotted(details)::details-content`
  (`valid_after_slotted`, `src/selector.rs:1321-1333`); `::marker::marker` rejected ✓. Probes `issues-b1-before-marker`,
  `details-content-pseudo-element-chain`.
- **INV-SEL-013** Element-backed pseudo-elements allow every pseudo-class syntactically. ✗ `:state()`/`:dir()`/`:lang()`
  after `::part()` are hard errors (`allows_custom_functional_pseudo_classes`, `selectors/parser.rs:165-167`); structural
  ones become `Custom` with a misleading warning (#1348). Probe `ss-part-followed-by-state-pseudo-class`.
- **INV-SEL-014** `::part(<ident>+)` keeps every name (css-shadow-1 #part). ✓ (`selectors/parser.rs:3033-3046`). Probe
  `ss-part-multiple-names-and-sub-pseudo`.
- **INV-SEL-015** `:has()` holds no pseudo-elements and no `:has()` (#relational): never accept-and-merge such a
  selector or reduce it to `:has()`. ✗ `parse_has` sets no `DISALLOW_PSEUDOS` (`selectors/parser.rs:2832-2853`): top
  level keeps and merges `:has(:before)`; inside `:not()` the inherited flag drops it: `video:not(:has(::backdrop))` →
  `video:not(:has())` (#1239).
- **INV-SEL-016** Highlight UA colors apply unless `color` or `background-color` is author-set (css-pseudo-4
  #paired-defaults): `::selection{color:inherit}` is not a no-op; `::selection` ≠ `:root::selection`.
- **INV-SEL-024** `::highlight(*)` and class-less `::view-transition-*(*)` have 0 specificity. ✗ every pseudo-element
  counts (0,0,1) (`selectors/builder.rs:297-299`); `::highlight(*)` does not parse (WebKit 27.2 ships it), nor
  `::highlight(initial)` (engines accept).

**Shadow DOM**
- **INV-SEL-017** The host is featureless: `:host(.a)` ≠ `:host.a` ≠ `.a:host`; never rewrite `:host(X)` into a compound
  or descendant (css-shadow-1 #host-element-in-tree, selectors-4 #featureless).
- **INV-SEL-018** `:host()`, `:host-context()`, `::slotted()` take one compound (css-shadow-1 #host-selector,
  #slotted-pseudo). ✓ `:host()`/`::slotted()`; `:host-context()` is a raw `CustomFunction`. Probe `ss-host-argument-is-compound-only`.
- **INV-SEL-019** `:host-context()` is Chrome-only (BCD deprecated): never merge it. ✓ pass-through (typing it was
  rejected, PR #1299).

**Specificity**
- **INV-SEL-020** Specificity per A.1; `:is(#a,.b) .c` → `#a .c, .b .c` changes it. ✗ `:has()` and `&` count 0
  (`selectors/builder.rs:357-358`, `:366-368`); sole consumer: the `:is()` wrap (`src/rules/mod.rs:769`) → #1324
  (`.a, .b:has(> i){red} .c{blue}`, chrome 111 + firefox 114 → `:is(.a,.b:has(>i))`, `.a` beats `.c`). Probes
  `issues-b5-is-wrap-has-specificity`, `rule-merging/asr-is-wrap-has-specificity`.
- **INV-SEL-021** `:only-child` < `:first-child:last-child`; `:first-child` = `:nth-child(1)`. ✓ (`:nth-child(1)` →
  `:first-child`; pair kept). Probe `ss-first-last-child-not-collapsed-to-only-child`.
- **INV-SEL-022** Repeated simple selectors count again (`.a.a`, `&&`): never dedupe inside a compound. ✓
- **INV-SEL-023** Never unwrap `:where()`; unwrap `:is()` only for one-selector arguments. ✓ Probe `ss-where-not-unwrapped`.
- **INV-SEL-025** `:-webkit-any()` is (0,1,0) in C and W (`:-webkit-any(#a)` loses to `.t.t`), unforgiving and
  compound-only in Chrome; Firefox `:-moz-any()` = `:is()`. Lowering `:is()` to it is exact only for valid compound
  arguments of max specificity (0,1,0). ✗ #997: `:not(a,block)` (chrome 87) → `:not(:-webkit-any(a,block))` beats an
  earlier `.x` in current Chromium. Probe `issues-b1-webkit-any-fallback-specificity`.

**Case, escaping, serialization**
- **INV-SEL-026** Keep the case of type selectors and attribute names: F/W follow HTML LS (`svg foreignobject`,
  `svg[viewbox]` do not match), C matches anyway, so a lowercasing bug shows only in F/W (O9). ✓ Probe
  `ss-type-and-attribute-name-case-preserved-for-svg`.
- **INV-SEL-027** Ident arguments (`::highlight()`, `:state()`, `::part()`, view-transition names,
  `:active-view-transition-type()`) are case-sensitive. ✓ Probe `ss-custom-ident-pseudo-arguments-keep-case`. CSS
  modules ✗: `:state()` names are hashed (unreported, since #1133 v1.31.0, which also made `:state(initial)` an error;
  probe `css-modules/community-prs-state-pseudo-not-hashed`), `::highlight()` too (intent UNVERIFIED), `::part()` not;
  view-transition names are scoped by design (#885).
- **INV-SEL-028** `i`/`s` change matching (#attribute-case); Chrome 156 rejects `s` (WebKit 27.2 accepts; Safari
  UNVERIFIED). ✓ kept; ✗ compat maps `s` to `Feature::CaseInsensitive` (`src/selector.rs:1856-1857,1876-1877`) → F11.
  Probe `ss-attribute-case-flags-preserved`.
- **INV-SEL-029** Attribute values are ident or string tokens: unquote only valid identifiers. ✓
  (`src/selector.rs:1622-1636`: `[a="1"]`, `[a=""]` kept, `[a="-"]` → `[a=\-]`). Probe `ss-attribute-value-keeps-quotes-when-not-ident`.
- **INV-SEL-030** Escapes are part of the name (`.\31 0` keeps its space; `.md\:w-1\/2`). ✓ classes/IDs; ✗ unknown
  pseudo names are written raw (`src/selector.rs:865-875`, `:1299-1309`): invalid `.t:hover\:focus` → valid
  `.t:hover:focus` (EM-04). Probes `ss-escaped-identifiers-roundtrip`, `em-custom-pseudo-class-name-escaped`.
- **INV-SEL-031** An+B output re-parses to the same set (css-syntax-3 #serializing-anb; overflow clamps to
  2147483647 everywhere) and the function closes. ✗ `:nth-col(1)`/`:nth-last-col(1)` print `:nth-col(` (no argument,
  no `)`), which swallows every later rule in C/F/W (S1; `is_function()` false for A=0,B=1, `selectors/parser.rs:1299-1320`,
  `:2015-2021`). Probes `ss-nth-col-a0-unbalanced-output`, `ss-an-plus-b-serialization-roundtrip`.
- **INV-SEL-032** A minified selector re-parses to an equivalent one in every engine (idempotence + normalized
  `selectorText`, cssom #serialize-a-selector): of 869 WPT cases master accepts, 3 (C/F) and 6 (W) turn invalid.

**Linguistic**
- **INV-SEL-033** `:dir()` accepts any ident (#the-dir-pseudo). ✗ `Direction` is ltr|rtl (`src/selector.rs:234`,
  `:392-401`): `:dir(auto)` is a hard error. Probe `ss-dir-unknown-ident-is-valid`.
- **INV-SEL-034** `:lang()` ranges are idents or strings; `*` quoted or escaped; `:lang("")` valid (#the-lang-pseudo).
  ✗ `serialize_identifier` (`src/selector.rs:687-699`): `""` → `:lang()` (invalid, F17); `"*-Latn"` → `\*-Latn`
  (fine). Probe `asr-lang-empty-string`.
- **INV-SEL-035** `:lang(a, b)` → `:is(:lang(a), :lang(b))` is exact and needed for Chrome (no lists, strings,
  wildcards; Firefox ≥114, Safari ≥9 have them). ✓ lowered wherever `LangSelectorList` is unsupported: every Chrome
  and Firefox (`compat.rs`: Safari ≥10.1 only; safe for Firefox). Probe `ss-lang-list-lowered-for-chrome`.
- **INV-SEL-036** `:dir()` → `:lang(<19 RTL languages>)` (`downlevel_dir`, `src/selector.rs:2206-2224`) is a
  documented heuristic (`website/pages/transpilation.md`), never equivalent, and raises logical-fallback specificity
  (#1018, F20, `src/context.rs:94`). No probe may expect `equivalent`.

**Prefixed selectors**
- **INV-SEL-045** One rule per prefix; merging prefix-equivalent rules prints each prefix's own spelling. ✗
  `merge_style_rules` ORs prefixes into the earlier rule (`src/rules/mod.rs:1082-1093`) and the printer writes
  `(dest.vendor_prefix & own).or_none()` (`src/selector.rs:767-780`, `:1187-1198`): `.t::selection{x}.t::-moz-selection{x}`
  → `.t::selection{x}` twice (not idempotent, EM-101); `::-webkit-input-placeholder` + `::-moz-placeholder` with
  `firefox 40` → `::placeholder` (absent before Firefox 51, S6). Probes `em-prefixed-pseudo-merge-keeps-prefix`,
  `prefixing-compat/ss-merged-prefixed-rules-keep-each-prefix`.
- **INV-SEL-046** Prefixed spellings are not interchangeable: `:-moz-placeholder` (pseudo-class, Firefox 4–18) ≠
  `::-moz-placeholder` (19–50); `:-ms-input-placeholder` (IE 10–11) ≠ `::-ms-input-placeholder` (Edge 12–18);
  `:-webkit-full-screen`/`:-moz-full-screen` vs `:-ms-fullscreen`. ✗ `::-ms-input-placeholder` is stored as Moz, prints
  `::-moz-placeholder` (`src/selector.rs:291`, PR #1281); `:-moz-placeholder`/`:-ms-input-placeholder` parse as
  `PlaceholderShown` (`:168-169`, #929) and print nonexistent `:-*-placeholder-shown` (`:813`) even without targets; a
  list of them with targets (chrome 111) also gets a live `:is(a:placeholder-shown,…)` (#1351, 1.29.3; PR #1352).
  Probes `*placeholder*` (7).
- **INV-SEL-047** `:-webkit-any()`/`:-moz-any()` copies come before the unprefixed rule, which stays last ✓; never
  replace it (INV-SEL-025). Without targets an authored `:-webkit-any()` round-trips: ✗ `.a:not(:-webkit-any(.b,.c))` →
  `.a:not(:is(.b,.c))` (minify; `get_prefix` `:2075-2106`, `Any` printing `:1671-1679`, f782754); with targets bare `-any` copies are
  dropped (#1211). Probe `prefixed-any-inside-not-preserved-without-targets`.

**Tree-structural and scoping**
- **INV-SEL-048** `:nth-child(An+B of S)` ≠ `S:nth-child(An+B)`; no exact fallback for C < 111, F < 113. ✓ never
  lowered. `:nth-child(2of.x)` is a `<dimension-token>`, stays invalid (#1273). Probes
  `ss-nth-child-of-not-lowered-to-compound`, `issues-b5-nth-child-of-requires-whitespace`.
- **INV-SEL-049** `:root` ≠ `html` ((0,1,0) vs (0,0,1)); `:scope` ≠ `:root` inside `@scope`; `:empty` ≠ `:blank`:
  never swap them (#the-root-pseudo, #the-scope-pseudo).
- **INV-SEL-050** An explicit `:scope` inside `:has()`/`:nth-child(of)` is the outer scoping root, not the anchor (ED
  dropped "absolutize"; WPT `css/selectors/has-argument-with-explicit-scope.html`). ✗ a leading `:scope` compound is
  stripped in relative lists (`src/selector.rs:1464-1471`, comment: `:has(:scope > foo)` → `:has(> foo)`; explicit and
  implicit `:scope` are stored alike; `:has()` `:1688`, `of S` `:1721`): `.u:has(:scope)` → `.u:has()` (invalid,
  kills a merged `.t`); `.a:has(:scope .b)` → `:has( .b)` and `.c:nth-child(1 of :scope.c)` → `(1 of .c)` start
  matching in C/F/W (`:has(:scope > .b)` → `:has(>.b)` too; engines UNVERIFIED). Probe `asr-has-scope-only-argument` (F7).

### A.3 Conformance (typed = own variant; pass = `Custom`/`CustomFunction` raw tokens, warning, never merged)

| Item | Status | Where | Not covered above |
|---|---|---|---|
| combinators | typed | `src/selector.rs:1402-1420` | minify drops spaces around `>+~` (`u+a` fine today, #289); `\|\|`, `/ref/` missing (no engine); `>>>`, `/deep/` gated (`DEEP_SELECTOR_COMBINATOR`), counted compatible |
| `:not()` | typed, unforgiving ✓ | `parse_negation` `:2664-2688` | compat = `Selectors3` + inner; `NotSelectorList` unused: `.y{x}.x:not(.a .b){x}` merges for chrome 80 (F12) |
| `:open`, `:modal`, `:popover-open`, `:defined`, `:user-valid`, media states, `:current`, `:blank` | typed | `src/selector.rs:105-191` | `is_compatible` false (`:1975-1994`): never merged; any targets split their lists; `:closed` is in no spec |
| `:target-current/-before/-after` | gated | `:154-156` | pass when `SCROLL_NAVIGATION_CONTROLS` is off ✓ (#1185) |
| `:heading()`, `:has-slotted`, `:host-context()`, `:interest-*`, `:unchecked`, `:matches()` (W only) | pass | `:208-213`, `:246-256` | warning unless the name starts with `-` |
| `:-webkit-any()`/`:-moz-any()` | typed `Any` | `parse_any_prefix` `:262-268` | parsed forgiving (`:-webkit-any(.a, ::before)` → `:-webkit-any(.a)`, invalid in Chrome); specificity = `:is()` (S10) |
| `::details-content`, `::search-text`, `::picker()`, `::picker-icon`, `::checkmark`, `::highlight()` | partial | `:281-313`, `:335-336` | trailing pseudos rejected (#1244, #1303; #1292: maintainer says not in spec); `::picker()` takes any ident |
| `::view-transition*` | typed | `:310`, `:337-340`, `:1117-1160` | `:hover` after them accepted and merged; `-group-children()` pass |
| `::-webkit-scrollbar*` | typed | `:299-305`, `:652-662` | `::selection:window-inactive` rejected (C/W accept) |
| unknown `::x` / `::-webkit-x` | pass | `:315-320`, `:341-348` | sets `AFTER_UNKNOWN_PSEUDO_ELEMENT` (`selectors/parser.rs:2783`): anything may follow, so making a pseudo-element known tightens validation (#1303 class) |
| visitor round-trip | partial | `selectors/serialization.rs:700`, `selectors/parser.rs:996` | rebuilt with `build(false,false,false)`: `has_pseudo_element()` false afterwards (F13, #1079) |

### A.4 Engine divergences that affect the oracle (validity via `insertRule`; ✓ valid, ✗ invalid)

| Selector | C | F | W | Master (no targets) |
|---|---|---|---|---|
| `:dir(auto)`, `::part(x):state(s)`, `::details-content::before`, `::slotted(details)::details-content` | ✓ | ✓ | ✓ | **error** |
| `::before::marker` / `::details-content:open` | ✓ | ✓ | ✗ | error |
| `::search-text:current`, `::picker(select):popover-open` | ✓ | ✗ | ✗ | error |
| `:lang(de, fr)`, `:lang("x")`, `[a=b s]` | ✗ | ✓ | ✓ | kept, merges |
| `::placeholder:hover` | ✗ | ✓ | ✓ | accepted |
| `:hover` after `::before`, `::marker`, `::selection`, `::highlight(x)`, `::view-transition-group(*)` | ✗ | ✗ | ✗ | accepted **and merged** |
| `::slotted(:has(.a))`, `:host(:has(.a))` | ✗ | ✓ | ✓ | accepted |
| `:nth-child(2 of .a, ::before)` | ✓ (!) | ✗ | ✗ | `:nth-child(2 of .a)` |
| `:host-context()` / `:has-slotted` / `:heading`, `::highlight(*)` | C only | F only | W only | pass / pass / pass, error |
| `&div` | ✗ | ✗ | ✗ | accepted |
| `:-webkit-any(.a)` / `(.a .b)` | ✓ / ✗ | ✗ | ✓ / ✓ | typed |
| `::-moz-placeholder`, `::-moz-selection`, `:-moz-full-screen` / `:-webkit-full-screen` | ✗ / ✓ | ✓ / ✗ | ✗ / ✓ | |
| `:-moz-placeholder`, `:-ms-input-placeholder`, `::-ms-input-placeholder` | ✗ | ✗ | ✗ | rewritten (INV-SEL-046) |

Measured in all three: top-level `& .t{red} .t{blue}` → blue, `:scope .t{red} .t{blue}` → red; `#a, b { & .t{red} }
.x .t{blue}` → red (`&` = (1,0,0)). Engine splits (`[s]`, `:lang()` lists, SVG name case) land in O9: decide with
this table.

### A.5 Lowering semantics (what an exact fallback must preserve)

| Feature | Master (`src/selector.rs` unless named) | Exact? | Must preserve / unavoidable approximation |
|---|---|---|---|
| `:is(a,b)` → `:-webkit-any()` + `:-moz-any()` + original | `downlevel_component` `:2152-2166`; only if no argument has a combinator | partial | `-any` is (0,1,0), unforgiving, compound-only (Chrome); unprefixed copy last. With combinators only `:is()` is emitted (#312) |
| `:not(a,b)` → `:not(:is(a,b))` | `:2168-2186` | yes | never `:not(a):not(b)` (sum ≠ max, ff4de2a); old Chrome gets `:not(:-webkit-any())` (#997) |
| `:lang(a,b)` → `:is(:lang(a),:lang(b))` | `:2138-2147` | lists only | extended filtering, wildcards, strings: no fallback |
| `:dir()` → `:lang(<RTL list>)` / `:not(…)` | `:2206-2224` | **no** | heuristic by design; raises specificity |
| incompatible selector in a list | `src/rules/mod.rs:759-793`: a clone per incompatible selector, or `:is(list)` (needs `:is()`, no pseudo-element, equal specificity) | if guards hold | #1324, #1032, #1079; Firefox 78–81: `IsSelector` true (`src/compat.rs:795-799`), `:is()` unforgiving per BCD (UNVERIFIED) |
| prefixed pseudos | one rule per prefix (`src/rules/style.rs:213-239`) | if spellings are right | legacy pseudo-class vs pseudo-element forms have no exact rewrite (INV-SEL-045/046) |
| `:where()`, `:has()`, `:nth-child(of)`, `[s]`, `::part()`, `:host*`, `::slotted()`, `:state()`, highlights | none | – | leave the rule alone and never merge it; `:where()` is kept without a warning (#963: maintainer agreed to add one) |

Target modes (browser-compat F9): no targets keeps authored prefixes, never splits; `targets: {}` (Vite `esnext`) strips
them and splits prefixed lists; excluding one `Features.Selectors` bit disables all selector splitting and prefixing
(`should_compile_selectors`, `src/targets.rs:238-241`, #1375). Probes cannot set `{}` or `exclude`: use the PR's tests.

### A.6 Spec changes since 2023 that LightningCSS lags

| Change (CSSWG issue) | Master |
|---|---|
| `:has()`/`:nth-child(of)` unforgiving, `:has()` not nestable, no pseudo-elements (7676, 7344, 7463); relative selectors anchored | not followed (INV-SEL-005/015/050); open PR #1309 makes those `:has()` inputs hard errors |
| element-backed pseudo-elements (10199, 10083), `::details-content` (10379), `::search-text:current` (10212, 10298), `::highlight(*)` (6755), `::picker()` | typed (#930, #1213, #970, #957); trailing pseudos rejected (open PRs #1304, #1307, #1308); no `*` |
| BCP 47 ranges, `:lang("")` (13646, 8720, 3022); `:dir(<any ident>)` | `""` printing broken; ltr/rtl only |
| Selectors 5 FPWD (2026-02-17): `:state()`, `:heading()`, `.prefix-*`; `:target-within` removed (selectors-4 note) | `:state()` typed (#1133); rest pass/missing; `:target-within` typed, never merged |

## B. nesting: selector side (cascade side: `spec/cascade-conditional.md` §8)

Nested preludes are `<relative-selector-list>`; `&` ≡ `:is(<parent list>)`; CSSOM absolutizes (`> .foo` → `& > .foo`)
(css-nesting-1 #syntax, #nest-selector).

- **INV-SEL-041** `&` has the parent list's max specificity and cannot represent pseudo-elements; single-parent
  substitution is exact; top-level `&` and `&` in an `@scope` body are `:where(:scope)` (#nesting-at-scope). ✗ both
  lower to `:scope` (`src/selector.rs:1765-1771`): `& .t{red} .t{blue}` → `:scope .t{red}.t{blue}` (red wins; native
  blue; S7 = INV-NEST-006; `@scope`: #1189). Probes `nesting/ss-top-level-amp-zero-specificity-lowered`,
  `cascade-layers-scope/asr-scope-nesting-selector-specificity`.
- **INV-SEL-042** `&div` is invalid in C/F/W: never accept-and-merge it or "fix" it into `div.a`. ✗ `&` is accepted before a
  type selector (`selectors/parser.rs:2709-2713`); top-level `&div` merges (`.t,&div`); the `&div` → `div&` swap only
  runs for the first compound (`src/selector.rs:1478`, `:1547-1560`), so `.foo{> &a{}}` → `.foo>.fooa` (#489, EM-110).
  Probes `rule-merging/ss-no-merge-top-level-amp-before-type`, `nesting/nesting-selector-before-type-selector-is-invalid`,
  `nesting/em-relative-amp-*`.
- **INV-SEL-043** "Contains the nesting selector" = an `&` anywhere, incl. `:nth-child(of)` and raw unknown pseudo-class
  arguments (#contain-the-nesting-selector). ✗ `AFTER_NESTING` is not propagated out of `parse_nth_pseudo_class` (state by
  value, `selectors/parser.rs:2898`) or raw tokens: `.a{:nth-child(2 of &){}}` → `& :nth-child(2 of &)` (F9). Probe
  `nesting/asr-nth-child-of-ampersand-not-relative`.
- **INV-SEL-044** Relative nested selectors carry the implied `&` specificity; nested declarations keep the parent's
  elements, pseudo-elements and specificity (INV-NEST-001…011).

`serialize_nesting` (`src/selector.rs:1742-1773`): one parent and (`&` first, or parent simple without type) → inline,
else `:is(parent)` **even for targets without `:is()`** (`.a,.b{&:hover{}}` chrome 80 → `:is(.a,.b):hover`; #202, #944,
#1159; no exact lowering exists). Also ✗: `.a::before{&:hover{}}` → `.a:before:hover` matches (#982/#352; PR #1156 has
the premise backwards); `.p .q{.a:has(+ &){}}` → `.a:has(+.p .q)` (#1073); `:host(&){.b{}}` overflows the stack
(EM-111, `:1702-1714` print the argument with `selector.to_css(dest)`); `:fullscreen{:fullscreen{:fullscreen{}}}`
(safari 8) prints 8 rules, 477 B, a second pass 2 (once per ancestor prefix pass, EM-112); nested lists grow
exponentially (EM-113).

## C. `@namespace` (at-rules-other, bundler)

`@namespace <prefix>? [<string> | <url>];` after `@charset`/`@import`, before the rest (else ignored); prefixes are
case-sensitive and scoped to their sheet; the last redeclaration wins; the default namespace never applies to attributes
(css-namespaces-3 #syntax, #scope, #prefixes; selectors-4 #type-nmsp).

- **INV-SEL-037** An undeclared prefix invalidates the selector (and list); prefixes are case-sensitive. ✗
  `namespace_for_prefix` returns `Some(prefix)` for anything (`src/selector.rs:378-380`): `.t{x} ns|div{x}` →
  `.t,ns|div{x}`. Probes `rule-merging/ss-no-merge-undeclared-namespace-prefix`, `rule-merging/ss-no-merge-namespace-prefix-wrong-case`.
- **INV-SEL-038** The default namespace skips the subject compound inside `:is()/:where()/:not()/:has()` unless it has an
  explicit `*` or type selector (#matches, #negation): `:not(*.a)` ≠ `:not(.a)`. ✗ `default_namespace()` is `None`
  (`src/selector.rs:374-376`) and `*` is elided (`:1492-1498`, `:1573`): `svg|rect:not(*.a)` → `svg|rect:not(.a)` (S5,
  matching changes in C/F/W). Probe `ss-default-namespace-explicit-universal-in-not`.
- **INV-SEL-039** Bundling must not hoist an imported sheet's `@namespace` over the importer; error recovery must not merge
  selectors whose prefix became undeclared. ✗ `@import "d.css"; .a{}` (d.css: `@namespace url(svg)`) bundles to
  `@namespace "…svg";rect{…}.a{…}`: `.a` now matches only SVG (S8, C/F/W; multi-file, no probe).
- **INV-SEL-040** Prefix → URL is per sheet, so comparing selectors by prefix text is sound only inside one sheet. ✗ two
  sheets binding `svg` to different URLs bundle into one `svg|rect{…}`. `[|a]` ≡ `[a]`; `*|*` ≡ `*` only without default.

## D. Harness notes (`lcr baseline`, master `cbeaf83`, 2026-10-25)

- Every probe cited with ✗ fails in the baseline except four that expect only `equivalent` against a master parse error
  (`ss-dir-unknown-ident-is-valid`, `ss-part-followed-by-state-pseudo-class`, `details-content-pseudo-element-chain`,
  `search-text-current-pseudo-class`): `stage: parse`, no failing assertion; a PR that newly accepts or rejects such
  input is `unverified`. Judge the pair with `lcr show`.
- `idempotent` is not evaluated by `lcr baseline`: EM-112 passes there, yet the CLI reproduces it.
- `different` by design (`still-different`): `ss-lang-list-lowered-for-chrome` (Chromium rejects the input),
  `ss-nth-child-of-not-lowered-to-compound` in legacy-2023 (Chromium 110 lacks `of`), `logical/asr-dir-fallback-specificity`.
- Oracle limits: shadow DOM (L1, no `shadowRoot` walk), `:hover` family (L2), CSS modules (L8); selectors with `&` are
  not validity-probed (`oracle/dom.mjs:461`); no selector WPT lane (O7 = values).
- B7 is red on master since 37c4f4d (#930): `test_parsing` asserts `parse("foo::details-content").is_ok()`
  (`selectors/parser.rs:3933`), but the test `DummyParser` knows only `::before`/`::after` (`:3375-3386`). The panic
  hides every later assertion there; B7 is PARTIAL (pre-existing) on every PR.
- Research disagreements: arch-selectors-rules §2.2 (`&div` legal) is outdated (Issue 8662); its §2.4 (`:has(:scope >
  .a)` = `:has(>.a)`) contradicts the ED and WPT (INV-SEL-050); its UNVERIFIED `:-webkit-any()` (0,1,0) is measured in
  C/W. #1324 reproduces (issues-b5, F10, CLI) although issues-important could not.
