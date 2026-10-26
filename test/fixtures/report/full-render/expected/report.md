# LightningCSS review: #42 Lower `color-mix()`

**VERDICT: UNSAFE** · 2 blocker · 4 major · 0 minor · 2 note

- Run `run` · skill 0.1.0 · PR head merged into master (merge-tree, no commit)
- Base `bbbbbbbbbbbb` · head tree `hhhhhhhhhhhh` · PR head `cccccccccccc`
- Author @dev · https://github.com/parcel-bundler/lightningcss/pull/42 · state OPEN
- Engines: latest: chromium 140, firefox 141, webkit 26 · legacy-2021: chromium 97, firefox 93, webkit 15.4

## 1. Checks

| ID | Check | Result | Severity | Evidence |
|---|---|---|---|---|
| B1 | Head test suite passes (cargo test --all-features) | PASS |  | 1 passed, 0 ignored |
| B2 | Compiles with RUSTFLAGS=-D warnings (CI) | PASS |  |  |
| B3 | rustfmt clean on changed files | PASS |  |  |
| B4 | Cargo.lock in sync (--locked) | PASS |  |  |
| B5 | JS lane: yarn build / test / tsc (when bindings change) | SKIP |  | bindings not touched |
| B6 | GitHub CI checks on the PR | SKIP |  | no checks reported (first-time contributor workflows may need approval) |
| B7 | parcel_selectors crate tests (not run by CI) | SKIP |  | lane not run |
| B8 | Builds with --no-default-features | SKIP |  | lane not run |
| B9 | wasm32 compile gate (CI test-wasm compiles cfg(wasm32) code only there) | SKIP |  | no napi/node/cfg(target_arch) changes |
| B10 | C bindings build and c/lightningcss.h is up to date | SKIP |  | c/ not touched |
| B11 | Generated files in sync (build-prefixes.js output, ast.d.ts), compared with base's drift | SKIP |  | no generated inputs touched |
| T1 | Source changes come with tests in src/lib.rs (or tests/, node/test) | PASS |  |  |
| T2 | New test cases exercise the change (fail on base) | SKIP |  | no new test cases |
| T3 | Changed expectations are browser-equivalent to their input | SKIP |  | no existing expectation changed |
| T4 | No existing expectation removed while behavior changed | PASS |  |  |
| T5 | Harness fidelity: recorded head expectations reproduce through the adapter | PASS |  | 0 head tuples reproduced |
| T6 | PR and curated probe assertions that hold on base still hold on head | PASS |  | 0 assertion(s) checked |
| O1 | No regression in current engines (base equivalent -> head different, or head worse than base) | FAIL | BLOCKER | 2 case(s) where head is worse than base in current engines (base equivalent, or head adds differences) |
| O2 | New/changed test outputs are equivalent to their input in current engines | PASS |  |  |
| O3 | No new declarations/selectors/conditions rejected by an in-target engine without a surviving fallback | PASS |  |  |
| O4 | Lowered output in legacy engines within targets matches the modern rendering | PASS |  | legacy-2021 |
| O5 | No new near-miss (color/number drift within tolerance) | PASS |  |  |
| O6 | Pixel-identical rendering for visual areas | PASS |  |  |
| O7 | WPT property cases do not regress | PASS |  |  |
| O8 | Every behavioral delta was verified or cleared (errored engine jobs make the verdict INCONCLUSIVE) | FAIL | MAJOR | 1 delta(s) unverified and not cleared in analysis.json |
| O9 | Engines read the input differently: the spec decides (classify with a spec or WPT citation) | PASS |  |  |
| O10 | Cases the browsers cannot judge against base (input rejected in every engine, base behavior extended to new targets) are classified | PASS |  |  |
| R1 | No new panic / crash / timeout | FAIL | BLOCKER | 1 new panic/crash/timeout |
| R2 | Output is stable under re-minification where base is (idempotent) | PASS |  |  |
| S1 | Deltas stay inside the declared areas (or are explained) | FAIL | MAJOR | 2 delta(s) outside the touched areas (color, selectors) need classification |
| S2 | Real-world minified size does not grow (> 0.1%) | SKIP |  | real-world corpus not available |
| S3 | Overlapping open PRs identified | PARTIAL | NOTE | 1 open PR(s) touch the same files |
| P1 | No consistent slowdown on the real-world corpus (release build; optional `lcr perf`) | SKIP |  | optional: run `lcr perf` for core/hot-path changes |
| P2 | Release binary size does not grow by more than 1% (optional `lcr perf`) | SKIP |  | optional: run `lcr perf` |
| A1 | Spec checklist for the affected areas | PARTIAL | NOTE | 0/43 items answered |
| A2 | Linked issue repro (`repro: #N` probe) fixed on head and failing on base | FAIL | MAJOR | 1 linked issue(s) |
| A3 | Analysis complete (every slot filled with evidence) | FAIL | MAJOR | checklist items unanswered or without evidence: GEN-01, GEN-02, GEN-03, GEN-04, GEN-05, GEN-06, GEN-07, GEN-08, GEN-09, GEN-10…; w-0000000a: PRE_EXISTING on w-… |

