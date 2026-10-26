# Lightning CSS architecture for reviewers

How a change reaches output and what else it moves. Pointers are file + function in the base tree;
probe ids are under `corpus/probes/`.

## Pipeline

```
StyleSheet::parse_with -> Top/NestedRuleParser (src/parser.rs)
  -> Property::parse: typed, else Property::Unparsed (raw tokens, never an error)
[JS visitor: unmerged rules, unlowered nesting/media, @custom-media]
StyleSheet::minify: ONE DeclarationHandler pair + PropertyHandlerContext per sheet;
  @custom-media resolved first; CssRuleList::minify (recursive)
StyleSheet::to_css(PrinterOptions) -> CssRuleList::to_css
```

napi and the CLI always call `minify()`; JS `minify:false` only changes whitespace and `dest.minify`
shortcuts. Pure parse+print is Rust-only (`mode: print`) and already canonicalizes typed values
(shortest color, reduced `calc()`, collapsed rect shorthands, `:is(.a)` to `.a`), so a `Parse`/`ToCss`
change shows in every mode.

## Minify time vs print time

- **Minify** (`MinifyOptions.targets`): handlers (shorthand collapse, dedupe, fallbacks, prefixes,
  logical lowering, `@supports`/dark side rules), rule merge/dedupe/split, selector downlevel
  decision (`vendor_prefix`), at-rule prefixes, custom media, layers, unused symbols, empty rules.
- **Print** (`PrinterOptions.targets`, narrowed by `@supports` scope): nesting, media range syntax,
  `#rrggbbaa`, `light-dark()` to `var()` pairs, token-list colors, `clamp()`, double-position stops,
  `x`/`dppx`, prefixed rule copies and `:-webkit-any()`, module names, `composes`. `@container`
  conditions are never lowered.
- Work split across both (light-dark vars, prefixed copies) breaks if only one side gets targets.
- `Targets::is_compatible` is true without browsers, so hand-written fallbacks collapse without
  targets (by design). `should_compile` = in `include`, or not in `exclude` and not compatible;
  `should_compile!` needs the same variant name in `compat::Feature` and `targets::Features`.
  Excluding any selector feature disables all selector splitting. No compat data = incompatible.
  Surviving duplicate declarations are decided from `targets.browsers` only.
- Inside `@supports`, the condition's features join `exclude` (`TargetsWithSupportsScope`); not
  under `not`/`or`.

## Declarations: order, buffering, flush

`DeclarationBlock::minify` runs `!important` and normal declarations through separate handlers into
separate vectors; normal prints first. `DeclarationHandler::handle_property` tries handlers in fixed
order (first claimant wins). Output of one importance group:

1. Immediate, in input order: unowned properties (opacity, SVG, every unknown...), their Unparsed
   values, index-handler output (fallback, prefix, color-scheme), custom properties (later value takes
   the first slot), mid-block flushes.
2. `direction`, `unicode-bidi`.
3. Buffered handlers in finalize order: background, border, outline, flex, grid, align/gap, size,
   margin, padding, scroll-*, font, text, list-style, transition, animation, display, position,
   inset, overflow, transform, box-shadow, mask, container. `all` drops what precedes it except
   custom properties, `direction`, `unicode-bidi`.

A buffered handler must flush before: an Unparsed (`var()`) member; a target-incompatible value
replacing a compatible one (the old one stays as fallback); a prefix or logical/physical change.
Index handlers overwrite in place: `a; var(--x); b` becomes `b; var(--x)`. Reorder classes:

- **Owned shorthand, unowned longhand**: `font; font-feature-settings` inverts (`rule-merging/font-reset-only-subproperties-stay-after-font`,
  `overflow-inline-after-overflow`, `transition-behavior-reordered`). Moving a property into or out
  of a handler, or making it typed, moves it between groups.
- **In-place overwrite** (`rule-merging/prefix-handler-in-place-update-reorders-unparsed`).
- **Invalid typed value wins** over a valid earlier one (`rule-merging/invalid-color-replaces-valid`).

## Rule lists (`CssRuleList::minify`)

`coalesce_adjacent_conditional_rules` first joins adjacent equal `@media`/`@supports`/`@container`.
Then per rule:

- `@keyframes`, `@property`: same name replaces the earlier one at the earlier position (it can jump
  an intervening `@media` copy; old `@supports` fallbacks stay).
- Conditional groups merge into the previous output rule if equal (then re-minified); dropped if
  empty or never matching.
- `@layer` blocks merge into the same-name block; the post-pass runs only when a named layer exists,
  so anonymous layer contents are not minified or lowered otherwise.
