# LightningCSS review: 

**VERDICT: UNSAFE** · 1 blocker · 2 major · 0 minor · 1 note

- Decision needed: 13 case(s) the browsers cannot judge against base are unclassified (O10)
- Run `run` · skill 0.1.0 · local range
- Base `bbbbbbbbbbbb` · head tree `hhhhhhhhhhhh` · PR head ``
- Engines: latest: chromium 1 · legacy-2021: chromium 97 · legacy-2023: chromium 120

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
| T6 | PR and curated probe assertions that hold on base still hold on head | PASS |  | 14 assertion(s) checked; 14 assertion(s) now pass (fixed by this PR) |
| O1 | No regression in current engines (base equivalent -> head different, or head worse than base) | FAIL | BLOCKER | 28 case(s) where head is worse than base in current engines (base equivalent, or head adds differences) |
| O2 | New/changed test outputs are equivalent to their input in current engines | PASS |  |  |
| O3 | No new declarations/selectors/conditions rejected by an in-target engine without a surviving fallback | PASS |  |  |
| O4 | Lowered output in legacy engines within targets matches the modern rendering | FAIL | MAJOR | 28 lowering regression(s) in legacy engines |
| O5 | No new near-miss (color/number drift within tolerance) | PASS |  |  |
| O6 | Pixel-identical rendering for visual areas | PASS |  |  |
| O7 | WPT property cases do not regress | SKIP |  |  |
| O8 | Every behavioral delta was verified or cleared (errored engine jobs make the verdict INCONCLUSIVE) | FAIL | MAJOR | 13 delta(s) unverified and not cleared in analysis.json |
| O9 | Engines read the input differently: the spec decides (classify with a spec or WPT citation) | PASS |  |  |
| O10 | Cases the browsers cannot judge against base (input rejected in every engine, base behavior extended to new targets) are classified | PARTIAL | NOTE | 13 case(s) the browsers cannot judge against base: 13 with input rejected in every engine, 0 extending base behavior to new targets |
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

### F1 [BLOCKER] [O1] Regression in current engines (head worse than base)

28 case(s) where head is worse than base in current engines (base equivalent, or head adds differences)

- p-color/reg00
- p-color/reg00~dark
- p-color/reg01
- p-color/reg01~dark
- p-color/reg02
- p-color/reg02~dark
- p-color/reg03
- p-color/reg03~dark
- p-color/reg04
- p-color/reg04~dark
- p-color/reg05
- p-color/reg05~dark
- … 16 more

### F2 [MAJOR] [O4] Lowering regression in legacy engines within targets

28 lowering regression(s) in legacy engines

- p-color/reg00@legacy-2023
- p-color/reg00~dark@legacy-2023
- p-color/reg01@legacy-2023
- p-color/reg01~dark@legacy-2023
- p-color/reg02@legacy-2023
- p-color/reg02~dark@legacy-2023
- p-color/reg03@legacy-2023
- p-color/reg03~dark@legacy-2023
- p-color/reg04@legacy-2023
- p-color/reg04~dark@legacy-2023
- p-color/reg05@legacy-2023
- p-color/reg05~dark@legacy-2023
- … 16 more

### F3 [MAJOR] [O8] Behavioral deltas neither verified by the oracle nor cleared

13 delta(s) unverified and not cleared in analysis.json

- p-color/unv00
- p-color/unv01
- p-color/unv02
- p-color/unv03
- p-color/unv04
- p-color/unv05
- p-color/unv06
- p-color/unv07
- p-color/unv08
- p-color/unv09
- p-color/unv10
- p-color/unv11
- … 1 more

### F4 [NOTE] [O10] Cases the browsers cannot judge against base (input rejected in every engine, base behavior extended to new targets) are classified

13 case(s) the browsers cannot judge against base: 13 with input rejected in every engine, 0 extending base behavior to new targets

- p-color/rej00
- p-color/rej01
- p-color/rej02
- p-color/rej03
- p-color/rej04
- p-color/rej05
- p-color/rej06
- p-color/rej07
- p-color/rej08
- p-color/rej09
- p-color/rej10
- p-color/rej11
- … 1 more

## 3. Change

- Kind: bugfix · behind flag: n/a
- Intent: s
- Areas: color · from tests: none · blast radius adds: none
  - `src/values/color.rs` M +1/-1 → color

## 4. Behavioral delta

| Source | Cases | Deltas (base ≠ head) |
|---|---|---|
| tuple | 0 | 0 |
| probe | 67 | 67 |
| mutation | 0 | 0 |
| wpt | 0 | 0 |
| realworld | 0 | 0 |

Oracle transitions (current engines):

| Source | Transition | Count |
|---|---|---|
| probe | fixed | 14 |
| probe | input-rejected | 13 |
| probe | regressed | 28 |
| probe | still-different | 13 |

### 4.1 Regressions (14)

- **p-color/reg00** — probe `color/reg00` (pr): t; targets: none; minify: True

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
  oracle (light): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`
  oracle (dark): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`

