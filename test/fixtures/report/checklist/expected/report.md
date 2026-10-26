# LightningCSS review: 

**VERDICT: UNSAFE** · 1 blocker · 4 major · 1 minor · 2 note

- Run `run` · skill 0.1.0 · local range
- Base `bbbbbbbbbbbb` · head tree `hhhhhhhhhhhh` · PR head ``
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
| O6 | Pixel-identical rendering for visual areas | PASS |  |  |
| O7 | WPT property cases do not regress | SKIP |  |  |
| O8 | Every behavioral delta was verified or cleared (errored engine jobs make the verdict INCONCLUSIVE) | FAIL | MAJOR | 1 delta(s) unverified and not cleared in analysis.json |
| O9 | Engines read the input differently: the spec decides (classify with a spec or WPT citation) | PASS |  |  |
| O10 | Cases the browsers cannot judge against base (input rejected in every engine, base behavior extended to new targets) are classified | PASS |  |  |
| R1 | No new panic / crash / timeout | PASS |  |  |
| R2 | Output is stable under re-minification where base is (idempotent) | PASS |  |  |
| S1 | Deltas stay inside the declared areas (or are explained) | PASS |  | touched areas: color |
| S2 | Real-world minified size does not grow (> 0.1%) | SKIP |  | real-world corpus not available |
| S3 | Overlapping open PRs identified | PASS |  |  |
| P1 | No consistent slowdown on the real-world corpus (release build; optional `lcr perf`) | SKIP |  | optional: run `lcr perf` for core/hot-path changes |
| P2 | Release binary size does not grow by more than 1% (optional `lcr perf`) | SKIP |  | optional: run `lcr perf` |
| A1 | Spec checklist for the affected areas | FAIL | BLOCKER | 6 checklist item(s) failed: GEN-06 (BLOCKER), COLOR-01 (MAJOR), COLOR-02 (MAJOR), COLOR-04 (MAJOR), TESTS-03 (MAJOR), COLOR-03 (MINOR); 2 fail on base too (not… |
| A2 | Linked issue repro (`repro: #N` probe) fixed on head and failing on base | SKIP |  | no linked issues |
| A3 | Analysis complete (every slot filled with evidence) | FAIL | MAJOR | COLOR-07: links unknown finding F7; COLOR-04: effective_severity cannot raise MAJOR to BLOCKER; COLOR-02: FAIL cites p-color/lm (lower-minify, fixed), which it… |

## 2. Findings

### F1 [BLOCKER] [GEN-06] Colors stay equivalent

- m-x

Also reported by:

- [TESTS-03] (MAJOR) Colors stay equivalent

### F2 [MAJOR] Gradient loses a stop (analysis F1)

d

- p-color/x
- x

Also reported by:

- [COLOR-01] (MAJOR) Colors stay equivalent
- [O8] (MAJOR) Behavioral deltas neither verified by the oracle nor cleared

Suggested test:

````rust
test("```", "x");
````

### F3 [MAJOR] [COLOR-02] Colors stay equivalent

- only p-color/lm

### F4 [MAJOR] [COLOR-04] Colors stay equivalent

n

- e

### F5 [MAJOR] [A3] Analysis incomplete or inconsistent with the evidence

COLOR-07: links unknown finding F7; COLOR-04: effective_severity cannot raise MAJOR to BLOCKER; COLOR-02: FAIL cites p-color/lm (lower-minify, fixed), which its verify line accepts; COLOR-02: a FAIL must say in `note` why each verify alternative does not hold; COLOR-06: FAIL_PRE_EXISTING needs evidence that base fails the same way: an issue (`open-issue#N`, `fixed-by#N` or a lightningcss issue/PR URL), a probe with an assertion that fails on base, a case the oracle finds wrong on base, a base tuple (`t-…`) whose base output matches its recorded expectation, or a case that crashes on base

- COLOR-02: FAIL cites p-color/lm (lower-minify, fixed), which its verify line accepts
- COLOR-07: links unknown finding F7
- COLOR-04: effective_severity cannot raise MAJOR to BLOCKER
- COLOR-02: a FAIL must say in `note` why each verify alternative does not hold
- COLOR-06: FAIL_PRE_EXISTING needs evidence that base fails the same way: an issue (`open-issue#N`, `fixed-by#N` or a lightningcss issue/PR URL), a probe with an assertion that fails on base, a case the oracle finds wrong on base, a base tuple (`t-…`) whose base output matches its recorded expectation, or a case that crashes on base

### F6 [MINOR] [COLOR-03] Colors stay equivalent

n (severity MAJOR → MINOR: cosmetic `.0` only)

- e

### F7 [NOTE] [COLOR-05] Pre-existing (base fails too): Colors stay equivalent

- base too, open-issue#710

### F8 [NOTE] [COLOR-06] Pre-existing (base fails too): Colors stay equivalent

- base too, #710

## 3. Change

- Kind: bugfix · behind flag: n/a
- Intent: s
- Areas: color · from tests: none · blast radius adds: none
  - `src/values/color.rs` M +1/-1 → color

## 4. Behavioral delta

| Source | Cases | Deltas (base ≠ head) |
|---|---|---|
| tuple | 0 | 0 |
| probe | 2 | 2 |
| mutation | 0 | 0 |
| wpt | 0 | 0 |
| realworld | 0 | 0 |

Oracle transitions (current engines):

| Source | Transition | Count |
|---|---|---|
| probe | fixed | 1 |

### 4.1 Regressions (0)

### 4.2 Changed and still different from input (0)

### 4.3 Fixed by this PR (1)

- **p-color/lm** — probe `color/lm` (pr): t; targets: chrome 80; minify: True

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
  oracle (light): base **different**, head **equivalent** → `fixed` · base wrong in: chromium · head wrong in: none

### 4.4 Lowering regressions (legacy engines) (0)

### 4.5 Deltas the oracle could not verify (1)

- `p-color/x` (not run) probe `color/x` (pr): t — unclassified

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
| COLOR-01 | MAJOR | Colors stay equivalent | FAIL | x |
| GEN-06 | BLOCKER | Colors stay equivalent | FAIL | m-x |
| TESTS-03 | MAJOR | Colors stay equivalent | FAIL | m-x |
| COLOR-02 | MAJOR | Colors stay equivalent | FAIL | only p-color/lm |
| COLOR-03 | MAJOR → MINOR | Colors stay equivalent | FAIL | e |
| COLOR-04 | MAJOR | Colors stay equivalent | FAIL | e |
| COLOR-05 | MAJOR | Colors stay equivalent | FAIL_PRE_EXISTING | base too, open-issue#710 |
| COLOR-06 | MAJOR | Colors stay equivalent | FAIL_PRE_EXISTING | base too, #710 |
| COLOR-07 | MAJOR | Colors stay equivalent | PASS | x |
| DISPLAY-01 | MAJOR | Colors stay equivalent | N/A (area) | diff touches no display code |

## 7. Robustness and stability

- Panics/crashes/timeouts: head 0, base 0
- Not idempotent on head only (second minify pass changes output): 0

## 8. Real-world corpus

Not available (`lcr realworld`).

## 9. Known failures in the touched areas (master baseline)

No baseline yet (`lcr baseline`). Pre-existing failures are not attributed to the PR either way: only base→head transitions are.

## 10. Coverage and limits

- Stages: prepare ✓, build ✓, corpus ✓, oracle ✓, analysis ✓
- The oracle proves equivalence only for the synthesized DOM and the engines listed above; Playwright WebKit is not Safari.
- Legacy checks run only for engines inside a case's targets; older targets are covered by compat data, not execution.

## Reproduce

```sh
lcr prepare <pr>
lcr build run
lcr corpus run
lcr probe run
lcr oracle run
lcr worklist run
lcr report run
```
