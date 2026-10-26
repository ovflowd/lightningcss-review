# supports-container checklist (COND)
Covers `src/rules/{supports,container}.rs`, `src/properties/contain.rs`, `TargetsWithSupportsScope`, conditional merges in `CssRuleList::minify`. Spec: `references/spec/cascade-conditional.md`. Probes: `supports-container/` unless prefixed.

- [COND-01] (BLOCKER) Valid `@container` syntax parses in strict mode as written: name-only, `style()` (plain, boolean, range), `scroll-state()`, `var()`/`env()` in features, general-enclosed and condition lists stay typed or raw tokens, never an error or another query.
  verify: probes style-query-*, container-*general-enclosed, container-condition-list, container-query-var, scroll-state-*; CO5#container-rule.
- [COND-02] (BLOCKER) `@supports` keeps its boolean structure: prefixed variants of one declaration combine into `((-webkit-p:v) or (p:v))` only alone or in an `or` chain, an `and` never becomes `or`, each operand keeps its own prefix (no merging "minus prefix"), and `not`/`and`/`or` keep a following space.
  verify: probes supports-*prefixed*; O3; CO3#typedef-supports-condition.
- [COND-03] (BLOCKER) No condition is evaluated from feature data (never dropped, unwrapped or simplified because targets support it; two-valued `@supports` logic never mixed with Kleene `@media` logic). The only rewrite is target-driven prefix expansion (`set_prefixes_for_targets`): idempotent, no duplicated prefix, values, `selector()` and unknown features byte-identical. Changed expansion under `not` is NEEDS_MAINTAINER_DECISION.
  verify: mutations retarget-modern, retarget-none (rule survives), prefixed-sibling with wrap-supports; probes supports-selector-argument-kept-verbatim, supports-not-general-enclosed-is-true; R2.
- [COND-04] (BLOCKER) `style()` values of unregistered custom properties print verbatim; only standard-property values may be minified (re-parsing through the property parser canonicalizes tokens).
  verify: probe style-query-custom-property-value-not-minified; CO5#style-container; latest engines only.
- [COND-05] (MAJOR) Fallback suppression inside `@supports` (`get_supported_features`) covers only features an `and` chain or single declaration guarantees: `not`/`or` keep every fallback in minify and print, and no generated `@supports` rule has an empty selector list.
  verify: mutation wrap-supports with targets; probes tailwind-property-polyfill-gates, nesting/supports-fallback-empty-selector.
- [COND-06] (MAJOR) errorRecovery changes neither output nor warnings for valid input (bundlers fail builds on warnings): name-only `@container` and new query functions are not routed through recovery, and no `dbg!`/`println!` is added.
  verify: probes *name-only*error-recovery*; diff `warnings` in `<run>/corpus/outputs-{base,head}.jsonl`; grep the diff.
- [COND-07] (BLOCKER) Rules merge on conditions only when adjacent in output and `SupportsCondition`/`ContainerCondition`/`ContainerName` are exactly equal; the merged list re-minifies idempotently and keeps both sides' `!important` and custom-property rules.
  verify: probes rule-merging/{no-media-merge-across-intervening-rule,adjacent-media-coalesce-important}; mutation duplicate-nonadjacent; R2.
- [COND-08] (MAJOR) Container conditions are never range-lowered or unit-converted for any target, and a change to the `QueryFeature`/`QueryCondition` code shared with `@media` is tested on `@container`.
  verify: mutation retarget-legacy on container cases (output keeps `width>=`); S1 when `src/media_query.rs` changes.
- [COND-09] (MAJOR) A container condition list stays a list (each name selects its own container; never one `or` query, nested `@container` never merged into one condition); AST changes reach serde, visitors, `ast.d.ts`.
  verify: probe container-condition-list (no engine ships lists: assert output); B11.
- [COND-10] (MAJOR) `container`/`container-type`/`container-name` serialize per CO5 (`none / size` keeps `none`, `normal` type omitted, `inline-size scroll-state` valid), and CSS modules rename the `@container` prelude and every `container-name`/`container` value together.
  verify: probe container-shorthand-keeps-none-name; O7; CO5#container-shorthand.
- [COND-11] (MAJOR) Unknown conditional at-rules (`@when`/`@else`, `@supports-condition`) are kept verbatim and in place, also in style rules, and nothing prints between an `@when` and its `@else`.
  verify: PR probe `@when media(width >= 1px){.t{color:red}} @else{.t{color:blue}}` with `output-contains:"@else"` (no engine ships them).
