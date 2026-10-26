# General checklist (every PR)

Format (parsed by `lcr report`): `- [ID] (SEVERITY-IF-FAIL) statement` followed by an optional
`verify:` line. Answer every item in `analysis.json` with PASS, FAIL or N/A plus evidence (a case id,
probe id, `file:line`, spec URL#anchor, or command output). Sources: `references/maintainer-playbook.md`
(Devon's review history), discussion #1241, and the regression archaeology.

## Spec and semantics

- [GEN-01] (MAJOR) The change implements the spec grammar exactly (optional parts, `||`/`&&` combinators, functional and keyword forms, value ranges), and the PR or code cites the drafts.csswg.org section.
  verify: compare the parser against the webref grammar; write probes for each optional/alternative branch.
- [GEN-02] (MAJOR) Draft, single-engine or contested syntax is behind a runtime flag (`ParserFlags`/`drafts`, exposed to JS), not shipped unflagged and not a cargo feature.
  verify: check standards positions / BCD for the feature; look for the flag in `src/parser.rs` and `napi/src/lib.rs`.
- [GEN-03] (MAJOR) Browser-invalid input stays invalid: values browsers reject are not accepted as typed values; they stay `Property::Unparsed` (or are rejected at rule level).
  verify: WPT invalid cases for the property (`invalid-became-valid` must be absent); a probe with an out-of-range value.
- [GEN-04] (MAJOR) No non-standard syntax or extra leniency outside an opt-in mode (CSS modules, `deep-selector-combinator`, `errorRecovery`).
  verify: read the parser change; error_test or probe with the non-standard form.
- [GEN-05] (BLOCKER) Every minification preserves static rendering, animation/interpolation behavior, the cascade (importance, specificity, layer and declaration order) and computed-value-time behavior (custom properties, `all`, inheritance).
  verify: oracle results on deltas and mutations; reason about interpolation for transforms/colors/gradients.
- [GEN-06] (MAJOR) Every serialization the change emits is accepted by the browsers in the targets (not just valid per spec).
  verify: oracle check O3 (rejected declarations) in current and legacy engines; BCD for the emitted syntax.

## Cascade and order

- [GEN-07] (MAJOR) When a property handler changes, both orders are tested: typed then `var()`/unparsed, unparsed then typed, prefixed then unprefixed, shorthand then longhand.
  verify: mutations `reverse-decls`, `var-before`, `var-after`, `prefixed-sibling` show no regression; PR tests contain both orders.
- [GEN-08] (MAJOR) Rule merging and deduplication keep `!important`, non-adjacent duplicates, vendor-prefixed selectors and CSS-modules rules from different files distinct.
  verify: mutations `important`, `duplicate-nonadjacent`; probes in corpus/probes/rule-merging.
- [GEN-09] (MAJOR) `@layer` order is preserved: statements inside `@media`/`@supports`, layered and unlayered `@import`, dotted sublayers, empty blocks.
  verify: probes in corpus/probes/cascade-layers-scope; mutation `wrap-layer`.
- [GEN-10] (MAJOR) Selector lowering keeps specificity (`:not()` lists, `:is()` with unequal specificities) and never puts pseudo-elements inside `:is()`.
  verify: probes in corpus/probes/selectors; oracle on lowered outputs.
- [GEN-11] (MAJOR) Nesting works both lowered (`nesting_test`) and preserved (no targets), including `!important` in nested group rules, selector lists and pseudo-elements.
  verify: mutation `nest` with and without targets.
- [GEN-12] (MAJOR) Output is deterministic: no HashMap iteration reaches output order.
  verify: grep the diff for HashMap/HashSet iteration in printing or rule emission; idempotency and repeated runs.

## Targets and compat

- [GEN-13] (MAJOR) New lowering is driven by a compat feature in `scripts/build-prefixes.js`; `src/compat.rs`/`src/prefixes.rs` are regenerated, not hand-edited; partial support is not treated as full; overrides carry a justification comment and bug link.
  verify: check B11; read the build-prefixes.js diff.
- [GEN-14] (MAJOR) `prefix_test` covers a target that needs the lowering and one that does not (output unchanged there), in both prefix directions where relevant.
  verify: PR tests; mutations `retarget-none`, `retarget-modern`, `retarget-legacy`.
- [GEN-15] (MINOR) A new lowering has a `Features` flag so users can `exclude` it; `node/flags.js` and `node/targets.d.ts` regenerated.
  verify: src/targets.rs Features diff; B11.
- [GEN-16] (MAJOR) Lowering inside `@supports` honors the enclosing condition (`TargetsWithSupportsScope`).
  verify: mutation `wrap-supports` with targets.
- [GEN-17] (MINOR) No hacks for very old or buggy browser versions unless gated on targets and justified (the spec is the source of truth, not implementation bugs).
  verify: read the change for browser-version special cases.

## Code quality

- [GEN-18] (MINOR) Reuses existing types and macros (`Size2D`, `Rect`, `NonNegative`, `enum_property!`, `#[derive(Parse, ToCss)]`, `define_shorthand!`), cssparser serializers (`serialize_string`/`serialize_identifier`) and existing options.
  verify: read the diff.
- [GEN-19] (MAJOR) Values are fully parsed into typed AST; no `TokenList` where a grammar exists; at-rules get dedicated descriptor types.
  verify: read the diff; WPT recognition (`value-coverage-gap` vs `recognized`).
- [GEN-20] (BLOCKER) No `unwrap()`/`expect()`/`unreachable!()`/`panic!` reachable from user CSS; `currentColor`, system colors and `var()` inputs never panic.
  verify: risk flags added-unwrap/added-panic; R1; probes with currentcolor/var() in the touched values.
- [GEN-21] (MINOR) Hot paths are untouched or measured (printer `write_str`, handler loops); no quadratic scans or per-declaration hashing; representation changes come with a CodSpeed result.
  verify: CodSpeed check on the PR (B6); read loops in the diff.
- [GEN-22] (MAJOR) Behavior changes are opt-in; new options default to current behavior; existing options keep their meaning.
  verify: read option handling; S1/realworld deltas.
- [GEN-23] (MAJOR) The fix addresses the root cause and the whole class (e.g. all number chains in calc, multiple selectors), not one symptom.
  verify: mutations and probes around the fixed input produce no `still-different` cases.

## API, bindings, docs

- [GEN-24] (MAJOR) New AST types carry the visitor/serde/jsonschema/into_owned attributes and doc comments with spec links; `node/ast.d.ts` regenerated; new `CssRule` variants are named in `napi/src/transformer.rs`.
  verify: B11; grep the diff for the attribute stack.
- [GEN-25] (MINOR) `node/index.d.ts` (hand-written) and the website docs are updated for new options or user-visible features.
  verify: diff touches node/index.d.ts / website/pages/*.md when options change.
- [GEN-26] (MAJOR) JS-facing changes are tested in `node/test/*.mjs` and pass (B5).
  verify: B5.
- [GEN-27] (MAJOR) Per-crate and feature builds pass (selectors crate, `--no-default-features`, wasm32 gate, C bindings when touched).
  verify: B7, B8, B9, B10.
