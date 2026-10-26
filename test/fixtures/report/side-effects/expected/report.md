# LightningCSS review: #2 Fix colors

**VERDICT: INCONCLUSIVE** · 0 blocker · 3 major · 2 minor · 3 note

- Run `run` · skill 0.1.0 · local range
- Base `bbbbbbbbbbbb` · head tree `hhhhhhhhhhhh` · PR head ``
- Author @me · https://x/2 · state OPEN (draft)
- Engines: latest: chromium 1

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
| O1 | No regression in current engines (base equivalent -> head different, or head worse than base) | PASS |  |  |
| O2 | New/changed test outputs are equivalent to their input in current engines | PASS |  |  |
| O3 | No new declarations/selectors/conditions rejected by an in-target engine without a surviving fallback | PASS |  |  |
| O4 | Lowered output in legacy engines within targets matches the modern rendering | SKIP |  | no legacy engine profile ran |
| O5 | No new near-miss (color/number drift within tolerance) | PASS |  |  |
| O6 | Pixel-identical rendering for visual areas | FAIL | MINOR | 1 case(s) render different pixels; 2 case(s) had no screenshot comparison (screenshot failed in firefox, webkit) |
| O7 | WPT property cases do not regress | PASS |  |  |
| O8 | Every behavioral delta was verified or cleared (errored engine jobs make the verdict INCONCLUSIVE) | FAIL | MAJOR | 2 delta(s) unverified and not cleared in analysis.json |
| O9 | Engines read the input differently: the spec decides (classify with a spec or WPT citation) | PASS |  |  |
| O10 | Cases the browsers cannot judge against base (input rejected in every engine, base behavior extended to new targets) are classified | PASS |  |  |
| R1 | No new panic / crash / timeout | PASS |  |  |
| R2 | Output is stable under re-minification where base is (idempotent) | PASS |  |  |
| S1 | Deltas stay inside the declared areas (or are explained) | FAIL | MAJOR | 2 delta(s) outside the touched areas (color) need classification; 1 outside delta(s) verified equivalent in every engine (accepted) |
| S2 | Real-world minified size does not grow (> 0.1%) | FAIL | MINOR | minified total 1500 -> 1490 bytes (-0.667%); lower-minify total 1000 -> 1100 bytes (+10.000%) |
| S3 | Overlapping open PRs identified | PARTIAL | NOTE | 2 open PR(s) touch the same files; possible duplicate of #1, #3 |
| P1 | No consistent slowdown on the real-world corpus (release build; optional `lcr perf`) | SKIP |  | optional: run `lcr perf` for core/hot-path changes |
| P2 | Release binary size does not grow by more than 1% (optional `lcr perf`) | SKIP |  | optional: run `lcr perf` |
| A1 | Spec checklist for the affected areas | PARTIAL | NOTE | 0/30 items answered |
| A2 | Linked issue repro (`repro: #N` probe) fixed on head and failing on base | PARTIAL | NOTE | 1 linked issue(s); closed or related ones need no repro |
| A3 | Analysis complete (every slot filled with evidence) | FAIL | MAJOR | checklist items unanswered or without evidence: GEN-01, GEN-02, GEN-03, GEN-04, GEN-05, GEN-06, GEN-07, GEN-08, GEN-09, GEN-10… |

## 2. Findings

### F1 [MAJOR] [A3] Analysis incomplete or inconsistent with the evidence

checklist items unanswered or without evidence: GEN-01, GEN-02, GEN-03, GEN-04, GEN-05, GEN-06, GEN-07, GEN-08, GEN-09, GEN-10…

- checklist items unanswered or without evidence: GEN-01, GEN-02, GEN-03, GEN-04, GEN-05, GEN-06, GEN-07, GEN-08, GEN-09, GEN-10…

### F2 [MAJOR] [O8] Behavioral deltas neither verified by the oracle nor cleared

2 delta(s) unverified and not cleared in analysis.json

- m-p-selectors/x-wrap
- w-00000001

### F3 [MAJOR] [S1] Deltas outside the declared areas are unexplained