## 2. Findings

### F1 [BLOCKER] [O1] Regression in current engines (head worse than base)

2 case(s) where head is worse than base in current engines (base equivalent, or head adds differences)

- r-bootstrap-minify
- r-tiny-minify

### F2 [BLOCKER] [R1] New panic / crash / timeout

1 new panic/crash/timeout

- t-err panic: boom boom boom boom boom boom boom boom boom boom boom boom boom boom boom boom boom boom boom boom boom boom boom boom…

### F3 [MAJOR] [A2] Linked issue repro not fixed on head (or not reproduced on base)

1 linked issue(s)

- #3: no PR probe with `repro: #3`

### F4 [MAJOR] [A3] Analysis incomplete or inconsistent with the evidence

checklist items unanswered or without evidence: GEN-01, GEN-02, GEN-03, GEN-04, GEN-05, GEN-06, GEN-07, GEN-08, GEN-09, GEN-10…; w-0000000a: PRE_EXISTING on w-0000000a, which base renders equivalent in every engine

- w-0000000a: PRE_EXISTING on w-0000000a, which base renders equivalent in every engine
- checklist items unanswered or without evidence: GEN-01, GEN-02, GEN-03, GEN-04, GEN-05, GEN-06, GEN-07, GEN-08, GEN-09, GEN-10…

### F5 [MAJOR] [O8] Behavioral deltas neither verified by the oracle nor cleared

1 delta(s) unverified and not cleared in analysis.json

- t-err

### F6 [MAJOR] [S1] Deltas outside the declared areas are unexplained

2 delta(s) outside the touched areas (color, selectors) need classification

- r-bootstrap-minify [realworld]
- r-tiny-minify [realworld]

### F7 [NOTE] [A1] Spec checklist for the affected areas

0/43 items answered


### F8 [NOTE] [S3] Overlapping open PRs identified

1 open PR(s) touch the same files

- #8 other (src/values/color.rs)

## 3. Change

- Kind: bugfix · behind flag: no
- Intent: Lower color-mix for old targets
  - claim: fixes #3
  - claim: no output change without targets
- Areas: color, selectors · from tests: color · blast radius adds: gradient-image
  - `src/values/color.rs` M +1/-1 → color
- Test functions touched: test_color, test_gradient
- Changed items: `src/values/color.rs`:CssColor::to_css, `src/values/color.rs`:-::-
  - `CssColor` referenced in 10 file(s): src/f0.rs, src/f1.rs, src/f2.rs, src/f3.rs, src/f4.rs, src/f5.rs, src/f6.rs, src/f7.rs
- Risk flag `core-file`: touches src/values/color.rs
- Linked issue #3 (OPEN): mix is wrong
- Overlaps open PR #8 other — src/values/color.rs

## 4. Behavioral delta

| Source | Cases | Deltas (base ≠ head) |
|---|---|---|
| tuple | 1 | 1 |
| probe | 1 | 1 |
| mutation | 0 | 0 |
| wpt | 1 | 1 |
| realworld | 2 | 2 |

Oracle transitions (current engines):

| Source | Transition | Count |
|---|---|---|
| probe | fixed | 1 |
| realworld | regressed | 2 |
| wpt | regressed | 1 |

