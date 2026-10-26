# perf checklist (PERF)

Speed, memory and size: benches, hot code (`try_parse` chains, `CssRuleList::minify`, handlers, `Printer::write_*`, napi conversion). Apply when a PR claims a speedup or touches a core file. P1/P2 (optional `lcr perf`) measure no-target CLI minify time and binary size; the adapter's per-request timeout turns a hang into R1.

- [PERF-01] (MAJOR) Work stays linear in nesting depth: no new recursive parse or print path without a depth bound, and no `try_parse` alternative that re-parses the same nested arguments once per alternative (k alternatives over depth d cost k^d: `atan2()` args try five types in turn, TokenList tries `UnresolvedColor` first; only TokenList has a depth bound, `MaximumNestingDepth`).
  verify: generate inputs nested n deep in the touched construct (`calc(` ×n, nested functions, nested rules) and time base vs head at n=18 and n=22: growth ×10 or more per +4 levels is the signal; probes calc-math/nested-sum-stack-overflow, nesting/host-amp-nested-rule-no-stack-overflow.
- [PERF-02] (BLOCKER) Caches and hash-keyed indices stay consistent and deterministic: a key cached at insert is removed or recomputed when its rule is mutated or popped, a slot never matches itself, and neither HashMap iteration order nor a per-process hash seed reaches output.
  verify: probes rule-merging/*stale-dedup*, rule-merging/dedupe-stale-index-drops-rule; run the corpus twice and compare.
- [PERF-03] (MAJOR) A change presented as performance-only is output-neutral: zero deltas in every source, or each output change listed and justified on its own.
  verify: delta counts per source in the `lcr review` log; probe rule-merging/adjacent-media-coalesce-important.
- [PERF-04] (MINOR) Rule-list and declaration passes stay linear: no backward scan over `dest` or `rules` per item (check `dest.last_mut()` instead), no re-minification of an already minified list, no per-item collection rebuild.
  verify: read loops in the diff; time a generated sheet with 2000 and 4000 repeated rules on base and head.
- [PERF-05] (MAJOR) Lowering keeps output size linear in input nesting: nested prefixed selectors are not re-printed once per ancestor prefix pass, and nested selector lists do not expand into cross products where `:is()` is available.
  verify: nested-input generators (`:fullscreen{` ×n at an old Safari, `a,b{` ×n with targets) at n=16 and n=20, head output not larger than base; probe nesting/prefixed-nested-selector-no-duplication.
- [PERF-06] (MINOR) No new per-item allocation or hashing on the minify path: no `to_css_string()` per selector or declaration, no `HashMap`/`IndexSet` where a `Vec` works, expensive work only inside `or_insert_with`, early return when targets need nothing.
  verify: read the diff; risk flag `added-clone-heavy`.
- [PERF-07] (MINOR) Printer hot paths (`write_str`, `write_char`, `whitespace`, `delim`, `newline`, `write_ident`) gain no scanning, allocation or rare-case branch; rare cases get their own function.
  verify: read the src/printer.rs diff.
- [PERF-08] (MINOR) Hot value types keep their size: rare or large variants stay boxed (`CssColor` boxes everything but 8-bit RGB), and unboxing or growing a common enum (`CssColor`, `Property`, `Length`, `Calc`) reports `size_of` before and after.
  verify: `size_of` on base and head.
- [PERF-09] (MINOR) Speed claims are measured on the changed path in release builds: CodSpeed and `lcr perf` time only no-target parse/minify, so lowering, source maps, CSS modules, bundling, dependencies and visitors need their own base/head timing.
  verify: time base and head release CLI with `--targets`, `--sourcemap` or `--css-modules`, or a node script, on realworld files.
- [PERF-10] (MINOR) JS bindings add no copy or crossing per call: results built without an extra serde pass, visitor hooks only for kinds the visitor declares (`visit_types()`), resolvers crossing into JS once per import.
  verify: node timing of `transform` and `bundleAsync` on a large file, base vs head.
- [PERF-11] (MINOR) Benchmarks stay comparable: existing fixtures and groups keep their inputs, and a fixture for a new optimization lands apart from it.
  verify: diff benches/ and bench.js.
- [PERF-12] (MINOR) AST nodes gain no per-value storage (locations, cached strings, owned source copies), and parsers keep borrowing `CowArcStr` instead of allocating `String`s.
  verify: read new struct fields and `to_owned()`/`to_string()` calls in the diff.
