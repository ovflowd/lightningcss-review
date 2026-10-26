# Lightning CSS conventions

Rules a contributor must follow and the maintainer will ask for, each with its reason. The
checkable ones are items in `checklists/general.md`.

## Philosophy

- **Fully parse.** Values become typed structures, not `TokenList`/`DeclarationBlock`, wherever a
  grammar exists; at-rule descriptors get their own types (so `!important` cannot appear in them).
  Minification, lowering and correctness all depend on knowing the structure. A value that fails to
  parse stays `Property::Unparsed` so newer syntax passes through untouched.
- **Standard syntax only.** Non-standard rules and properties pass through under `errorRecovery` as
  long as they are valid CSS syntax; extensions are opt-in only (CSS modules,
  `ParserFlags::DEEP_SELECTOR_COMBINATOR` / JS `nonStandard`). The project is not a PostCSS-style
  syntax playground.
- **Spec decides semantics, targets decide what may be emitted.** Output must parse in every target
  browser, not just be spec-valid (keep a fallback form the target accepts). Old-browser bugs are not
  encoded; at most a workaround is gated on targets and justified, since a bug cannot be tested for.
- **Drafts behind runtime flags.** Single-engine or still-changing syntax goes behind `ParserFlags`
  plus the JS `drafts` option, never a cargo feature (JS users need it). Unflagged draft syntax that
  the spec later changes becomes a breaking change. Syntax opposed by other vendors is held off.
- **Don't break users.** New behavior is opt-in, new options default to current behavior, existing
  options keep their meaning, new errors are gated by the mode that makes them errors (e.g. only with
  CSS modules on). A spec-driven output change must say which path it takes: accepted as a fix,
  opt-in, or deferred to a major.
- **No whole-program assumptions.** A file is one piece of a page: custom properties are global and
  code splitting exists, so nothing is dropped or renamed from what one file contains. Bundling must
  not change behavior.
- **Error recovery mirrors browsers**: drop the invalid declaration or rule, keep the rest; unknown
  pseudo-classes are warnings.
- **Root cause, whole class.** Review is by counterexample: other order, `var()`, several selectors or
  values, boundary numbers, sibling types sharing the code. Fix the shared root; put special cases at
  the call site, not in shared grammar code. Conservative beats clever: a transform that cannot be
  proven safe (incomparable `clamp()` arguments, layer content across conditional groups) is not done.
- **Performance and binary size are features.** Hot paths (printer `write_str`, handler loops,
  `CssRuleList::minify`) get no quadratic scans or per-declaration hashing or allocation; rare cases
  stay out of them. Representation changes (boxing, enum size) need a benchmark. CodSpeed runs on PRs.
- **Untestable platforms** (no CI, no hardware) are declined; users can build from source.

## Where code goes

- Property: `define_properties!` in `src/properties/mod.rs` (name, type, prefixes, logical group,
  shorthand); type and handler in `src/properties/<area>.rs`. A new longhand of an existing shorthand
  belongs to that shorthand's handler, or its order after the shorthand must be tested.
- Values: reuse `NonNegative<T>`, `Size2D<T>`, `Rect<T>`, `enum_property!`, `#[derive(Parse, ToCss)]`,
  `define_shorthand!`, `define_list_shorthand!`, `shorthand_handler!`, existing options. Two ways to
  do one thing is a review finding. Order-free shorthands parse in a loop; `try_parse` only for
  optional parts; hand-written `Parse` when components share keywords.
- At-rule: `src/rules/<name>.rs`, a `CssRule` variant (serde, `to_css`, minify arm), prelude and
  block parsing in `src/parser.rs` (`allowed_in_style_rule` if nestable), visitor name in
  `napi/src/transformer.rs`.
- Selectors: the `selectors/` fork plus `src/selector.rs`; parse and print tables stay inverses.
- Lowering: `should_compile!`/`Feature::X.is_compatible`; logical via `should_compile_logical` +
  `add_logical_rule`; conditional fallbacks via `add_conditional_property`.
