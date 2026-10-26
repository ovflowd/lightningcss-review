# LightningCSS review: 

**VERDICT: NEEDS_CHANGES** · 0 blocker · 1 major · 0 minor · 2 note

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
| T2 | New test cases exercise the change (fail on base) | PARTIAL | NOTE | the 1 mappable new case(s) pass on base, but 2 in-diff case(s) could not be run (T5): no conclusion; 1 changed expectation(s) (T3) |
| T3 | Changed expectations are browser-equivalent to their input | PARTIAL | NOTE | 1 changed expectation(s) could not be verified in browsers |
| T4 | No existing expectation removed while behavior changed | PASS |  | 1 removed, behavior unchanged |
| T5 | Harness fidelity: recorded head expectations reproduce through the adapter | PARTIAL | MAJOR | 2 test case(s) in the diff could not be run through the adapter; conclusions about the PR's tests are partial; 1 recorded expectation(s) not reproduced; unmapp… |
| T6 | PR and curated probe assertions that hold on base still hold on head | PASS |  | 0 assertion(s) checked |
| O1 | No regression in current engines (base equivalent -> head different, or head worse than base) | PASS |  |  |
| O2 | New/changed test outputs are equivalent to their input in current engines | PASS |  |  |
| O3 | No new declarations/selectors/conditions rejected by an in-target engine without a surviving fallback | PASS |  |  |
| O4 | Lowered output in legacy engines within targets matches the modern rendering | SKIP |  | no legacy engine profile ran |
| O5 | No new near-miss (color/number drift within tolerance) | PASS |  |  |
| O6 | Pixel-identical rendering for visual areas | PASS |  |  |
| O7 | WPT property cases do not regress | SKIP |  |  |
| O8 | Every behavioral delta was verified or cleared (errored engine jobs make the verdict INCONCLUSIVE) | PASS |  | 0 delta(s) verified or cleared |
| O9 | Engines read the input differently: the spec decides (classify with a spec or WPT citation) | PASS |  |  |
| O10 | Cases the browsers cannot judge against base (input rejected in every engine, base behavior extended to new targets) are classified | PASS |  |  |
| R1 | No new panic / crash / timeout | PASS |  |  |
| R2 | Output is stable under re-minification where base is (idempotent) | PASS |  |  |
| S1 | Deltas stay inside the declared areas (or are explained) | PASS |  | touched areas: color |
| S2 | Real-world minified size does not grow (> 0.1%) | SKIP |  | real-world corpus not available |
| S3 | Overlapping open PRs identified | PASS |  |  |
| P1 | No consistent slowdown on the real-world corpus (release build; optional `lcr perf`) | SKIP |  | optional: run `lcr perf` for core/hot-path changes |
| P2 | Release binary size does not grow by more than 1% (optional `lcr perf`) | SKIP |  | optional: run `lcr perf` |
| A1 | Spec checklist for the affected areas | PASS |  | 0/0 items answered |
| A2 | Linked issue repro (`repro: #N` probe) fixed on head and failing on base | SKIP |  | no linked issues |
| A3 | Analysis complete (every slot filled with evidence) | PASS |  | all slots filled |

## 2. Findings

### F1 [MAJOR] [T5] Harness fidelity: recorded head expectations reproduce through the adapter

2 test case(s) in the diff could not be run through the adapter; conclusions about the PR's tests are partial; 1 recorded expectation(s) not reproduced; unmappable helpers: foo_test

- tests::test_color lib.rs:5: unknown flag
- tests::test_color lib.rs:6: minify_test
- tests::test_y lib.rs:10

### F2 [NOTE] [T2] New test cases exercise the change (fail on base)

the 1 mappable new case(s) pass on base, but 2 in-diff case(s) could not be run (T5): no conclusion; 1 changed expectation(s) (T3)

- tests::test_color (lib.rs:4)

### F3 [NOTE] [T3] Changed expectations are browser-equivalent to their input

1 changed expectation(s) could not be verified in browsers

- tests::test_color lib.rs:3 (t-mod)

## 3. Change

- Kind: bugfix · behind flag: n/a
- Intent: s
- Areas: color · from tests: none · blast radius adds: none
  - `src/lib.rs` M +3/-0 → 
  - `src/values/color.rs` M +1/-1 → color

## 4. Behavioral delta

| Source | Cases | Deltas (base ≠ head) |
|---|---|---|
| tuple | 0 | 0 |
| probe | 0 | 0 |
| mutation | 0 | 0 |
| wpt | 0 | 0 |
| realworld | 0 | 0 |

### 4.1 Regressions (0)

### 4.2 Changed and still different from input (0)

### 4.3 Fixed by this PR (0)

### 4.4 Lowering regressions (legacy engines) (0)

### 4.5 Deltas the oracle could not verify (0)


### 4.6 Decision needed (0)

Cases the browsers cannot judge against base (input rejected in every engine), outputs base already produces for other targets, and cases classified NEEDS_MAINTAINER_DECISION.


### 4.7 Pre-existing (base wrong the same way) (0)


## 5. Test expectations

Recorded helper calls: base 10, head 11 (unmappable: 1).

- New cases that fail on base (exercise the change): 0
- New cases that already pass on base: 1
  - `test_color` lib.rs:4
- Changed expectations: 1
  - `test_color` lib.rs:2 → lib.rs:3
- Removed cases whose behavior changed: 0
- Removed cases, behavior unchanged: 1
  - `test_x` lib.rs:9
- Not reproduced by the adapter (excluded): 1
  - `test_y` lib.rs:10
- In the diff but not runnable through the adapter: 2
  - `test_color` lib.rs:5: unknown flag
  - `test_color` lib.rs:6: minify_test

## 6. Spec checklist

No checklist applies.

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
