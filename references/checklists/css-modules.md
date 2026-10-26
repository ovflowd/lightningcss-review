# css-modules checklist (MOD)

`src/css_modules.rs`, `composes`, ident printing, `:local()`/`:global()`, pure mode. The oracle (L8) and mutations skip CSS modules, and the adapter sorts exports and drops references: evidence is the PR's `css_modules_test` and output assertions.

- [MOD-01] (BLOCKER) Each new or changed ident printer decides scoping explicitly: local names (classes, ids, keyframes, counter styles and `counter()` arguments, grid lines/areas, container and view-transition names, dashed idents with `dashedIdents`) are hashed at the definition and every reference; UA or JS-visible names (`:state()`, `match-element`, `root`, `auto`, `none`, CSS-wide keywords) never.
  verify: a `css_modules_test` asserting CSS and exports; probes css-modules/*.
- [MOD-02] (BLOCKER) Rule-level minification keeps module semantics: duplicate-rule removal (its key compares property ids only) does not drop an earlier rule's `composes`, `:global()`/`:local()` lists are not folded into `:is()` around pseudo-elements, and rules from different source files are not merged.
  verify: a test `.a{composes:b} .x{color:red} .a{composes:c}` asserting both; probe css-modules/global-list-pseudo-element-not-folded-into-is.
- [MOD-03] (MAJOR) `Property::Unparsed` values (`var()`, `env()`) are renamed wherever the typed value would be, or the PR states the gap.
  verify: a test of the same value with a `var()` member; probe with `flags: css-modules` and `output-contains:` the hashed name.
- [MOD-04] (MAJOR) Exports and references keep their contract: `CssModuleExport { name, composes: Local | Global | Dependency, isReferenced }` in source order, no export for a non-local name, `var(--x from "./f.css")` in `references`, `from global` left bare.
  verify: expected exports and references in the PR's `css_modules_test`; `test_css_module_order`.
- [MOD-05] (MAJOR) Generated names are stable unless the PR declares a naming change: hash input (path relative to `projectRoot`, `[local]`, `[content-hash]`), pattern segments and encoder unchanged; `std::hash::DefaultHasher` is not stable across Rust releases.
  verify: no hash changes in `css_modules_test` expectations; read the hashing diff.
- [MOD-06] (MAJOR) Module-only syntax and errors (`composes`, `:local()`/`:global()`, `var(--x from …)`, `global()`, pure-mode lints) are gated on `css_modules.is_some()` and change nothing when modules are off.
  verify: the PR's inputs without `css-modules` give identical output; probe transition-animation/global-fn-without-css-modules.
- [MOD-07] (MAJOR) A new config option reaches every entry point with a default equal to current behavior: `css_modules::Config`, napi transform and bundle, CLI, C bindings, `node/index.d.ts`, website docs.
  verify: read each site; build `-p lightningcss_c_bindings` when Config gains a field (B10 runs only when `c/` changes).
- [MOD-08] (MAJOR) `composes` rules hold: single simple class selector only, never nested, class names parsed as identifiers (so `composes: default` works), unresolved names keep today's behavior unless the maintainer decides.
  verify: `css_modules_test`/error tests; probe css-modules/composes-class-named-default.
- [MOD-09] (MAJOR) Pure mode stays exact: a local class or id is required, nested children of a pure parent are exempt, every return path restores `context.pure_css_modules` (including rules emptied by `unusedSymbols`), and `/* cssmodules-pure-no-check */` counts only among leading comments.
  verify: `minify_error_test_with_options` cases; a test with `unusedSymbols` plus nested rules.
- [MOD-10] (MAJOR) Patterns give valid names equal to the exports: `[local]` ends the pattern when grid scoping is on, a leading hash digit gets `_`, other leading digits are escaped.
  verify: `css_modules_test` with custom patterns; CLI pattern test.
- [MOD-11] (MAJOR) Hashing does not newly depend on `StyleSheet::minify` (Rust callers print without it; Unparsed `animation` names are renamed only there) or the `sourcemap` feature: multi-file output reads `Printer.loc.source_index`, which only `add_mapping` updates.
  verify: probe pairs `mode: print`/`mode: minify` with `flags: css-modules`; `bundler::tests::test_css_module`.
- [MOD-12] (MAJOR) New module errors are deliberate: a warning promoted to an error is declared breaking, new error kinds have stable names (bundlers map kinds to severities).
  verify: the `src/error.rs` diff; warnings via `lcr show`.
