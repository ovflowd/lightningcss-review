# bundler checklist (BUNDLE)

`src/bundler.rs`, `src/dependencies.rs`, `src/rules/import.rs`, `src/values/url.rs`, napi `bundle`/`bundleAsync`. The oracle does not follow `@import` (L7) and probes are single-file: evidence is `bundler::tests` (`fs!{}` TestProvider), `dep_test` or `node/test/bundle.test.mjs`.

- [BUNDLE-01] (BLOCKER) Every `@import` condition survives inlining: named, anonymous and dotted layers, `supports()`, media ANDed with the child's (a `not` query ANDed naively becomes NOT(A AND B)), and `@layer` statements inside a layered child keep their names (no double prefix) and positions.
  verify: one bundler test per combination (anonymous parent with layered child, non-leading statement, `not print` parent).
- [BUNDLE-02] (BLOCKER) Duplicate imports keep cascade semantics: the last instance decides the position, and duplicates differing in layer, media or supports are neither collapsed nor merged into one position.
  verify: tests `@import a print; @import b; @import a screen` and `@import a; @import a layer(x)` asserting order and both copies.
- [BUNDLE-03] (MAJOR) Output is independent of rayon completion order: the source index assigned at registration is the one the map uses (`add_source` runs in completion order), and no HashMap iteration reaches output.
  verify: run the PR's bundler and node bundle tests twice over at least three parallel imports and compare code and maps.
- [BUNDLE-04] (MAJOR) Inlined child content is valid where it lands: leading `@layer` statements are hoisted, and a child's `@namespace`, `@charset` or `@import` never ends up inside the layer, media or supports wrappers; a child starting with U+FEFF leaves no BOM mid-output (it joins the next selector).
  verify: bundler tests with a `@namespace` child and a BOM child, asserting output; strict re-parse of the bundle.
- [BUNDLE-05] (MAJOR) External imports keep the contract: a resolver may return `{external}`, externals before every bundled import keep their order, one after a bundled import is `ExternalImportAfterBundledImport`, serde attributes and TS types match.
  verify: bundler and node "external import" tests; `cargo check -p lightningcss --no-default-features --features bundler,sourcemap` (B8 compiles no bundler code).
- [BUNDLE-06] (MAJOR) `analyzeDependencies` keeps semantics: a removed `@import` reports url, media, supports and layer; placeholders print as `url("<placeholder>")` (downstream string-replaces that exact form); fragment-only `url(#id)` and `data:` URLs are not dependencies; `image-set()` strings are; a relative `url()` in a custom property stays `AmbiguousUrlInCustomProperty`; `loc` points at the URL token.
  verify: `dep_test`/`dep_error_test` cases; node tests asserting `dependencies`.
- [BUNDLE-07] (MAJOR) Existing callers see the same resolver behavior: `FileProvider::resolve` stays relative to the importing file, JS `read`/`resolve` throws and non-string returns become errors naming the specifier and file with a location, a child's syntax error names the child, `bundle` and `bundleAsync` agree, relative `url()`s in imported files stay as written.
  verify: node bundle.test.mjs; bundler `error_test`.
- [BUNDLE-08] (MAJOR) Nothing new can panic on a bundler worker or threadsafe-function path: release builds use `panic = 'abort'`, which kills the Node process.
  verify: risk flags `added-unwrap`/`added-panic` on src/bundler.rs; async node tests run repeatedly.
- [BUNDLE-09] (MAJOR) CSS modules and custom media work across files: each file keeps its own hash, `composes … from` keeps the first instance, imported files' exports are not re-exported, `@custom-media` crosses files only with the flag.
  verify: `bundler::tests::test_css_module`; custom-media bundler cases.
- [BUNDLE-10] (MAJOR) Visitors see bundled sheets correctly: bundler `CssRule::Ignored` placeholders survive a JS StyleSheet visitor round trip (the CssRule deserializer needs `value` before dispatching on `type`), and visitors run once over the bundle.
  verify: node visitor tests "works with bundler"/"async bundler", customAtRules "bundler".
