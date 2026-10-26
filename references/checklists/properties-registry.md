# properties-registry checklist (PROPS)

`define_properties!` in `src/properties/mod.rs`: the macro (`PropertyId` matching, `Property::parse` with its Unparsed fallback, prefix plumbing, the per-prefix print loop, shorthand API, serde) and the table. Risk flag `new-property` fires on new entries.

- [PROPS-01] (BLOCKER) A newly typed property keeps its cascade position: the PR names the handler that owns it (or none); an owning handler flushes on `Property::Unparsed` and unowned siblings in both orders; an unowned property, pushed immediately, is not reset by a shorthand a handler buffers until `finalize()`.
  verify: `reverse-decls`, `var-before`, `var-after`; tests `shorthand; new-longhand` and the reverse.
- [PROPS-02] (MAJOR) The typed grammar rejects everything browsers reject, so invalid values stay Unparsed and keep losing to an earlier valid declaration: no empty input, no unitless non-zero lengths, ranges via `NonNegative<T>` or checks, keywords ASCII case-insensitive.
  verify: `property_range_test(.., None)` cases; O7 shows no `invalid-became-valid`.
- [PROPS-03] (MAJOR) Entry metadata is right: lowercase spec name; the prefix list is exactly what engines shipped (an unlisted prefix parses as `Custom`); legacy-only names use `unprefixed: false`; module-only properties use `if css_modules`.
  verify: read the table diff; a `print` probe per prefixed spelling; `upper-props`.
- [PROPS-04] (MAJOR) Typing a property is declared as a JS-visible change: visitor hooks move from `Declaration.custom['name']` to `Declaration['name']`, the serde shape becomes `{property, value, vendorPrefix?}`, ast.d.ts gains the type.
  verify: a node visitor test on the property.
- [PROPS-05] (MAJOR) `shorthand: true` entries implement `longhands()`/`longhand()`/`set_longhand()` via `define_shorthand!`/`define_list_shorthand!`, refusing mixed `!important`, so `DeclarationBlock::get/set/remove` work.
  verify: tests/test_cssom.rs cases for the shorthand.
- [PROPS-06] (MAJOR) Logical properties carry `[logical_group, category]` matching their physical counterparts, so `DeclarationBlock::set` and side-handler flushes keep logical/physical order.
  verify: tests mixing logical and physical in both orders; `reverse-decls`.
- [PROPS-07] (MAJOR) The typed value serializes no longer than the input and keeps `none` distinct from identity values (stacking, interpolation).
  verify: `lcr show` on deltas; reason about interpolation where the oracle is static (L5).
- [PROPS-08] (MAJOR) Aliases share one cascade slot: a name aliasing an existing property (`font-width`/`font-stretch`, `gap`/`grid-gap`, `word-wrap`/`overflow-wrap`) is ordered and deduped as one, or both stay unknown.
  verify: probe font/font-width-not-moved-before-font; `reverse-decls` with both spellings.
- [PROPS-09] (MAJOR) `Property::parse` consumes the whole value and never drops a declaration: any failure falls back to Unparsed, and `var()`, `env()` and CSS-wide keywords print verbatim.
  verify: tests `prop: var(--x)` and `prop: inherit`.
- [PROPS-10] (BLOCKER) A change to the macro itself is behavior-neutral for every entry unless claimed.
  verify: tuple and wpt deltas are 0 or classified; tests/test_serde.rs.
- [PROPS-11] (MAJOR) Prefix expansion for a new property is data-driven: a `prefixes::Feature` exists when it needs prefixes, `unprefixed: false` entries get none, and `transition-property` expansion knows the prefixed names.
  verify: prefix_test with a target that needs the prefix and one that does not.
- [PROPS-12] (MAJOR) `@supports (prop: value)` and container `style()` queries still print the property unchanged.
  verify: `wrap-supports`; a `@supports (new-prop: value)` probe in `print` and `minify` modes.
- [PROPS-13] (MINOR) Each entry expands into every generated match, so large value types are boxed or justified.
  verify: P2; read the value type size.
