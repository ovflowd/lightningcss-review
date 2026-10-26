# bindings-api checklist (API)

Public surfaces: napi (`napi/src/lib.rs`), `node/` (loader, hand-written index.d.ts, generated ast.d.ts), `wasm/`, C bindings, CLI (`src/main.rs`), `src/error.rs`, serde shapes, Rust public types. Builds and generated files are B5, B8-B11; downstream tools rely on contracts tests do not pin (references/ecosystem.md).

- [API-01] (MAJOR) `node/index.d.ts` matches napi for every added or renamed option and result field: camelCase key, optionality matching `#[serde(default)]`/`Option`, result shapes, doc comments (`yarn tsc` checks validity only, not agreement with Rust).
  verify: read the napi Config/BundleConfig/AttrConfig diff against index.d.ts.
- [API-02] (MAJOR) New options are optional and default to current behavior in every entry point that accepts them (transform, bundle, style attribute, CLI, C), and existing options keep their meaning.
  verify: a node test without the option gives base output; read each `unwrap_or` default.
- [API-03] (MAJOR) `node/ast.d.ts` matches the runtime AST: regenerated with `yarn build-ast`, and the index-based untagged-enum patches in scripts/build-ast.js updated when such an enum gains a variant.
  verify: a visitor dump of a changed node vs its declared type; diff against base's regeneration.
- [API-04] (MAJOR) Rust public API changes are declared: new variants on public enums (`ParserError`, `CssRule`, `Property`, `parcel_selectors` error kinds), new fields on public structs built by literal (`css_modules::Config`, `ParserOptions`, `PrinterOptions`, `Targets`), changed trait signatures (`SourceProvider`, `Visitor`, `AtRuleParser`, `ToCss`), payloads that become private; a public variant in `parcel_selectors` (a caret dependency) bumps its version.
  verify: risk flag `public-api`; read the diff; `cargo build -p lightningcss_c_bindings` when a struct `c/src/lib.rs` builds by literal changes (B10 needs a `c/` change).
- [API-05] (MAJOR) Feature-gated code compiles per documented combination: serde, schemars, visitor, into_owned attributes behind `cfg_attr(feature = …)`, dependency features gated by the crate's own.
  verify: `cargo check -p lightningcss --no-default-features --features <f>` for each of `bundler,sourcemap`, `serde`, `visitor`, `into_owned` touched (B8 covers none of them).
- [API-06] (MAJOR) The minify/print split is unchanged: transforms Rust callers get only from `StyleSheet::minify` stay there, print-time lowering stays in the printer, and JS `minify: false` still runs `StyleSheet::minify`.
  verify: probe pairs `mode: print` and `mode: minify` on the PR's inputs.
- [API-07] (MAJOR) Error and warning surfaces are stable: serde `type` names, messages, `data` payloads and locations unchanged unless declared (tools regex warning text and fail builds on some kinds); a warning promoted to an error is breaking; no new warning on valid input.
  verify: diff src/error.rs; warnings via `lcr show` (deltas ignore them).
- [API-08] (MAJOR) CLI changes exit non-zero with a message, add no `unwrap()`/`expect()` on user input, use `--no-x` negations, and come with an integration test.
  verify: risk flag `added-unwrap` on src/main.rs; run the head CLI on an invalid file and on the new flag.
- [API-09] (MAJOR) The native loader stays statically analyzable: package names `lightningcss-<platform>-<arch>[-<abi>]`, no `require()` of a path missing from the package, the first load error is not hidden by a second.
  verify: diff node/index.js.
- [API-10] (MAJOR) wasm stays in parity: entry points mirror node, wasm-only code compiles, a changed wasm import set updates the shipped loaders. B9 does not link: link errors show only in CI test-wasm.
  verify: B6 test-wasm; read wasm/ against node/.
- [API-11] (MAJOR) Serde JSON shapes are contracts: `Targets`, `Dependency`, `CssModuleExport`, warnings keep field names and optionality, collections keep source order.
  verify: tests/test_serde.rs; node tests asserting result objects.
- [API-12] (MAJOR) Strings cross the JS boundary losslessly: NUL (`\0virtual` ids), lone surrogates and non-ASCII round-trip through `filename`, map `sources` and module hashes.
  verify: node test with `filename: '\0virtual.css'` checking the map.
- [API-13] (MAJOR) Async and threaded entry points cannot panic or deadlock (`panic = 'abort'` kills Node); shared options act the same in `transform`, `transformStyleAttribute`, `bundle` and `bundleAsync`.
  verify: async node tests run repeatedly; risk flags on napi/.
