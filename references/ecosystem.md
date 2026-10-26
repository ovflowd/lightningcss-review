# Ecosystem: what downstream tools pass and rely on

LightningCSS's tests pin none of these contracts; changing one needs a probe or NEEDS_MAINTAINER_DECISION.
Most consumers take releases through a caret range.

| Consumer | Options it passes | Must preserve |
|---|---|---|
| Tailwind v4 | `transform` **twice**; pass 1: `errorRecovery`, `drafts.customMedia`, `nonStandard.deepSelectorCombinator`, `include: Nesting\|MediaQueries`, `exclude: LogicalProperties\|DirSelector\|LightDark`, targets chrome 111, firefox 128, safari 16.4, ios_saf 16.4; then string-patches `@media not (` | output re-parses strictly with the same options; prefixed duplicates do not grow per pass; warning text (a regex hides framework-pseudo warnings); `var(--x, )` keeps its space; `node/index.js` loader shape |
| Vite 8 (default minifier) | `transform({...user, targets, minify: true})`, **strict** unless the user sets `errorRecovery`; targets chrome 111, edge 111, firefox 114, safari 16.4, ios_saf 16.4; empty targets → `undefined`. Transformer mode: `bundleAsync` with resolver, `analyzeDependencies.preserveImports`, `cssModules`, `transformStyleAttribute` | no new parse error on valid CSS (fails the build); JS error locations 1-based; `url("…")` placeholders double-quoted (string-replaced); CSS-module export shape and order |
| Next.js Turbopack (Rust crate) | strips a BOM; `error_recovery: true`; modules `[hash]_[local]`, `dashed_idents/grid/container: false`; `include: MediaRangeSyntax\|Nesting`; `minify(targets)` always, dev too; targets chrome 111, edge 111, firefox 111, safari 16.4 | no new `EndOfInput`, `UnexpectedToken`, `UnexpectedImportRule` or non-pseudo `SelectorError` warnings on valid CSS (they become build errors); `minify()` performs the CSS-modules transform; `selectors::parser::Component` variants (a pure-selector lint matches them); `CssModuleConfig` fields |
| Next webpack, styled-jsx | napi visitors for `url()`/`@import`/ICSS; styled-jsx: `ParserFlags::all()` + recovery, `.expect()` on minify | visitor semantics; every new parser flag reaches styled-jsx; no new `MinifyErrorKind` |
| Rspack, Rsbuild | `errorRecovery` on, **warnings discarded**; include/exclude from a hand-copied `Features` enum; `drafts` customMedia only; minimizer `unusedSymbols`; Rsbuild targets chrome/edge 107, firefox 104, safari 16; crate with `default-features = false` + `serde` | recovery never silently drops a valid rule; deterministic output; `Features` bits never move (new features take new bits); `--no-default-features` build |
| Parcel | `transform({cssModules, analyzeDependencies: {preserveImports: true}, drafts, pseudoClasses, errorRecovery: false, targets})` from browserslist (`> 0.25%`), `transformStyleAttribute`; optimizer `{minify, unusedSymbols}` | error `data` payloads (e.g. `AmbiguousUrlInCustomProperty {url}`); dependency types and placeholders; wasm build; `package.json` `engines`/`exports`/`optionalDependencies` |
| Astro, Nuxt, Rust crates | default options, strict, often no targets | undefined and `{}` targets lower nothing; Rust API semver |

Shared contracts: `Features` bit values and groups; draft syntax only behind a flag, flags keep meaning;
warning/error text and kinds are API; Rust `ErrorLocation.line` is 0-based, `column` 1-based; unknown framework
pseudos (`:deep()`, `::v-deep`, `:global()`, `::ng-deep`, `:host-context()`) pass through verbatim with a warning;
a leading BOM fails to parse (Turbopack relies on it); new serializations must parse in PostCSS tools.

## Bug classes other minifiers shipped (check each the diff can reach)

1. Every name reaching output goes through `serialize_identifier`/`serialize_name`, and token lists keep
   boundaries (`+`, `/` then `*`, comments, a unit `e<digit>`): test `\7d`, `\:`, `\31 `, `1e\32`, `x//**/*y`.
2. Strings stay strings: no `</style` from an escape (inline `<style>`); a quoted name equal to a keyword
   (`"revert-rule"`, `"inherit"`) stays quoted in `font-family` and `@keyframes`; CSS-wide keyword lists need
   `revert-rule` (none in LightningCSS yet).
3. Buffering handlers emit unmatched properties at once, ahead of buffered shorthands, and can print an empty
   value after draining: prefixed shorthand + unprefixed longhand in both orders, then `expect: idempotent`.
4. Generated `var()`, `:is()`, `:lang()`, `@supports` are valid only in some contexts: not in `@property`
   `initial-value`, descriptors, `@keyframes` selectors, `:host()`/`::slotted()` arguments.
5. Invalid stays invalid: the most common class elsewhere. Merging non-adjacent rules is the largest.
6. Cost: `try_parse` chains, selector-list nesting lowering and per-prefix reprinting of nested rules can go
   exponential. Generators: unclosed `calc(100vh - ` or `rgb(1 2 3 / ` ×n, `light-dark(` ×n in a custom property,
   `a,b{` nested ×n at chrome 100, `:fullscreen{` nested ×n at safari 8. Run base and head at n = 18 and 22: ×16
   per +4 levels is the signal; a new timeout fails R1.

Sass output (every consumer compiles Sass first; LightningCSS never parses it): `expanded` + non-ASCII adds
`@charset`, which LightningCSS drops while printing escapes as raw UTF-8; `compressed` adds a leading BOM, which
`bundle()` moves mid-output so browsers drop the next rule; `&__elem` in plain CSS is a type selector; `*zoom`,
`\0` hacks fail strict parsing and vanish under recovery.

Real-world `r-*` cases: most files already change on a second pass on base, so R2 there is pre-existing unless
base was stable for that file and mode: say which.

## Reproducing a consumer in a probe

Headers carry targets and flags, not include/exclude, second passes or patches: name that gap. Use `mode: lower-minify` with the targets above; Tailwind:
`flags: error-recovery, custom-media, deep-selector-combinator` plus `expect: idempotent` (only a pass-2
parse error breaks it); Turbopack: `error-recovery, css-modules`; Rsbuild: assert output text;
Bun's port: edge 80, firefox 78, chrome 80, safari 14, opera 67.
