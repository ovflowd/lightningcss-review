# sourcemap checklist (MAP)

Mapping and position accounting in `src/printer.rs` (`add_mapping`, `write_str`, `write_char`, `write_str_with_newlines`), input maps, bundler maps, CLI `--sourcemap`, the `sourcemap` feature. Corpus deltas compare code only: map behavior needs tests that decode mappings.

- [MAP-01] (MAJOR) Generated columns count UTF-16 code units (what `Location.column` documents) on every write path: `write_str` adds bytes and `write_char` adds 1 per char, so non-ASCII text before a mapping shifts later columns on that line.
  verify: a test with non-ASCII selectors or strings before a later rule asserting the decoded line and column of a known token.
- [MAP-02] (MAJOR) Every path writing raw text that can contain newlines (comments, token lists, unknown or custom at-rule bodies) uses `write_str_with_newlines`; `write_str` stays newline-free and cheap.
  verify: grep the diff for `write_str` of source text; a decoding test like `test_source_maps_with_license_comments`.
- [MAP-03] (MAJOR) Each rule type the PR adds or prints calls `add_mapping` with its original `loc` (1-based column becomes 0-based), including rules created by lowering (nesting, `:dir()` rules, `@supports` fallbacks), which map to their source rule.
  verify: grep for new `ToCss` impls on rules without `add_mapping`; a test decoding the new rule's position.
- [MAP-04] (MAJOR) Bundled and chained maps are consistent: a stylesheet's `source_index` equals its index in `sources`, order is stable across runs, `inputSourceMap` and inline `data:` maps remap positions (also input maps without `sourcesContent`), and no source appears twice (a sheet carrying a `data:` map is not also its own source).
  verify: `bundler::tests::test_source_map` and `test_input_source_map`; a node bundle test with `sourceMap: true`, run twice.
- [MAP-05] (MAJOR) CLI `--sourcemap` writes a usable pair: `sourceMappingURL` is relative to the CSS file, and the `.map` is written after the output directory exists.
  verify: `tests/cli_integration_tests.rs` sourcemap cases plus one with a nested, non-existent output directory.
  covers: src/main.rs, tests/cli_integration_tests.rs
- [MAP-06] (MAJOR) No behavior depends on state that only `add_mapping` updates (`Printer.loc`, also read by CSS-module hashing), and source-map code is `#[cfg(feature = "sourcemap")]`.
  verify: `cargo check -p lightningcss --no-default-features --features visitor`; read the printer diff.
- [MAP-07] (MAJOR) User-visible locations keep their conventions: Rust `ErrorLocation.line` 0-based and `column` 1-based, JS `loc` 1-based for both, dependency `loc` at the token after whitespace, `StyleRule::property_location` (re-parses the rule) still matching.
  verify: node tests asserting error and dependency `loc`.
- [MAP-08] (MAJOR) The PR's source-map tests decode positions (original line and column of a generated token), not only that a map exists or equals a fixture.
  verify: read the tests; `test_input_source_map` is a model.
- [MAP-09] (MINOR) Mapping work stays off the hot path: no per-char scan in `write_str`, no source-content copy or allocation per mapping. Benchmarks do not enable source maps.
  verify: time a large file with `sourceMap: true` on base and head release builds.
