# Maintainer playbook: how Devon Govett reviews LightningCSS

What `devongovett` checks, asks contributors to change, rejects and ships. Sources: his 49 PRs, 790 non-merge
commits on master (369 read in detail), his text on 143 of the 234 PRs he commented on or reviewed, 196 merged
community PRs, discussion #1241. `#N` = parcel-bundler/lightningcss pull or issue N; hex = commit;
`file:line` at master `cbeaf83` (v1.33.0 + 14). Quotes, SHAs, PR states and lines re-verified 2026-10-26;
where older research notes disagreed with the code, the code wins.

**Context.** Devon commits/year 2021-2026: 234, 287, 140, 72, 27, 30. Community merges/year 2022-2026: 57,
32, 31, 27, 45; he merged 193 of the 196 himself and pushed his own commits onto 29 (15%) first ("Apply
suggestions" #255, "Handle more cases" #850). "I could use some help with maintenance" (#1241). His bottleneck:
"verifying correctness... I usually need to verify against the spec, test against browser behavior, etc."
(relayed privately; SKILL.md quotes its first sentence).

## 1. Philosophy (#1241, 2026-05-17) and how he enforces it

1. **Fully parse all syntax.** "this is key to Lightning CSS's performance, minification, and correctness."
   He asks for typed values, not `TokenList` / `DeclarationBlock` (#840, #1218, #1160). A value that fails
   to parse is kept as unparsed tokens so new syntax passes through ("if a property fails to parse, it is
   stored as raw tokens", #255; #1329 "we still fall back to preserving the raw css tokens"). → GEN-19, GEN-03
2. **No non-standard syntax.** "Non-standard rules and properties can be passed through in the
   `errorRecovery` mode, as long as they are valid CSS syntax. Other syntax extensions should not be
   supported" (#1241); on #1240: "it is not a goal of the project to support non-standard syntax
   extensions like PostCSS does". Opt-in exceptions only: CSS modules, `>>>` / `/deep/` behind
   `ParserFlags::DEEP_SELECTOR_COMBINATOR` (99e1a2e; JS `nonStandard.deepSelectorCombinator`). → GEN-04
3. **Spec decides semantics; target browsers decide what may be emitted.** "CSS correctness is one thing.
   It is another thing entirely to account for 10 year old browser bugs." (#1121); "The CSS spec is the only
   sane source of truth." (#1157). Yet output must parse in the targets: string animation names reverted,
   "Chrome doesn't support it yet" (6e47cdb); `1x` kept in `image-set()` since Safari lacks `type()` (#264).
   → GEN-05, GEN-06
4. **Limit hacks for very old browsers.** "Generally target browsers that people actually use." (#1241). At
   most gated on targets ("check the targets and see if the minimum version is below that", #1121, Chrome
   49). Wrong compat data gets a justified override in `scripts/build-prefixes.js` (§2.3). → GEN-17
5. **Drafts behind runtime flags.** "Draft syntax (e.g. only supported in Chrome) is subject to change...
   Put these behind draft feature flags" (#1241). Runtime, not cargo: "we should use the `drafts` option for
   this... we can expose this to the JS API" (#808). Asked for `@scope` (#425) and
   `:target-before/after/current` (#1185 → `ParserFlags::SCROLL_NAVIGATION_CONTROLS`, `src/selector.rs:154`).
   Cost of not flagging: relative colors shipped unflagged, csswg-drafts#7876 changed them, and #465 waited
   2023-04 to 2025-05 as a breaking change. → GEN-02
6. **Don't break users.** New behavior opt-in, new options default to current behavior: #324 ("it might be
   weird if we suddenly started compiling differently"), #739 ("These should probably default to true"),
   #1287 ("people are relying on it anyway"). → GEN-22
7. **No whole-program assumptions.** He closed his own unused-variable removal: "Variable names are global...
   Also code splitting might break it" (#58). Bundling external and internal imports "will change the
   behavior of the CSS" (#880).
8. **Performance and binary size are features.** "Do you have a benchmark for this? It was originally boxed
   to reduce the size of CssColor" (#1332); "`write_str` is very hot" (#971); #1305 cut the CLI 678 KB (14%).
   CodSpeed runs on every PR (`.github/workflows/codspeed.yml`, #1243). → GEN-21
9. **Error recovery mirrors browsers.** "Lightning CSS implements error recovery exactly how browsers do -
   by ignoring invalid rules." (#1240). Unknown pseudo-classes stay warnings (#1185, #1203).
10. **Understand what you submit.** "Understanding the code you're submitting is very important" (#1241). His
    AI-built harness #1328: "I have not yet verified its output."

## 2. Codebase conventions

### 2.1 Where things live

| What | Where (cbeaf83) |
|---|---|
| Property registry | `define_properties!` `src/properties/mod.rs:1202` (`"name": Variant(Type, VendorPrefix) / WebKit [logical_group, category] shorthand: true`); types and handlers in `src/properties/<area>.rs` |
| Generic values | `NonNegative<T>` `src/values/number.rs:55`, `Size2D<T>` `src/values/size.rs:18`, `Rect<T>` `src/values/rect.rs:20` |
| At-rules | `src/rules/<name>.rs`; `CssRule` `src/rules/mod.rs:141` (+ serde, `to_css`, minify arms); `AtRulePrelude` `src/parser.rs:199`, `allowed_in_style_rule` `:262` (nestable), `NestedRuleParser::parse_prelude` `:572` / `parse_block` `:790`; JS visitor name `napi/src/transformer.rs:294` |
| Selectors | forked `selectors/` (`parcel_selectors` 0.28.3) + `src/selector.rs` |
| Minify | rules: `CssRuleList::minify` `src/rules/mod.rs:599`; declarations: `DeclarationHandler` `src/declaration.rs:543` |
| Handler context | `src/context.rs`: `should_compile_logical` `:74`, `add_logical_rule` `:84`, `get_additional_rules` `:93`, `add_conditional_property` `:158` |
| Targets / compat | `src/targets.rs` (`Features`, `TargetsWithSupportsScope` `:257`, `should_compile!` `:317`); generated `src/compat.rs` (`Feature::X.is_compatible` `:237`), `src/prefixes.rs` |
| Drafts | `ParserFlags` `src/parser.rs:52`; JS `drafts` → napi `Drafts` `napi/src/lib.rs:666`, wired for transform `:701` and bundle `:835`; TS `node/index.d.ts:272` |

### 2.2 Handler patterns

- `PropertyHandler::handle_property(..) -> bool` + `finalize` (`src/traits.rs:141`). `DeclarationHandler`
  tries handlers in a fixed order (`src/declaration.rs:578`) and flushes them in that order (`:695`).
  Handled properties are buffered and emitted at flush, so output order differs from input order across
  handler groups: safe only for independent properties.
- **Flush on `Property::Unparsed`**: a `var()` or unknown value must flush buffered values first (22a8b6f
  #805, da3aeb8 #504). Also flush when another prefix carries a different value (`maybe_flush!`,
  `src/properties/animation.rs:748`), and when a new value differs and is incompatible with the targets,
  so the old one survives as fallback (border/background/font handlers, 981175b).
- Logical: `context.should_compile_logical(Feature::X)` (never in style attributes, `src/context.rs:74`),
  then `add_logical_rule(ltr, rtl)`; generated rules go between a rule's declarations and its nested rules
  (e66d99c, #175). Conditional fallbacks: `add_conditional_property` → `@supports` (27e4a3d, #95).
- Shorthands: `shorthand_handler!` `src/macros.rs:207`, `define_shorthand!` `:331`, `define_list_shorthand!`
  `:559`, `enum_property!` `:1`; order-free shorthands parse in a `loop` over longhands (#304, `flex.rs`);
  hand-written `Parse` when longhands share keywords (`list-style` + `none`, e3b1e88). Enums:
  `#[derive(Parse, ToCss)]` (76e31cf). `try_parse` only for optional parts (#787).
- Serialization: cssparser `serialize_string` / `serialize_identifier` / `serialize_name`, never hand quoting
  (#267, #1064, #1237). Unitless zero prints `0` except in calc (`src/values/length.rs:493`).
- Public types carry `cfg_attr` derives for `visitor`, serde (`tag = "type", content = "value", rename_all =
  "kebab-case"`), `jsonschema`, `into_owned`, plus `///` docs with a spec link (`#![deny(missing_docs)]`).
- No `unwrap()` / `unreachable!()` on user input: fallible color conversions (20c9612, #522), `TryFrom`
  for calc (4ebcb45). `IndexMap` wherever output order shows (#1355, `src/css_modules.rs:256`; d4eec35).

### 2.3 Generated files (never hand-edited; review the generator diff)

| File | Generator | Run |
|---|---|---|
| `src/compat.rs`, `src/prefixes.rs`, `node/targets.d.ts`, `node/flags.js`; in `src/targets.rs` only `struct Browsers` and `struct Features` (regex-replaced, `scripts/build-prefixes.js:528-533`) | `node scripts/build-prefixes.js` ("DO NOT EDIT!") | each release (`update compat data`) and in PRs adding a compat feature (`mdnFeatures`) or a `Features` flag (`flags` array `:486`; 3043896) |
| `node/ast.d.ts` | `yarn build-ast` | each release (`update ast`) and AST-changing PRs ("Could you run `yarn build-ast`...", #703) |
| `node/index.js.flow` | `scripts/build-flow.js` (in `yarn build`) | why TS overload tricks were declined (#204: "Does not appear to work with flow.") |
| `node/index.d.ts` | hand-written | he often adds missing option docs after merge (eb49015, c82e7d7) |

Compat: versions are `major << 16 | minor << 8 | patch`. Overrides in `build-prefixes.js` cite the bug
(clip-path `:45`, `::marker` WebKit 204163 `:213`, `:state()` 125+ `:351`). "partial support should not
imply full support" (#1306): filter `partial_implementation` in the generator (`:271`), not in Rust. Prefix
data is autoprefixer's; he defers to it (#492). A new lowering usually gets a `Features` flag users can
`exclude` (#1287, 3043896).

### 2.4 Tests: where, and which helper

In `src/lib.rs` (117 `#[test]` fns, one `fn test_<area>()` per area: `test_font`, `test_selectors`,
`test_color`, `test_nesting`, ...; cross-area regressions get their own: `test_layer_order_across_rules`,
`test_duplicate_rules_preserve_importance`). "lib.rs has most of them... add a test to the `test_font`
function" (#182). Lines opening with a call at cbeaf83: `minify_test` 1,766, `test` 797, `prefix_test`
577, `error_test` 76, `nesting_test` 65, `css_modules_test` 42, `property_range_test` 41, `custom_media_test` 19.

| Scenario | Helper (`src/lib.rs`) | Pipeline (verified) |
|---|---|---|
| Serialization / minification | `minify_test` `:164`; `_with_options` `:169`, `_with_options_and_browsers` `:174` | parse, `minify()`, print `minify: true` (targets only in the `_browsers` form) |
| Pretty output, merging | `test` `:77` + `indoc!` | parse, `minify()`, pretty, no targets |
| Lowering, prefixes, fallbacks | `prefix_test(src, out, Browsers {..})` `:218` | targets on minify and print, pretty |
| Nesting | `nesting_test` `:261` (Chrome 95), `nesting_test_with_targets` `:274`, `nesting_test_no_targets` `:296` | lowered vs preserved |
| CSS modules | `css_modules_test(src, css, exports, refs, Config, minify)` `:347` | asserts exports and references |
| `@custom-media` | `custom_media_test` `:388` | `CUSTOM_MEDIA` flag, minify with Chrome 95, print without targets |
| Must fail | `error_test` `:416`, `error_test_with_options` `:424`, `css_modules_error_test` `:458`, `minify_error_test_with_options` `:203` | |
| Recovery warnings | `error_recovery_test(src) -> Vec<Error>` `:432` | |
| Style attribute | `attr_test(src, out, minify, targets)` `:240` | |
| Range-restricted values | `property_range_test(&["prop"], &[(in, Some(out) or None)])` `:102`, `non_negative_test` `:82` | `None` = must stay `Property::Unparsed` |
| Deps, bundler, CLI | `dep_test` (`test_dependencies`), `mod tests` in `src/bundler.rs` (`fs!` `:944`), `tests/cli_integration_tests.rs` | |
| JS API, visitors, bundle | `node/test/*.test.mjs` (uvu) | CI reruns with `TEST_WASM=node` / `browser` (`test.yml:62-63`) |

Idiom, from `test_text_size_adjust` (`src/lib.rs:16958`, condensed): range check, minify, both directions.

```rust
property_range_test(&["text-size-adjust"], &[("-1%", None), ("calc(-1%)", Some("0%"))]);
minify_test(".foo { text-size-adjust: none }", ".foo{text-size-adjust:none}");
prefix_test(/* .foo { text-size-adjust: none; } */, /* -webkit-, -moz-, -ms-, then unprefixed */,
  Browsers { ios_saf: Some(16 << 16), edge: Some(15 << 16), firefox: Some(20 << 16), ..Browsers::default() });
prefix_test(/* all four spellings */, /* only text-size-adjust: none */,
  Browsers { chrome: Some(110 << 16), ..Browsers::default() });
```

Habits: both orders for ordering bugs (22a8b6f, 28bf5af); loops over property or pseudo lists with
`format!` (63c4e24); hand-ported WPT cases with a link comment (`src/lib.rs:20295`); issue repros pasted
as-is (e3c8e12). CI: `RUSTFLAGS: -D warnings`, `cargo test --all-features` (`test.yml:18,24`). CI's
`cargo fmt` (`test.yml:23`) has no `--check`, so unformatted code passes CI; harness B3 is stricter
(`rustfmt.toml`: 2-space tabs, width 115).

### 2.5 Naming and style

- Commit subjects: imperative, sentence case (90%; chores lowercase: `update ast`), no prefix (`Fix layer
  merging ordering`); body `Fixes #N` / `Closes #N`, often several, plus a rationale paragraph for
  philosophy-level changes (32f1f52). Releases are exactly `vX.Y.Z`. He merges community `fix:` / `feat:`
  titles as-is (a7c5cdc), so a prefix is not a finding.
- Options: JS camelCase (`dashedIdents`); CLI opt-in flags (`--browserslist`); to turn a default off he
  asked for `--no-x` ("that naming convention for CLI flags is more common", #324; none exist yet);
  `drafts: {x}` ↔ `ParserFlags::X`; Rust `Features::PascalCase`.
- Code comments cite spec URLs and csswg issues, sometimes browser source (68aa48d).

## 3. What he asks contributors to change (ranked by frequency)

| # | Ask (≈PRs) | Strongest citations |
|---|---|---|
| 1 | **Handle the case you did not consider**, sibling paths too (≈11) | #838: "it assumes that all unparsed properties are valid and supported by all browser targets"; #832: "This won't combine multiple numbers, e.g. `calc(100% - 300px - 2 - 3)`"; #1323: EPSILON "also widens the black/white cutoffs... `oklch(99.995% .01 0)`"; siblings: #267 (`AnimationName` too), #936 ("Do we need to adjust these angles as well?") |
| 2 | **Reuse existing types, macros, serializers, options** (≈10) | #294: `Size2D<Length>` "already handles the parsing and omitting of the second value"; #1237: "The Printer already uses `serialize_identifier`", "Seems confusing to have two ways of doing the same thing?" |
| 3 | **Implement the grammar exactly** (≈8) | #264: "`[ <resolution> \|\| type(<string>) ]` which means that either a resolution or a type is required"; #957: "Is this actually supported? The spec seems to suggest that only the functional form is allowed."; #808 (optional `<target-contrast>`) |
| 4 | **Don't break existing users** (≈8) | #324, #739, #1287; pragmatic: "Technically, this is a breaking change but I think we can get away with it." (#192); Rust signatures may change: "the crate is still under pre-release" (#880) |
| 5 | **Keep hot paths fast** (≈7) | #971 (rare case out of `write_str`); #878 (Vec stack, "avoid the hashing cost of IndexSet"); #1339: "introduces quadratic behavior" |
| 6 | **Root cause or real use case first** (≈7) | #1231: "this seems to have more to do with there being a visitor... we should debug that"; #1240: "What's the real-world use case for this?"; #1157: "Could you create a reproduction" |
| 7 | **Add tests in `src/lib.rs`** (≈6) | #1102: "Can you please add a test?"; #182; #1323: "add a test for that case too" |
| 8 | **Parse into typed structures** (≈5) | #840: descriptor type, not `DeclarationBlock` ("things like `!important` shouldn't be allowed"); #1218: bitflags, parse `anchored()` with `position-try-fallbacks` types; #1160: compute `contrast-color()` at build time, decided in this PR ("It would change what gets stored in the AST") |
| 9 | **Cargo feature and dependency hygiene** (≈5) | #380: "Can you make this dep optional"; #361 broke `cargo build -p lightningcss-derive`, reverted in #381 |
| 10 | **Platform scope** (4 near-identical replies, 2026-07-20) | #1258, #1264, #1268, #1294: "We also have no way to test that it works... Can you just compile it from source?" |
| 11 | **Drafts behind runtime flags** (≈4) | #425, #808, #1185 |
| 12 | **Change the generator, not its output** (≈3) | #564: "Those types are generated by a script so I've gone ahead and updated that."; #703; #1306 |

Also: gate new errors by their mode ("Should we only error if CSS modules are enabled", #784); put special
cases at the call site, not in shared grammar code (#657).

## 4. What he rejects, and why

| Category | PRs | Reason |
|---|---|---|
| Non-standard syntax, PostCSS-style leniency | #1240, his #94 thread | "Lightning CSS will generally try to stick to standards" (#94) |
| Browser implementation details, old bugs | #1157 (closed), #1121 (open) | "It's not possible to test for that." (offered an opt-out option instead) |
| Dedupe dropping "redundant" fallbacks | #838 → 22a8b6f | an unparsed value may be unsupported in some targets |
| Whole-program assumptions | #58 (his own) | variables are global; code splitting |
| Options duplicating or redefining others | #1158 (closed), #1237 (open) | "I don't think this does what you think it does." |
| Default changes that break users | #1287 (open), #835 first draft | "Hashing container names is intentional." |
| Early or contested drafts | #1204 (closed), level-6 parts of #808 (per #1160) | "only supported in Chrome, and currently opposed by other vendors. We should hold off on adding it until the standard advances further." (#1203) |
| Untestable platforms | #651, #1258, #1264, #1268, #1294 | no hardware, no CI |
| Deprecated features, non-issues | #1299, #953, #101 | "looks deprecated"; "CSS identifiers are case insensitive."; omitted filter defaults are spec-valid |

He replaces contributor fixes with his own root-cause or class-wide one: #832 → e3c8e12 (all number chains),
#838 → 22a8b6f (root cause only: "For now, I'm just going to fix the immediate bug"), #332 → #343 (parens
computed at print time "ensures that any transforms that occur produce valid output"), #196 → #263. Review
for the class, not the input.

## 5. How he fixes bugs

1. Small change at the root cause plus a minimal repro in the area's test fn: one character (`rules[0]` →
   `rules[i]`, a8d909a, #525); one line (`self.flush(dest, context);`, 22a8b6f, "Fixes #805, closes #838").
   101 of his 136 commits with fix/bug/regression in the subject that touch `src/` or `selectors/` also
   change tests (74%).
2. Conservative over clever: 32aecd9 stops moving layer content across conditional groups or imports ("Do
   not move layer content across them without analyzing those contributions"); 32f1f52 keeps whitespace in
   token lists ("worse compression... but is more correct"); ddc9ce8 reduces `clamp()` only when the
   comparison is known.
3. Structural fixes that remove a class: no `InParens` (#343), `NonNegative<T>` (#1329), `TryFrom` (4ebcb45).
4. Reverts are rare (3) and mostly fast: 835e5bc after 5 days (81cd955, re-landed in #465), df280dc the next
   day (6e47cdb), #361 after 3 weeks (#381).

### 5.1 Regression classes in his history: what the review must exercise

Probe ids are Devon-fix guards (`known: none` unless noted; equivalence-based). `lcr baseline` at cbeaf83:
17 pass; `values-numeric/unitless-length-standards-mode` fails, as expected for open #682.

| Class | His fixes | Exercise with |
|---|---|---|
| Handler reorders declarations | #805 22a8b6f, #504 da3aeb8, #746 60622a1 | `reverse-decls`, `var-before`, `var-after`; `box-model-size/width-literal-then-var-order`, `rule-merging/all-shorthand-keeps-custom-props` |
| Non-deterministic order | #855 d4eec35, #1355 | R2, repeated runs; HashMap iteration in emit paths |
| Merge/dedupe changes cascade | #1347 + #1109 93b9e66 (unreleased), #525 a8d909a, #478 df1bae2 | `important`, `duplicate-nonadjacent`, `prefixed-sibling`; `rule-merging/dup-rule-keeps-importance` |
| `@layer` order | 33ea2c1 (imports), 32aecd9 (#974, unreleased) | `wrap-layer`, `wrap-media`; `cascade-layers-scope/layer-order-conditional-declaration`, `cascade-layers-scope/layer-sublayer-order` |
| Nesting | #356 6a7d19e, #175 e66d99c, #1089 9e04c01; open #1156 | `nest` with and without targets; `nesting/important-in-nested-media`, `nesting/nested-declarations-semicolon` |
| Selector lowering | ff4de2a (`:not()` lists), 31ce350 (`:is()` only if specificities equal), 284debf (unknown pseudo-elements out of `:is()`) | `selectors/not-list-lowering-specificity` |
| calc | #827 + #791 e3c8e12 (stack overflow), #836 ddc9ce8 (`clamp`) | number chains, nested math, mixed units; `calc-math/calc-repeated-clamp-no-overflow`, `calc-math/clamp-incomparable-max` |
| Color math | #446 c5fcb63 (gamut-mapping loop), #522 20c9612 (panic), #1323 (cutoffs) | boundaries, unresolvable inputs; `color/currentcolor-color-mix-no-panic` |
| Invalid shortening on print | #727 445def9, #283 84298d2, #120 facbffd, #125 3bdefdc, #127 6d46cce | O3, R2; `flex-grid-align/flex-unitless-zero-basis`, `font/generic-family-name-quoted`, `font/family-consecutive-spaces` (`fixed-by#1064`), `printer-serialization/custom-property-name-escape`, `transform/rotate-over-360-not-matrix` |
| Media lowering | #320 → #343 | `media-queries/not-range-interval-lowering` (`fixed-by#343`) |
| CSS-modules scoping | #883 (`:nth-child(of S)`), #194 (animation + `var()`), #129 (grid line names) | every ident position + exports map (output assertions, oracle L8) |
| Invalid input accepted | #1000 (fixed by #1329); open #682 (`src/values/length.rs:145` takes any number as px) | O7; `values-numeric/unitless-length-standards-mode` (`open-issue#682`) |
| Compat data | #77, #1306 (open, partial as full) | B11, `retarget-*` |
| Build, bindings | #361 → #381, wasm fixes (5a145da, 3822c49), #784 | B7-B10 |

## 6. Releases

- Sequence (v1.33.0, 2026-07-19): `update compat data` (e575845) → `update ast` (eda315f) → `v1.33.0`
  (1d680fa: `Cargo.toml`, `napi/`, `node/`, `selectors/` Cargo.toml, `package.json`, `Cargo.lock`) → tag
  on the next commit (c6a0c3c `bump rust toolchain`) → `release.yml` / `release-crates.yml`, both
  `workflow_dispatch` (manual). Notes: `## Added` / `## Fixed`, "by @user in <PR URL>".
- Version commits per year (tags): 2022 33 (31), 2023 12 (12), 2024 10 (9), 2025 7 (6), 2026 4 (3): v1.31.0
  01-19, v1.31.1 01-20 (untagged), v1.32.0 03-08, v1.33.0 07-19. Patches can carry small features
  (#1026 in v1.30.2).
- Regressions get a patch within days: #746 (from d7aeff3, v1.25.0) fixed in v1.25.1 a week later ("Yeah
  this is a bad bug, sorry about that... Will push a patch out asap"); #1137 (from 220b390, v1.31.0) fixed
  by f3666d6 in v1.31.1 the next day.
- Bursts: community merges cluster on single days (10 on 2026-05-17, 7 on 2026-01-20 UTC). 01-20 went
  straight into a compat refresh and v1.31.0; 05-17 waited for v1.33.0 (07-19).
- Unreleased on master: #1329, 93b9e66, 32aecd9, #1305, #1355, #1323, #1340, #1343, #1274, #1263, #1322,
  #1388. They are on both sides of an `lcr` run (base = master), but a PR's CI or text may predate them.
- Semver: npm is 1.x; the Rust crate is `1.0.0-alpha.72` (`Cargo.toml:15`) and Rust API changes are
  accepted (#880). `parcel_selectors` patch releases reach users unpinned: a new `SelectorParseErrorKind`
  variant broke trunk (#784: "I didn't realize it wasn't pinned... Will be more careful in the future.").
  Spec-driven breaking changes have shipped in minors (#465 in v1.30.0).

## 7. How to talk to the maintainer

From his review comments and his own PR descriptions. Use it to judge whether the PR, and the report,
already answer what he will ask.

**Evidence he wants up front, in this order**
1. What it fixes and the measured effect, as he writes it: "Fixes #1000. Also fixes over 600 web platform
   tests (run against #1328)." (#1329); "Reduces binary size of the CLI by 678 KB, or about 14%." (#1305).
2. Spec text with anchor, optional parts included, and its status. He quotes grammar himself (#264, #808),
   asks "Is this actually supported?" (#957) and for the spec's status (#808), and checks
   WebKit/Mozilla/TAG positions (#1185).
3. Minimal input with before/after output for each behavior change, plus the cases he will try (other
   order, `var()`, several selectors or values, boundary numbers). He reviews by counterexample (#838,
   #880, #1323, #1156).
4. Browser results for emitted syntax and for any claim about browsers: "Does that work in browsers?"
   (#264); "Could you create a reproduction where something is broken due to this optimization?" (#1157).
   He uses playground links himself (#1231).
5. The real need for new options or syntax: "What's the real-world use case for this?" (#1240); "Was there
   a reason you need this?" (#1158).
6. Numbers for performance claims: #1332 said "performance has also been optimized" and got "Do you have a
   benchmark for this?". Release builds, whole-script reruns (#652); CodSpeed (#1243).
7. For breaking changes, the options, as in his #465: "either we merge it and accept the breaking change as a
   'fix'..., make it opt-in..., or wait for a major version".
8. Tests in his idiom (§2.4) that fail on base.

**Tone of his reviews**
- Short and friendly; most approvals are empty or one line ("Thanks!", "lgtm, thanks!"). Questions rather than
  orders: "Should this be behind a flag or something?... wdyt?" (#1185); "What do you think?" (#880).
- Direct when a premise is wrong: "I don't think this does what you think it does." (#1158). Opinions and
  other tools do not move him: "I don't think it matters what we think - the fact remains that it is not a
  standard yet, but a Chrome-only experiment." (#1203).
- Declines with the project-level reason plus an alternative: an opt-out option (#1157), a separate flag
  (#1287), warning suppression (#1203). Owns his errors: "I think I misinterpreted the spec." (#264).
- `suggestion` blocks for small fixes (#255, #739, #787); finishes larger ones himself ("I updated this to
  handle a couple more cases", #850).
- Often apologizes for latency ("Sorry for the delay in review.", #808). Reviews come in bursts, so a PR
  needing a second round waits for the next one (#878: reviewed 2025-01-09, merged 2025-04-06). A PR that
  pre-answers the questions above can land in one pass.

## 8. Pre-merge checklist (his lens on `checklists/general.md`)

Answer under the GEN id; this adds where he asked for it.

| GEN | Must hold | Where he asked |
|---|---|---|
| 01 | grammar exact, spec cited | #808, #957, #264 |
| 02 | drafts behind runtime flags | #808, #1185, #425 |
| 03 | invalid stays `Unparsed` | #1329, #682 |
| 04 | no non-standard syntax | #1240, #94 |
| 05 | rendering, animation (6d46cce), cascade kept | #58, #1157 |
| 06 | output parses in targets | 6e47cdb, #264 |
| 07 | both orders tested | 22a8b6f, 28bf5af |
| 08 | merge/dedupe keeps `!important`, prefixes | 93b9e66, df1bae2 |
| 09 | `@layer` order | 32aecd9, 33ea2c1 |
| 10 | selector specificity, no pseudo-elements in `:is()` | ff4de2a, 31ce350, #1156 |
| 11 | nesting lowered and preserved | #356, #1156, #1123 |
| 12 | deterministic output | d4eec35, #1355 |
| 13 | compat via generator; partial is not full | #1306, #564 |
| 14 | `prefix_test` both sides of the target cut | 15a48a8 |
| 15 | `Features` flag for new lowering | 3043896, #1287 |
| 16 | `@supports` scope honored | #878 → d398c1b |
| 17 | no old-browser hacks | #1121 |
| 18 | reuse types, macros, serializers, options | #294, #1237, #267 |
| 19 | fully typed AST | #840, #1218 |
| 20 | no panic from CSS | 20c9612, 4ebcb45 |
| 21 | hot paths measured | #971, #1339, #1332 |
| 22 | opt-in, defaults unchanged, errors gated | #324, #739, #784 |
| 23 | root cause, whole class, sibling paths | #832, #1231, #850 |
| 24 | AST attributes, `yarn build-ast`, transformer name | #703, e7d1bfd |
| 25 | `index.d.ts` and docs updated | eb49015, c82e7d7 |
| 26 | JS changes tested (also wasm) | 0db4fd3 |
| 27 | per-crate builds | #361 → #381 |

Also check: the final head compiles after applied suggestions (4e6492b fixed a merged #1064 suggestion 4
minutes after merge); new public enum variants in `lightningcss` / `parcel_selectors` are called out (#784).

**Evidence package for the report** (what he would otherwise build himself): spec quote, anchor and status;
minimal input with base and head output for every behavior change; per-engine results (Chromium, Firefox,
WebKit) incl. "invalid stays invalid" and "fallback survives"; WPT newly passing / newly failing for touched
properties; CodSpeed and binary-size deltas for core changes; repo-idiom tests that fail on base.

## 9. PR #1328: his own verification direction

Open draft, "entirely generated by AI and I have not yet verified its output" (local branch `pr-1328`,
4034dbb). The skill vendors its WPT extractor (`oracle/wpt/`) and reuses its CSSOM check
(`references/oracle.md`). It parses each WPT value with `Property::parse`
and `expect_exhausted()` (`examples/wpt_adapter.rs:32`), runs print / minify / lower / lower-minify (lower
= Chrome 80), wraps calls in `catch_unwind`, and checks in a browser that invalid input stays invalid and
leaves the preceding fallback, with shorthands rechecked against longhands preseeded to `inherit`
(`wpt/browser.mjs:65-110`). First findings (`wpt/README.md:109-118`): `column-gap: 10` printed as `10px`
(#682); an animation named `none` loses duration, delay, timing and iteration-count; panics on infinite hue
and on mixed number/percentage math in `opacity`; 40 valid-input errors. cbeaf83 CLI recheck
(2026-10-26): `column-gap:10` → `10px`; `animation:1s linear 2s 3 none` → `animation:none`;
`hsl(calc(infinity * 1deg) 50% 50%)` and `hwb(calc(-infinity) 10% 10%)` panic (cssparser-color `lib.rs:308`).
`opacity: calc(50% + 0.5)` and similar mixes print unchanged; the panicking opacity input is UNVERIFIED.
