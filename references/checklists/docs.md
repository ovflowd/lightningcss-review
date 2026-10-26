# docs checklist (DOCS)

`website/pages/*.md`, `website/*.html`, the playground, `README.md` (also shipped as wasm/README.md), `CONTRIBUTING.md`, rustdoc, doc comments in `node/index.d.ts`. No CI job builds the site and the oracle never reads docs: evidence is reading, grep and PR probes made from doc examples. Credit fixes of existing mismatches; do not count them against the PR.

- [DOCS-01] (MINOR) Every example the PR adds or edits runs as written on head: JS imports what it uses with option keys that exist in index.d.ts, CSS parses, and each shown result is head's output for the stated options and targets, modulo whitespace.
  verify: one probe per changed CSS example with its mode and targets, compared via `lcr show <run> p-…`; JS snippets run with node.
- [DOCS-02] (MINOR) A new or renamed option is documented on the page that owns it (docs, transpilation, minification, css-modules, bundling, transforms) with its JS key, CLI flag and default, matching its index.d.ts doc comment.
  verify: grep website/pages and README.md for the key.
- [DOCS-03] (MINOR) Docs describing behavior the PR changes are updated in the same PR, and sentences about defaults and semantics match the code path (e.g. `minify` only configures the printer; `transform()` always runs `StyleSheet::minify`).
  verify: `grep -rn '<name>' website/pages README.md` for each changed name; read the code behind each changed sentence.
- [DOCS-04] (MINOR) Lowering docs state what the output requires and where it approximates: nesting emits `:is()`, `light-dark()` needs `color-scheme` on an ancestor and resolves where a custom property is defined, `:dir()` becomes a `:lang()` heuristic, logical lowering assumes horizontal writing; a lowering with a `Features` flag is listed so users find the opt-out.
  verify: compare the changed section with the lowering code.
- [DOCS-05] (MAJOR) Documented API behavior keeps working unless the PR declares the break: transforms.md visitor and custom at-rule examples, the bundling.md resolver contract, css-modules.md configuration, transpilation.md option examples.
  verify: B5 (visitor, customAtRules and bundle node tests); probes for the documented CSS examples of the touched feature.
- [DOCS-06] (MINOR) Hand-maintained lists match their source in the head tree: Feature flags vs node/flags.js, syntax lowering sections vs what targets lower, pseudo-class replacement vs `OwnedPseudoClasses`, non-standard and draft syntax vs napi `NonStandard`/`Drafts` and `ParserFlags`, README feature lists, the playground's draft checkboxes.
  verify: diff each list against its source.
- [DOCS-07] (MINOR) Draft and non-standard syntax is labeled as such, with the JS key, CLI flag and a spec link to the level that defines it; a standard feature is not called a draft.
  verify: the page diff against `ParserFlags` and napi `Drafts`.
- [DOCS-08] (MINOR) Links and anchors resolve: a renamed heading changes its markdown-it-anchor slug, so in-page and cross-page links to it break; changed external links open.
  verify: grep website/pages, README.md and node/*.d.ts for the old slug.
- [DOCS-09] (MINOR) Rust docs stay correct: new `pub` items have `///` docs (`#![deny(missing_docs)]` fails the build otherwise), feature-gated items keep `doc(cfg(...))` under `docsrs`, doc tests compile, docs naming a removed cargo feature are updated.
  verify: `cargo doc --all-features --no-deps`.
- [DOCS-10] (MINOR) The website still builds and pages are reachable: a new page has a `website/<page>.html` stub including the layout and a nav entry; code blocks showing minified output are not reflowed by a formatter.
  verify: `yarn website:build`; read the website diff for reflowed fences.
- [DOCS-11] (MINOR) README text holds for both packages (the wasm package ships the same README), and CONTRIBUTING commands work on a fresh checkout with the pinned toolchain and `engines` Node version (plain `cargo test` skips `required-features = ["cli"]` tests; CI runs `--all-features`). Integration snippets match the tool's current API.
  verify: read the README diff; run the documented commands in the builder image.
- [DOCS-12] (NOTE) A docs-only PR changes no library output and does not duplicate an open or merged docs fix.
  verify: delta counts are 0; read-only `gh pr list -R parcel-bundler/lightningcss --state all --search '<topic>'`.