Oracle selection: 5 of 9 candidate case(s); not run: 4. By reason: cap=1, no-delta=3

### 4.1 Regressions (3)

- **r-bootstrap-minify** — real-world `bootstrap` (mode minify); targets: none; minify: True

  base → head (changed part):
  ```diff
  --- base
  +++ head
  @@ -6,3 +6,3 @@
   .r5{color:red}
  -.r6{color:red}
  +.r6{color:blue}
   .r7{color:red}
  ```
  oracle (light): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit

- **r-tiny-minify** — real-world `tiny` (mode minify); targets: none; minify: True

  base → head (changed part):
  ```diff
  base: …xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxcolor:redyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy…
  head: …xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxcolor:blueyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy…
  ```
  oracle (light): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit

- **w-0000000a** — WPT `css/color.html` `color: color-mix(in srgb, red, blue)` (valid, mode lower); targets: none; minify: None

  input:
  ```css
  color: color-mix(in srgb, red, blue)
  ```
  base → head:
  ```css
  a
  /* ---- head ---- */
  ax
  ```
  oracle (light): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit

### 4.2 Changed and still different from input (0)

### 4.3 Fixed by this PR (1)

- **p-color/fixed-one** — probe `color/fixed-one` (pr): t; targets: none; minify: True

  input:
  ```css
  .t{color:red}
  ```
  base → head:
  ```css
  a
  /* ---- head ---- */
  ax
  ```
  oracle (light): base **different**, head **equivalent** → `fixed` · base wrong in: chromium, firefox, webkit · head wrong in: none

### 4.4 Lowering regressions (legacy engines) (0)

### 4.5 Deltas the oracle could not verify (1)

- `t-err` (not run) test `test_color` (`minify_test`, lib.rs:7, both) — unclassified

### 4.6 Decision needed (0)

Cases the browsers cannot judge against base (input rejected in every engine), outputs base already produces for other targets, and cases classified NEEDS_MAINTAINER_DECISION.


### 4.7 Pre-existing (base wrong the same way) (1)

- `w-0000000a` — base renders it wrong too, open-issue#4

## 5. Test expectations

Recorded helper calls: base 0, head 0 (unmappable: 0).

- New cases that fail on base (exercise the change): 0
- New cases that already pass on base: 0
- Changed expectations: 0
- Removed cases whose behavior changed: 0
- Removed cases, behavior unchanged: 0
- Not reproduced by the adapter (excluded): 0

## 6. Spec checklist