- **p-color/reg01** — probe `color/reg01` (pr): t; targets: none; minify: True

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
  oracle (light): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`
  oracle (dark): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`

- **p-color/reg02** — probe `color/reg02` (pr): t; targets: none; minify: True

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
  oracle (light): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`
  oracle (dark): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`

- **p-color/reg03** — probe `color/reg03` (pr): t; targets: none; minify: True

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
  oracle (light): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`
  oracle (dark): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`

- **p-color/reg04** — probe `color/reg04` (pr): t; targets: none; minify: True

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
  oracle (light): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`
  oracle (dark): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`

- **p-color/reg05** — probe `color/reg05` (pr): t; targets: none; minify: True

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
  oracle (light): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`
  oracle (dark): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`

- **p-color/reg06** — probe `color/reg06` (pr): t; targets: none; minify: True

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
  oracle (light): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`
  oracle (dark): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`

- **p-color/reg07** — probe `color/reg07` (pr): t; targets: none; minify: True

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
  oracle (light): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`
  oracle (dark): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`

- **p-color/reg08** — probe `color/reg08` (pr): t; targets: none; minify: True

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
  oracle (light): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`
  oracle (dark): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`

- **p-color/reg09** — probe `color/reg09` (pr): t; targets: none; minify: True

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
  oracle (light): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`
  oracle (dark): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`

- **p-color/reg10** — probe `color/reg10` (pr): t; targets: none; minify: True

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
  oracle (light): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`
  oracle (dark): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`

- **p-color/reg11** — probe `color/reg11` (pr): t; targets: none; minify: True

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
  oracle (light): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`
  oracle (dark): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`

_2 more in oracle.json_

### 4.2 Changed and still different from input (13)

- **p-color/pre00** — probe `color/pre00` (pr): t; targets: none; minify: True

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

- **p-color/pre01** — probe `color/pre01` (pr): t; targets: none; minify: True

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

- **p-color/pre02** — probe `color/pre02` (pr): t; targets: none; minify: True

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

- **p-color/pre03** — probe `color/pre03` (pr): t; targets: none; minify: True

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

- **p-color/pre04** — probe `color/pre04` (pr): t; targets: none; minify: True

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

- **p-color/pre05** — probe `color/pre05` (pr): t; targets: none; minify: True

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

- **p-color/pre06** — probe `color/pre06` (pr): t; targets: none; minify: True

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

- **p-color/pre07** — probe `color/pre07` (pr): t; targets: none; minify: True

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

- **p-color/pre08** — probe `color/pre08` (pr): t; targets: none; minify: True

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

- **p-color/pre09** — probe `color/pre09` (pr): t; targets: none; minify: True

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

- **p-color/pre10** — probe `color/pre10` (pr): t; targets: none; minify: True

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

- **p-color/pre11** — probe `color/pre11` (pr): t; targets: none; minify: True

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

_1 more in oracle.json_

### 4.3 Fixed by this PR (14)

Probe assertions that fail on base and pass on head: `p-color/fix00: parses`, `p-color/fix01: parses`, `p-color/fix02: parses`, `p-color/fix03: parses`, `p-color/fix04: parses`, `p-color/fix05: parses`, `p-color/fix06: parses`, `p-color/fix07: parses`, `p-color/fix08: parses`, `p-color/fix09: parses`, `p-color/fix10: parses`, `p-color/fix11: parses` (+2 more)

- **p-color/fix00** — probe `color/fix00` (pr): t; targets: none; minify: True

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

- **p-color/fix01** — probe `color/fix01` (pr): t; targets: none; minify: True

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

- **p-color/fix02** — probe `color/fix02` (pr): t; targets: none; minify: True

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

- **p-color/fix03** — probe `color/fix03` (pr): t; targets: none; minify: True

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

- **p-color/fix04** — probe `color/fix04` (pr): t; targets: none; minify: True

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

- **p-color/fix05** — probe `color/fix05` (pr): t; targets: none; minify: True

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

- **p-color/fix06** — probe `color/fix06` (pr): t; targets: none; minify: True

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

- **p-color/fix07** — probe `color/fix07` (pr): t; targets: none; minify: True

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

- **p-color/fix08** — probe `color/fix08` (pr): t; targets: none; minify: True

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

- **p-color/fix09** — probe `color/fix09` (pr): t; targets: none; minify: True

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

- **p-color/fix10** — probe `color/fix10` (pr): t; targets: none; minify: True

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

- **p-color/fix11** — probe `color/fix11` (pr): t; targets: none; minify: True

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

_2 more in oracle.json_

### 4.4 Lowering regressions (legacy engines) (14)

- **p-color/reg00** — probe `color/reg00` (pr): t; targets: none; minify: True

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
  oracle (light): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`
  oracle (dark): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`

- **p-color/reg01** — probe `color/reg01` (pr): t; targets: none; minify: True

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
  oracle (light): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`
  oracle (dark): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`

- **p-color/reg02** — probe `color/reg02` (pr): t; targets: none; minify: True

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
  oracle (light): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`
  oracle (dark): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`