2 delta(s) outside the touched areas (color) need classification; 1 outside delta(s) verified equivalent in every engine (accepted)

- p-selectors/x [selectors]
- w-00000001 [ui-misc]

### F4 [MINOR] [O6] Rendering differs in pixels

1 case(s) render different pixels; 2 case(s) had no screenshot comparison (screenshot failed in firefox, webkit)

- p-color/vis

### F5 [MINOR] [S2] Real-world output grows (> 0.1%)

minified total 1500 -> 1490 bytes (-0.667%); lower-minify total 1000 -> 1100 bytes (+10.000%)

- a/lower-minify: 1000 -> 1100 bytes

### F6 [NOTE] [A1] Spec checklist for the affected areas

0/30 items answered


### F7 [NOTE] [A2] Linked issue repro (`repro: #N` probe) fixed on head and failing on base

1 linked issue(s); closed or related ones need no repro

- #5: no PR probe with `repro: #5`

### F8 [NOTE] [S3] Overlapping open PRs identified

2 open PR(s) touch the same files; possible duplicate of #1, #3

- #1 same fix: possible duplicate (same author; src/x.rs)
- #3 other: possible duplicate (same linked issue; src/x.rs, src/y.rs)

## 3. Change

- Kind: bugfix · behind flag: n/a
- Intent: s
- Areas: color · from tests: none · blast radius adds: none
  - `src/values/color.rs` M +1/-1 → color
- Linked issue #5 (OPEN): five
- Overlaps open PR #1 same fix — src/x.rs
- Overlaps open PR #3 other — src/x.rs, src/y.rs

## 4. Behavioral delta

| Source | Cases | Deltas (base ≠ head) |
|---|---|---|
| tuple | 0 | 0 |
| probe | 3 | 3 |
| mutation | 1 | 1 |
| wpt | 1 | 1 |
| realworld | 0 | 0 |

Oracle transitions (current engines):

| Source | Transition | Count |
|---|---|---|
| probe | both-equivalent | 2 |
| probe | still-different | 1 |

### 4.1 Regressions (0)

### 4.2 Changed and still different from input (1)

- **p-selectors/x** — probe `selectors/x` (pr): t; targets: none; minify: True

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
  oracle (light): base **different**, head **different** → `still-different` · base wrong in: chromium, firefox, webkit · head wrong in: chromium, firefox, webkit

### 4.3 Fixed by this PR (0)

### 4.4 Lowering regressions (legacy engines) (0)

### 4.5 Deltas the oracle could not verify (2)

- `m-p-selectors/x-wrap` (not run) mutation `wrap` of `p-selectors/x` — unclassified
- `w-00000001` (not run) WPT `f.html` `-moz-user-select: none` (valid, mode minify) — unclassified

### 4.6 Decision needed (0)

Cases the browsers cannot judge against base (input rejected in every engine), outputs base already produces for other targets, and cases classified NEEDS_MAINTAINER_DECISION.


### 4.7 Pre-existing (base wrong the same way) (0)


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

## 7. Robustness and stability

- Panics/crashes/timeouts: head 0, base 0
- Not idempotent on head only (second minify pass changes output): 0

## 8. Real-world corpus

| File | Mode | Base bytes | Head bytes | Δ |
|---|---|---|---|---|
| a | minify | 1000 | 1000 | +0 |
| a | lower-minify | 1000 | 1100 | +100 |
| b | minify | 500 | 490 | -10 |

## 9. Known failures in the touched areas (master baseline)

No baseline yet (`lcr baseline`). Pre-existing failures are not attributed to the PR either way: only base→head transitions are.

## 10. Coverage and limits

- Stages: prepare ✓, build ✓, corpus ✓, oracle ✓, analysis ✓
- The oracle proves equivalence only for the synthesized DOM and the engines listed above; Playwright WebKit is not Safari.
- Legacy checks run only for engines inside a case's targets; older targets are covered by compat data, not execution.

## Reproduce

```sh
lcr prepare 2
lcr build run
lcr corpus run
lcr probe run
lcr oracle run
lcr worklist run
lcr report run
```