| Item | Severity | Check | Answer | Evidence |
|---|---|---|---|---|
| GEN-01 | MAJOR | The parser implements the spec grammar exactly (optional parts, `\|\|`/`&&`, functional vs keyword forms, ranges) and the PR cites the sectio… | — |  |
| GEN-02 | MAJOR | Draft or single-engine syntax is behind `ParserFlags` exposed as JS `drafts`, not a cargo feature or unflagged; syntax opposed by other ven… | — |  |
| GEN-03 | MAJOR | New values are typed (no `TokenList` where a grammar exists), input browsers reject stays `Property::Unparsed`, and no non-standard lenienc… | — |  |
| GEN-04 | BLOCKER | The change preserves what the oracle cannot see: interpolation and animation, computed-value-time behavior (custom properties, `all`, inher… | — |  |
| GEN-05 | MAJOR | Emitted syntax is accepted by targets the engines do not cover (versions below the legacy profiles, Samsung, Opera, Android), and no old-br… | — |  |
| GEN-06 | MAJOR | A handler or ordering change behaves correctly in both orders: typed then `var()`, `var()` then typed, prefixed then unprefixed, shorthand … | — |  |
| GEN-07 | MAJOR | Compat changes go through `scripts/build-prefixes.js` (generated files not hand-edited), partial support is not counted as support, and eve… | — |  |
| GEN-08 | MAJOR | A new lowering has a `Features` flag, applies only to targets that need it (output unchanged for one that does not), and honors an enclosin… | — |  |
| GEN-09 | MAJOR | Behavior changes are opt-in: new options default to current behavior, existing options keep their meaning, new errors are gated by their mo… | — |  |
| GEN-10 | MAJOR | The fix is at the root cause and covers the whole class: sibling types and call sites sharing the code, several values or selectors, bounda… | — |  |
| GEN-11 | MAJOR | Nothing is dropped, renamed or merged based on what one file contains (custom properties are global, code splitting exists). | — |  |
| GEN-12 | BLOCKER | No `unwrap`/`expect`/`unreachable!`/`panic!` is reachable from CSS input, including `currentcolor`, system colors, `var()`, infinite or NaN… | — |  |
| GEN-13 | MAJOR | No hash-ordered iteration reaches output or rule emission. | — |  |
| GEN-14 | MINOR | Hot paths (printer writes, handler loops, `CssRuleList::minify`) gain no quadratic scans or per-declaration hashing, and representation cha… | — |  |
| GEN-15 | MINOR | Code reuses existing types, macros, serializers and options and sits where conventions put it (handler in `src/properties/<area>.rs`, tests… | — |  |
| GEN-16 | MAJOR | New public types carry the visitor/serde/jsonschema/`into_owned` derives and a spec-linked doc, new `CssRule` variants are named in `napi/s… | — |  |
| COLOR-01 | BLOCKER | No touched conversion or fallback path, nor its siblings, unwraps a conversion of an unconvertible color (`currentcolor`, system colors, `l… | — |  |
| COLOR-02 | BLOCKER | An earlier declaration stays as the author's fallback when a later one is invalid, unparsed or not parsed by every target; each declaration… | — |  |
| COLOR-03 | MAJOR | `@supports` wide-gamut copies of custom properties and unparsed values attach to the declaring selector in every rule kind, never with an e… | — |  |
| COLOR-04 | BLOCKER | `light-dark()` lowering emits toggles for every `color-scheme` holding `light`/`dark` (one that now parses as `Unparsed` gets none), keeps … | — |  |
| COLOR-05 | BLOCKER | `none` survives every path that keeps a color (hex printing, token-list re-parse, the branch modern engines take). | — |  |
| COLOR-06 | BLOCKER | Static `color-mix()`, relative colors and `alpha()` follow the spec: analogous carry-forward, same-space operands unconverted, no clamping … | — |  |
| COLOR-07 | BLOCKER | Syntax browsers reject stays unparsed: mix percentages outside [0,100], `specified hue`, `calc(h + 1deg)`, legacy commas with numbers or `n… | — |  |
| COLOR-08 | BLOCKER | No color switches between legacy and non-legacy form (gradient interpolation space), and `hsl()`/`hwb()` operands of an unresolved `color-m… | — |  |
| COLOR-09 | BLOCKER | `currentcolor`, system colors, unequal `light-dark()` arms, `contrast-color()` and functions containing them are never resolved at build ti… | — |  |
| COLOR-10 | MAJOR | The final declaration is the authored color or an exact equivalent (oklab/oklch → lab clamps L first); P3 only when a target supports it. | — |  |
| COLOR-11 | MAJOR | Gamut-mapping or conversion changes keep the binary-search contract (white/black cut-offs, in-gamut unchanged), every other use of a shared… | — |  |
| COLOR-12 | MAJOR | Hex alpha only with HexAlphaColors, shortening only when every pair repeats, non-black transparent never `transparent`, opacity < 1 never `… | — |  |
| COLOR-13 | MAJOR | A change holds in every color context (shorthands, shadows, gradients, custom properties, `@property`, `@keyframes`); newly typed syntax br… | — |  |
| COLOR-14 | MINOR | Color parsing stays linear in nesting depth. | — |  |
| SEL-01 | BLOCKER | No selector is merged into a list that a target engine (no targets: C, F or W) rejects: each added or changed component has an `is_compatib… | — |  |
| SEL-02 | BLOCKER | Selectors split off for targets keep their declarations through `merge_style_rules`; no side rule is built for an emptied list. | — |  |
| SEL-03 | BLOCKER | An `:is()` wrap needs `:is()` support, no pseudo-element in any member (also behind `:global()` or after a visitor round trip) and equal sp… | — |  |
| SEL-04 | BLOCKER | Lowering keeps specificity: `:not(a,b)` to `:not(:is(a,b))`, top-level or `@scope` `&` to `:where(:scope)`, `-any` copies only for compound… | — |  |
| SEL-05 | BLOCKER | `:is(X)` unwraps only if X is valid there in every target engine (known, not after a pseudo-element, not in `:has()`, no `:lang()` list or … | — |  |
| SEL-06 | BLOCKER | A newly known pseudo or `SelectorParsingState` change rejects nothing base accepted that spec or WPT allows, accepts nothing C/F/W reject, … | — |  |
| SEL-07 | MAJOR | `:not()`, `:has()`, `of S`, `:-webkit-any()` stay unforgiving; an emptied `:is()`/`:where()` prints `:is()`; `:has(::x)` never becomes `:ha… | — |  |
| SEL-08 | BLOCKER | Prefixed spellings round-trip: legacy pseudo-class and pseudo-element forms stay distinct, no unprefixed copy from a legacy alias, merged p… | — |  |
| SEL-09 | MAJOR | A new pseudo has a generated compat Feature (partial is not full) and each new variant is matched without `_ =>` in printers, `get_prefix`,… | — |  |
| SEL-10 | BLOCKER | Output re-parses equivalently: closed functions, leading `:scope` kept in `:has()`, escaped unknown names, same An+B set, name case, `i`/`s… | — |  |
| SEL-11 | BLOCKER | Namespace-prefixed selectors merge only if declared with one URL in one sheet; bundling moves no `@namespace`. | — |  |
| SEL-12 | BLOCKER | Case-sensitive pseudo arguments keep case; CSS modules hash no `::part()`/`:state()` name or the UA `root` view-transition name, and rename… | — |  |
| SEL-13 | BLOCKER | `:host(X)`, `::slotted(X)`, `::part()` keep their one-compound argument and every part name and never become compounds or descendants (`:ho… | — |  |

## 7. Robustness and stability

- Panics/crashes/timeouts: head 1, base 0
  - `t-err` panic: boom boom boom boom boom boom boom boom boom boom boom boom boom boom boom boom boom boom boom boom boom boom boom boom boom boom boom boom boom boom boom boom…
- Not idempotent on head only (second minify pass changes output): 0

## 8. Real-world corpus

Not available (`lcr realworld`).

## 9. Known failures in the touched areas (master baseline)

Master `mmmmmmmmmmmm`: 14 curated probe(s) in the touched areas fail today. A PR that changes them shows up in §4; these are listed so they are not mistaken for the PR's doing.

- `color/known-00` (open-bug): fails equivalent
- `color/known-01` (open-bug): fails equivalent
- `color/known-02` (open-bug): fails equivalent
- `color/known-03` (open-bug): fails equivalent
- `color/known-04` (open-bug): fails equivalent
- `color/known-05` (open-bug): fails equivalent
- `color/known-06` (open-bug): fails equivalent
- `color/known-07` (open-bug): fails equivalent
- `color/known-08` (open-bug): fails equivalent
- `color/known-09` (open-bug): fails equivalent
- `color/known-10` (open-bug): fails equivalent
- `color/known-11` (open-bug): fails equivalent
- _2 more in <CACHE>/baseline.json_

## 10. Coverage and limits

- Stages: prepare ✓, build ✓, corpus ✓, oracle ✓, analysis ✓
- DOM synthesis: 2 case(s), 1 fell back to the generic DOM, 3 selector component(s) not synthesizable (pseudo-states are rewritten to attributes)
- The oracle proves equivalence only for the synthesized DOM and the engines listed above; Playwright WebKit is not Safari.
- Legacy checks run only for engines inside a case's targets; older targets are covered by compat data, not execution.

## Appendix A: spec cards for the touched properties (W3C webref)

| Property | Syntax | Initial | Inherited | Computed value | Animation | Longhands |
|---|---|---|---|---|---|---|
| [`color`](https://drafts.csswg.org/css-color-4/#propdef-color) | `<color>` | CanvasText | yes | computed color | by computed value type |  |
| [`accent-color`](https://x) | `auto \| <color> \| `x`` | auto | yes | \|pipe\| | by computed value type | a, b |

Not in any spec (legacy or vendor names handled by the same code): `-webkit-text-fill`

## Reproduce

```sh
lcr prepare 42
lcr build run
lcr corpus run
lcr probe run
lcr oracle run
lcr worklist run
lcr report run
```