- Style rule: (1) `StyleRule::minify`, nested rules under a child context. (2) Split if >1 selector
  and incompatible: `:is(list)` if supported, no pseudo-element and equal specificities, else clone
  incompatible selectors. (3) `update_prefix`. (4) `merge_style_rules` with the previous output rule,
  cascading backwards: same selectors (both compatible, no nested rules, same module file) append
  and re-minify; same declarations union prefixes or selectors. (5) Drain side rules, `reset()`.
  (6) Dedupe: an earlier rule with equal selectors and (property, importance) sequence becomes
  `Ignored`; values are not compared. (7) Emit base, `:dir`/dark rules, `@supports` fallbacks,
  clones, nested-rules clone.

Invariants:
1. Importance is structural; nothing moves a declaration across lists or creates one without
   deciding its importance (side entries added in `finalize` see a stale `context.is_important`).
2. Only the previous output rule merges (except keyframes, `@property`, layers, dedupe).
3. Indices are stable within a pass (`Ignored`); a pop or in-place merge must update the dedupe
   key (the base does not).
4. One handler pair per sheet; `finalize` resets (not prefix indices); only the style-rule arm drains side lists.
5. Merged selector lists are valid in every target; unknown or prefixed pseudos never merge.
6. Output is deterministic, idempotent and re-parses.
7. Prefixed copies precede the unprefixed one; `derive(Parse)` variant order is parse priority.
8. Unparsed is opaque: it flushes the handler, earlier declarations stay as fallbacks for targets
   that reject it, and where it parses it wins (IACVT).

## Side rules (`src/context.rs`)

- Logical (`should_compile_logical`, off in style attributes): block axis renamed in place (ignores
  `writing-mode`); inline axis via `add_logical_rule` and `get_additional_rules` as `:dir()` rules,
  lowered to `:lang(<rtl langs>)`/`:not(...)`. Heuristic: +(0,1,0) specificity, `!important` lost,
  later physical declarations lose, `dir=rtl` without RTL `lang` gets LTR values.
- `add_conditional_property`: `@supports (color: lab(0% 0 0))`-style copies (style rules only).
- `light-dark()`: `--lightningcss-light/dark` vars plus a dark `@media` rule; needs `color-scheme`
  on an ancestor; `color-scheme: ... !important` leaves the dark rule normal.
- Leaks: `NestedDeclarationsRule::minify` and keyframes fill side lists but never drain them, so they
  land on the next sibling or vanish (`nesting/nested-declarations-side-rules-leak-to-sibling`). All
  selectors incompatible yields side rules with an empty selector. Style attributes drop side rules
  (the WPT lane cannot see these).
- `serialize_nesting` prints the plain parent only for one parent with leading `&` or a simple
  type-free parent, else `:is(parents)`, even for targets without `:is()`. `&` cannot represent a
  pseudo-element parent.

## Change impact

| Unit | Affects | Test with |
|---|---|---|
| handler order, `DeclarationBlock::minify` | every declaration's order/survival | `reverse-decls`, `important`, `var-before/after` |
| one handler, shorthand macros | its group, longhands it resets, merges | `reverse-decls`, `var-after`, `prefixed-sibling`, `retarget-*` |
| derive `Parse`/`ToCss`, `define_properties!` | parse priority, Unparsed fallback, AST | `upper-props`, `shorthand; new-longhand` both orders |
| `PropertyHandlerContext` | side rules, importance | `important`, `wrap-supports`, `nest`; `logical/*` |
| `CssRuleList::minify`, merge, dedupe | cascade across rules | `duplicate-nonadjacent`, `wrap-*`, `nest`; `rule-merging/*` |
| `StyleRule::to_css`, nesting | print nesting, copies, leaks | `nest` x `retarget-none`/`engine-legacy-2023`; `nesting/*` |
| selectors (compat, downlevel, print) | merging, `:is()`, `:dir`, recovery | `retarget-*`, `engine-legacy-*`; `selectors/*` |
| media/supports | conditions, negation, operand prefixes | `wrap-media`, `wrap-supports`, print + minify |
| targets, compat, prefixes | every lowering and merge decision | `retarget-*`, `engine-legacy-*` |
| printer, numbers | whitespace, maps, numbers | print + minify; `printer-serialization/*` |
| parser | placement, error recovery | `nest`, `error-recovery`; `parser-syntax/*` |

Mutation gaps: `wrap-layer` uses a named layer, `nest` never puts declarations after a nested rule,
none puts logical properties in `@keyframes`; use probes.