- Serialization: cssparser `serialize_string`/`serialize_identifier`/`serialize_name` (the `Printer`
  already wraps them), never hand quoting or escaping. Unitless zero prints `0` except inside math.
- Public types: `cfg_attr` derives for visitor, serde (`tag = "type"`, `content = "value"`,
  kebab-case), jsonschema, `into_owned`, and a `///` doc with a spec link (`missing_docs` is denied).
- No `unwrap`/`expect`/`unreachable!`/`panic!` reachable from CSS: fallible conversions, `TryFrom`.
- `IndexMap`/`Vec` wherever iteration order reaches output; hash order makes builds nondeterministic.
- New dependencies optional behind cargo features; every crate builds alone, with
  `--no-default-features`, and for wasm32.

## Generated files

- `node scripts/build-prefixes.js` writes `src/compat.rs`, `src/prefixes.rs`, `node/targets.d.ts`,
  `node/flags.js` and the `Browsers`/`Features` structs in `src/targets.rs`. Never hand-edit them:
  change the generator (MDN feature list, `flags` array, overrides) and commit its output.
  Overrides cite the browser bug. Partial implementations are not support: filter them in the
  generator, not in Rust. Prefix data is autoprefixer's.
- A new lowering gets a `Features` flag (generator `flags` array) so users can `exclude` it.
- `yarn build-ast` regenerates `node/ast.d.ts` when AST types change.
- `node/index.js.flow` is generated from the TS types: typing tricks must also work for Flow.
- `node/index.d.ts` is hand-written: document every new option there; user-visible features also in
  `website/pages/`.

## Tests

In `src/lib.rs`, inside the area's `fn test_<area>()` (`test_font`, `test_selectors`, ...);
cross-area regressions get their own named fn. New tests must fail on base.

| Scenario | Helper |
|---|---|
| serialization, minification | `minify_test`; `minify_test_with_options(_and_browsers)` |
| pretty output, rule merging | `test` with `indoc!` (minify, no targets) |
| lowering, prefixes, fallbacks | `prefix_test(src, out, Browsers {..})`: targets on minify and print |
| nesting lowered / preserved | `nesting_test` (fixed old Chrome), `nesting_test_with_targets`, `nesting_test_no_targets` |
| CSS modules | `css_modules_test` (asserts exports and references) |
| `@custom-media` | `custom_media_test` |
| must fail | `error_test`, `error_test_with_options`, `css_modules_error_test`, `minify_error_test_with_options` |
| recovery warnings | `error_recovery_test` |
| style attribute | `attr_test` |
| value ranges | `property_range_test(&["prop"], &[(in, Some(out) or None)])`; `None` = stays Unparsed |
| deps, bundler, CLI | `test_dependencies`, `mod tests` in `src/bundler.rs`, `tests/cli_integration_tests.rs` |
| JS API, visitors, bundle | `node/test/*.test.mjs` (also run under wasm) |

Idiom: range check, then `minify_test`, then `prefix_test` with a target that needs the lowering and
one that does not; both orders for anything order-related; loops with `format!` over property or
pseudo lists; ported WPT cases carry a link comment; issue repros pasted as-is.

## Naming and API compatibility

- Commit subjects: imperative, sentence case; a conventional-commit prefix is accepted, not a finding.
- Options: JS camelCase; CLI flags opt-in, turning a default off as `--no-x`; `drafts: {x}` maps to
  `ParserFlags::X`; `Features::PascalCase`. Comments cite spec URLs or csswg issues.
- The Rust crate is pre-release, so Rust signatures may change; the npm API and output semantics
  must not break.
- `parcel_selectors` reaches users unpinned: a new public enum variant breaks exhaustive matches
  downstream and must be called out.

## What a PR should already answer

What it fixes and the measured effect; spec text with anchor and status; minimal before/after for
each behavior change; browser results for emitted syntax; the real use case for new options or
syntax; numbers for performance claims; the chosen path for breaking changes; tests in the idiom.
