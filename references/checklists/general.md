# General checklist (every PR)
Cross-cutting judgment the harness cannot make; reasons and helpers in `references/conventions.md`.

- [GEN-01] (MAJOR) The parser implements the spec grammar exactly (optional parts, `||`/`&&`, functional vs keyword forms, ranges) and the PR cites the section.
  verify: spec anchor for the property or rule; one probe per optional or alternative branch; read the `Parse` impl.
- [GEN-02] (MAJOR) Draft or single-engine syntax is behind `ParserFlags` exposed as JS `drafts`, not a cargo feature or unflagged; syntax opposed by other vendors is not added.
  verify: spec status and standards positions; `src/parser.rs` `ParserFlags`, napi `Drafts`, `node/index.d.ts`.
- [GEN-03] (MAJOR) New values are typed (no `TokenList` where a grammar exists), input browsers reject stays `Property::Unparsed`, and no non-standard leniency exists outside an opt-in mode.
  verify: PR has `property_range_test` cases with `None`; read the diff for `TokenList`; probe an out-of-range value.
- [GEN-04] (BLOCKER) The change preserves what the oracle cannot see: interpolation and animation, computed-value-time behavior (custom properties, `all`, inheritance) and CSSOM-visible serialization.
  verify: reason from the spec anchor; mutations `var-before`, `var-after`, `important`.
- [GEN-05] (MAJOR) Emitted syntax is accepted by targets the engines do not cover (versions below the legacy profiles, Samsung, Opera, Android), and no old-browser workaround is added without a target gate and a reason.
  verify: compat data for the emitted syntax; mutations `retarget-legacy`, `engine-legacy-2021`.
- [GEN-06] (MAJOR) A handler or ordering change is tested in both orders in the PR's own tests: typed then `var()`, `var()` then typed, prefixed then unprefixed, shorthand then longhand.
  verify: read the PR tests; mutations `reverse-decls`, `var-before`, `var-after`, `prefixed-sibling`.
- [GEN-07] (MAJOR) Compat changes go through `scripts/build-prefixes.js` (generated files not hand-edited), partial support is not counted as support, and every override cites the browser bug.
  verify: read the generator diff; compare `src/compat.rs`/`src/prefixes.rs` hunks against it.
- [GEN-08] (MAJOR) A new lowering has a `Features` flag, is tested with `prefix_test` on a target that needs it and one that does not, and honors an enclosing `@supports` condition.
  verify: `src/targets.rs` `Features` diff; PR tests; mutations `retarget-none`, `retarget-modern`, `wrap-supports`.
- [GEN-09] (MAJOR) Behavior changes are opt-in: new options default to current behavior, existing options keep their meaning, new errors are gated by their mode, and a spec-driven output change states its path (fix, opt-in, major).
  verify: read option handling and the PR text; S1 deltas.
- [GEN-10] (MAJOR) The fix is at the root cause and covers the whole class: sibling types and call sites sharing the code, several values or selectors, boundary numbers.
  verify: grep sibling call sites of the changed function; probes around the fixed input show no `still-different`.
- [GEN-11] (MAJOR) Nothing is dropped, renamed or merged based on what one file contains (custom properties are global, code splitting exists).
  verify: read the diff for usage-based removal outside `unused_symbols`.
- [GEN-12] (BLOCKER) No `unwrap`/`expect`/`unreachable!`/`panic!` is reachable from CSS input, including `currentcolor`, system colors, `var()`, infinite or NaN math.
  verify: risk flags `added-unwrap`/`added-panic`; probes with those inputs in the touched values.
- [GEN-13] (MAJOR) No hash-ordered iteration reaches output or rule emission.
  verify: grep the diff for `HashMap`/`HashSet` iteration in printing and minify paths.
- [GEN-14] (MINOR) Hot paths (printer writes, handler loops, `CssRuleList::minify`) gain no quadratic scans or per-declaration hashing, and representation changes come with a benchmark.
  verify: read loops in the diff; `lcr perf` P1/P2.
- [GEN-15] (MINOR) Code reuses existing types, macros, serializers and options and sits where conventions put it (handler in `src/properties/<area>.rs`, tests in the area's `test_<area>` fn); no hand quoting or escaping.
  verify: read the diff against `references/conventions.md`.
- [GEN-16] (MAJOR) New public types carry the visitor/serde/jsonschema/`into_owned` derives and a spec-linked doc, new `CssRule` variants are named in `napi/src/transformer.rs`, new options are in `node/index.d.ts`, and new public enum variants in `parcel_selectors` are called out.
  verify: grep the diff for the derive stack, `transformer.rs`, `index.d.ts`.
