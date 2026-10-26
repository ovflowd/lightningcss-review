# Selectors checklist (prefix SEL)
`src/selector.rs`, `selectors/` (parser state, specificity), selector paths of `src/rules/mod.rs`. Facts: `spec/selectors.md`.

- [SEL-01] (BLOCKER) No selector is merged into a list that a target engine (no targets: C, F or W) rejects: each added or changed component has an `is_compatible` arm covering its arguments, flags and position.
  verify: `retarget-none`, `duplicate-nonadjacent`; `rule-merging/no-merge-*`; `.a{color:red} <new>{color:red}` with and without targets
- [SEL-02] (BLOCKER) Selectors split off for targets keep their declarations through `merge_style_rules`; no side rule is built for an emptied list.
  verify: `selectors/split-list-unknown-pseudo-dropped`, `selectors/all-selectors-incompatible-no-empty-supports-rule`; `retarget-legacy`, `nest`
- [SEL-03] (BLOCKER) An `:is()` wrap needs `:is()` support, no pseudo-element in any member (also behind `:global()` or after a visitor round trip) and equal spec specificity.
  verify: `selectors/is-wrap-has-specificity`, `selectors/pseudo-element-not-wrapped-in-is`; `engine-legacy-2021`
- [SEL-04] (BLOCKER) Lowering keeps specificity: `:not(a,b)` to `:not(:is(a,b))`, top-level or `@scope` `&` to `:where(:scope)`, `-any` copies only for compound arguments of max (0,1,0) with the unprefixed rule last, `:where()` and `of S` kept; a specificity-raising heuristic is target-gated and documented.
  verify: `selectors/not-list-lowering-specificity`, `selectors/webkit-any-fallback-specificity`; `retarget-legacy`; a rule of in-between specificity
- [SEL-05] (BLOCKER) `:is(X)` unwraps only if X is valid there in every target engine (known, not after a pseudo-element, not in `:has()`, no `:lang()` list or `[s]`) and no type selector lands after a simple selector.
  verify: `selectors/is-not-unwrapped-*`, `selectors/is-type-selector-not-glued`; read `should_unwrap_is`
- [SEL-06] (BLOCKER) A newly known pseudo or `SelectorParsingState` change rejects nothing base accepted that spec or WPT allows, accepts nothing C/F/W reject, and warns on no valid input (bundlers fail on warnings); drafts sit behind `ParserFlags`.
  verify: `selectors/before-marker`, `selectors/details-content-*`, `selectors/*search-text*`, `selectors/framework-pseudo-verbatim`; parse-error and warning deltas
- [SEL-07] (MAJOR) `:not()`, `:has()`, `of S`, `:-webkit-any()` stay unforgiving; an emptied `:is()`/`:where()` prints `:is()`; `:has(::x)` never becomes `:has()`.
  verify: `selectors/has-unforgiving-argument`, `selectors/has-pseudo-element-argument-not-emptied`; selectors-4#forgiving-selector
- [SEL-08] (BLOCKER) Prefixed spellings round-trip: legacy pseudo-class and pseudo-element forms stay distinct, no unprefixed copy from a legacy alias, merged prefix-equivalent rules keep each prefix.
  verify: `selectors/*placeholder*`, `selectors/prefixed-pseudo-merge-keeps-prefix`; a stored-prefix change: same-declaration sibling pairs in both orders plus a non-adjacent duplicate
- [SEL-09] (MAJOR) A new pseudo has a generated compat Feature (partial is not full) and each new variant is matched without `_ =>` in printers, `get_prefix`, `is_equivalent`, `is_unused`, specificity, serde.
  verify: grep each new variant in `src/selector.rs`, `selectors/`; `retarget-modern`
- [SEL-10] (BLOCKER) Output re-parses equivalently: closed functions, leading `:scope` kept in `:has()`, escaped unknown names, same An+B set, name case, `i`/`s`, `*` under a default namespace, no compound collapse.
  verify: `selectors/nth-col-a0-unbalanced-output`, `selectors/has-scope-only-argument`, `selectors/type-and-attribute-name-case-preserved-for-svg` (F/W only)
- [SEL-11] (BLOCKER) Namespace-prefixed selectors merge only if declared with one URL in one sheet; bundling moves no `@namespace`.
  verify: `rule-merging/no-merge-undeclared-namespace-prefix`; two-file `--bundle`
- [SEL-12] (BLOCKER) Case-sensitive pseudo arguments keep case; CSS modules hash no `::part()`/`:state()` name or the UA `root` view-transition name, and rename classes in every selector argument.
  verify: flag `css-modules`; `css-modules/state-pseudo-not-hashed`, `css-modules/sat-view-transition-root-name-not-scoped`, `css-modules/nth-child-of-selector-renamed`
- [SEL-13] (BLOCKER) `:host(X)`, `::slotted(X)`, `::part()` keep their one-compound argument and every part name and never become compounds or descendants (`:host(.a)` is not `:host.a`).
  verify: output assertions (no shadow trees in the oracle); `selectors/host-*`
