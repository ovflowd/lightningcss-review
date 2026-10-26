# media-queries checklist (MQ)
Covers `src/media_query.rs` (its query code is shared with `@container`), `src/rules/{media,custom_media}.rs` and custom-media compilation. Spec: `references/spec/cascade-conditional.md`. Probes are under `media-queries/` unless prefixed.

- [MQ-01] (MAJOR) Range lowering is exact and parsable by every target that gets it: `>=`/`<=` → `min-`/`max-`; strict bounds and intervals use only syntax those targets parse (MQ3: `not all and (max-…)` or nested `@media`, never `not (…)`); no epsilons; integer features exact (`(color > 2)` → `(min-color: 3)`); ranges print name-first.
  verify: probes exclusive-range-lowering-must-be-mq3-parsable, range-lowering-mq3-compatible, negated-negative-range-stays-true, prefixing-compat/opera-desktop-media-range-lowered; mutation engine-legacy-2021 with O3/O4.
- [MQ-02] (MAJOR) Lowered and negated queries are grammatical for every feature combination (range lowered without interval lowering, nested `and`/`or`/`not`): parentheses come from `needs_parens` at print time and keywords keep the space before `(`; changes are tested in print, minify and lower modes and on `@container`.
  verify: probes range-lowering-parens, not-range-interval-lowering; O3; include/exclude only via PR tests (probes cannot set them).
- [MQ-03] (BLOCKER) `not` negates the whole query: `not (cond)` folds only through exact negations (`<` ↔ `>=`, `not not X` → `X`), `not (w = X)` is kept or becomes `(w < X) or (w > X)`, and `not <type> and <cond>` never negates the type alone.
  verify: probes not-range-equality-negation-dropped, not-equal-range; mutation wrap-media; MQ4#mq-not.
- [MQ-04] (MAJOR) Invalid queries stay invalid and valid ones parse: `(min-*)` in boolean context, unitless non-zero lengths, `min-`/`max-` on discrete features and type mismatches are never rewritten into valid queries (also in `@container`); `resolution: infinite`, `(min-width: 0)` stay accepted.
  verify: probes min-*, unitless-nonzero-length-is-invalid; WPT css/mediaqueries/test_media_queries.html; O3.
- [MQ-05] (MAJOR) Error handling is per query: under errorRecovery an invalid query or general-enclosed prints verbatim and the rest of the list stays live; valid input gives the same output and no warnings; strict mode errors instead of dropping or rewriting.
  verify: probes error-recovery-keeps-rest-of-query-list, general-enclosed-calc-error-recovery; diff `warnings` in `<run>/corpus/outputs-{base,head}.jsonl`; MQ4#error-handling.
- [MQ-06] (BLOCKER) An empty list never prints `not all` in any printer mode; always-true `@media` is unwrapped only by the compact printer (in a style rule only where equivalent); a rule is removed only for an empty body or an exact `not all`; dead-query pruning is exact over units, `not`/`only`, types, unknown features.
  verify: probes empty-media-* (print); MQ4#mq-list.
- [MQ-07] (MAJOR) Custom media compile logically: a list inside `and` becomes `(a or b)`, negating a query with a type negates the type (or errors), no type is hoisted out of an `or`, `true`/`false` are keywords, undefined or cyclic names give `not all`, and every reference (nested `@media`, `@import` media) is substituted before the definition is removed.
  verify: probes custom-media-* (no engine ships it: output assertions); MQ5#custom-mq.
- [MQ-08] (MAJOR) `MediaList::and`/`MediaQuery::and` (bundler, nested imports) are a logical AND or an error: a `not` query is never combined into `not T and (cond)`, and lists AND as a cross product.
  verify: no bundle mode in probes: add `src/bundler.rs` tests for `not print` and two-query lists; MQ4#mq-not.
- [MQ-09] (BLOCKER) Media types, feature names and custom media names print through `serialize_identifier`, so escapes survive and output never closes the block early.
  verify: probe custom-media-type-name-escaped; R2.
- [MQ-10] (MAJOR) Feature values keep meaning and stay target-parsable: no `em`/`rem` → `px`, exact `calc()`, shorter forms (`1/1` → `1`) only where targets parse them.
  verify: PR probe `@media (min-width:50em){.t{color:red}}` with `output-contains:"50em"`; MQ4#units; O3 with legacy targets.
- [MQ-11] (MAJOR) Resolution lowering converts `dpi`/`dpcm` to `dppx` exactly, adds prefixed device-pixel-ratio queries only as extra list entries (false where unknown, also under `not`), prints `x` only where supported, and adds nothing on a second pass.
  verify: mutation retarget-legacy on resolution cases; R2; O3.