- **p-color/reg03** — probe `color/reg03` (pr): t; targets: none; minify: True

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
  oracle (light): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`
  oracle (dark): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`

- **p-color/reg04** — probe `color/reg04` (pr): t; targets: none; minify: True

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
  oracle (light): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`
  oracle (dark): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`

- **p-color/reg05** — probe `color/reg05` (pr): t; targets: none; minify: True

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
  oracle (light): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`
  oracle (dark): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`

- **p-color/reg06** — probe `color/reg06` (pr): t; targets: none; minify: True

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
  oracle (light): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`
  oracle (dark): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`

- **p-color/reg07** — probe `color/reg07` (pr): t; targets: none; minify: True

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
  oracle (light): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`
  oracle (dark): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`

- **p-color/reg08** — probe `color/reg08` (pr): t; targets: none; minify: True

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
  oracle (light): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`
  oracle (dark): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`

- **p-color/reg09** — probe `color/reg09` (pr): t; targets: none; minify: True

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
  oracle (light): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`
  oracle (dark): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`

- **p-color/reg10** — probe `color/reg10` (pr): t; targets: none; minify: True

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
  oracle (light): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`
  oracle (dark): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`

- **p-color/reg11** — probe `color/reg11` (pr): t; targets: none; minify: True

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
  oracle (light): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`
  oracle (dark): base **equivalent**, head **different** → `regressed` · base wrong in: none · head wrong in: chromium, firefox, webkit
    - chromium 1: `div#0` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#1` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); `div#2` color: `rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…` vs `v` (different); rejected `color: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…`; different
    - firefox 1: error: crash
    - legacy-2021: base equivalent, head equivalent → `both-equivalent`
    - legacy-2023: base equivalent, head different → `worsened`

_2 more in oracle.json_

### 4.5 Deltas the oracle could not verify (13)

- `p-color/unv00` (not run) probe `color/unv00` (pr): t — unclassified
- `p-color/unv01` (not run) probe `color/unv01` (pr): t — unclassified
- `p-color/unv02` (not run) probe `color/unv02` (pr): t — unclassified
- `p-color/unv03` (not run) probe `color/unv03` (pr): t — unclassified
- `p-color/unv04` (not run) probe `color/unv04` (pr): t — unclassified
- `p-color/unv05` (not run) probe `color/unv05` (pr): t — unclassified
- `p-color/unv06` (not run) probe `color/unv06` (pr): t — unclassified
- `p-color/unv07` (not run) probe `color/unv07` (pr): t — unclassified
- `p-color/unv08` (not run) probe `color/unv08` (pr): t — unclassified
- `p-color/unv09` (not run) probe `color/unv09` (pr): t — unclassified
- `p-color/unv10` (not run) probe `color/unv10` (pr): t — unclassified
- `p-color/unv11` (not run) probe `color/unv11` (pr): t — unclassified
- _1 more in corpus/deltas.jsonl_

### 4.6 Decision needed (13)

Cases the browsers cannot judge against base (input rejected in every engine), outputs base already produces for other targets, and cases classified NEEDS_MAINTAINER_DECISION.

- `p-color/rej00` (input rejected in every engine) — unclassified
- `p-color/rej01` (input rejected in every engine) — unclassified
- `p-color/rej02` (input rejected in every engine) — unclassified
- `p-color/rej03` (input rejected in every engine) — unclassified
- `p-color/rej04` (input rejected in every engine) — unclassified
- `p-color/rej05` (input rejected in every engine) — unclassified
- `p-color/rej06` (input rejected in every engine) — unclassified
- `p-color/rej07` (input rejected in every engine) — unclassified
- `p-color/rej08` (input rejected in every engine) — unclassified
- `p-color/rej09` (input rejected in every engine) — unclassified
- `p-color/rej10` (input rejected in every engine) — unclassified
- `p-color/rej11` (input rejected in every engine) — unclassified
- _1 more_

### 4.7 Pre-existing (base wrong the same way) (13)

- `p-color/pre00` — base too, open-issue#1
- `p-color/pre01` — base too, open-issue#2
- `p-color/pre02` — base too, open-issue#3
- `p-color/pre03` — base too, open-issue#4
- `p-color/pre04` — base too, open-issue#5
- `p-color/pre05` — base too, open-issue#6
- `p-color/pre06` — base too, open-issue#7
- `p-color/pre07` — base too, open-issue#8
- `p-color/pre08` — base too, open-issue#9
- `p-color/pre09` — base too, open-issue#10
- `p-color/pre10` — base too, open-issue#11
- `p-color/pre11` — base too, open-issue#12
- _1 more_

## 5. Test expectations

Recorded helper calls: base 0, head 0 (unmappable: 0).

- New cases that fail on base (exercise the change): 0
- New cases that already pass on base: 0
- Changed expectations: 0
- Removed cases whose behavior changed: 0
- Removed cases, behavior unchanged: 0
- Not reproduced by the adapter (excluded): 0

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
