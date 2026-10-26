---
name: lightningcss-review
description: "Deterministic correctness review of parcel-bundler/lightningcss pull requests. Builds base and head in Docker, diffs their output on the PR's own tests, every existing test expectation, curated edge cases, metamorphic variants, WPT and real-world CSS, checks semantics in headless Chromium/Firefox/WebKit (current and legacy engines), runs the spec checklists, and renders a fixed-format report with a rule-based verdict (UNSAFE / NEEDS_CHANGES / SAFE_WITH_NITS / SAFE / INCONCLUSIVE). TRIGGER when asked to review, verify, test or assess the safety of a LightningCSS PR, branch or commit range (\"review lightningcss #1385\", \"is this lightningcss change safe\", \"check this PR against the spec and browsers\", \"/lightningcss-review 1385\"). SKIP for other repositories and for implementing LightningCSS features from scratch."
---

# LightningCSS PR review (`lcr`)

Devon's bottleneck is "verifying correctness. CSS has a lot of edge cases and many times people think
they understand how it works intuitively but in reality it's more complex or a small change affects
more than they think." This skill produces the evidence he would otherwise build by hand: what the
change does to output (isolated against the merge base), whether browsers agree the output means the
same as the input, what it does outside the area it claims to touch, and what the spec says.

The harness (`bin/lcr`) is deterministic. Same PR + same base + same images ⇒ same report, byte for
byte. Your job is the part a script cannot do: read the spec, write probes, classify what the oracle
could not decide, and fill the analysis slots. Everything you add goes into two places with fixed
formats: `<run>/probes/*.css` and `<run>/analysis.json`.

## Rules

1. **Never post to GitHub** (comments, reviews, labels, PR edits) unless the user explicitly asks for
   that specific action. The report is local. If asked to draft a PR comment, hand off to the user's
   comment-drafting skill when one exists (one that applies their own GitHub voice), keep it
   short and evidence-first (spec anchor, minimal repro, before/after output, which engines), and wait
   for an explicit "post it". Never paste the whole report into a comment.
2. **Never modify the user's LightningCSS checkout** (`lcr doctor` shows which one is used). The harness exports base/head trees into the run
   directory and instruments those copies only. Never commit anything there.
3. **The verdict comes from `lcr report`.** Do not override, soften or "round" it in your summary.
   To change the verdict, change the evidence (probes, classifications) and re-run the report.
4. **Run the phases in order.** If a command fails, fix the cause (see Troubleshooting) or stop and
   report INCONCLUSIVE with the failing command and its last lines. Never skip a phase silently.
5. **Evidence or it did not happen.** Every checklist answer, classification and finding cites a case
   id (`t-…`, `p-…`, `m-…`, `w-…`, `r-…`), a probe id, `file:line`, a spec `URL#anchor`, or command output.
6. **Spec first, then browsers, never folklore.** The CSS spec is the source of truth (Devon: "The CSS
   spec is the only sane source of truth"), but emitted syntax must also be accepted by the target
   browsers. When they disagree, say so explicitly.

## Setup (once per machine)

```sh
lcr=<this skill's directory>/bin/lcr   # e.g. ~/.claude/skills/lightningcss-review/bin/lcr
$lcr doctor          # git, gh auth, docker access, clone, disk
$lcr setup           # builder image (repo's rust-toolchain) + engine images; records versions
$lcr wpt             # pinned WPT checkout + property corpus (vendored from lightningcss#1328)
$lcr realworld       # pinned real-world stylesheets (sha256-verified)
$lcr selftest        # known-answer cases through every engine profile: must print 20/20
$lcr baseline        # curated probes on current master (re-run when master moves)
```

If `doctor` reports a docker permission problem, give the user the exact fix it prints. You cannot
grant group membership yourself. Images: `lcr-builder:rust-<channel>`, `lcr-browsers:pw-<version>`
(`config/engines.json`: `latest` = reference engines, `legacy-*` = old engines for lowering checks).

## Reading the results

- A **delta** is any normalized output difference between base and head for the same input and
  options. Deltas are the only thing attributed to the PR; pre-existing behavior never is.
- Oracle **transitions** (current engines, worst across Chromium/Firefox/WebKit): `regressed` (base
  matched the input, head does not) is the one that matters; `fixed` is credit; `both-equivalent` means
  the output changed but still renders like the input; `still-different` is pre-existing (base and head
  both differ from the input); `near-introduced` is drift within tolerance (e.g. 8-bit hex rounding);
  `unverified` means the DOM could not exercise it. Divergent engines (O9) mean the input itself is
  engine-dependent and the spec decides. Details and limitations: `references/oracle.md`.
- Legacy profiles only judge cases whose targets include that engine family at a version the engine
  satisfies; they check that lowered output renders in the old engine as the input does in the new one.

## Phase 1-3: automated

```sh
$lcr review <PR>        # = prepare + build + corpus; prints the run dir
```

- **prepare**: merges the PR head into current master with `git merge-tree` (no commit, no signing),
  exports both trees, classifies changed files into areas (`config/areas.json`), finds changed Rust
  items and their references (blast radius), risk flags, linked issues (`<run>/issues/*.json`),
  overlapping open PRs and CI checks. Output `prepare.json`, `diff.patch`.
- **build**: in the builder image, `cargo fmt --check` (pristine), then on an instrumented copy
  `cargo test --all-features` with `RUSTFLAGS=-D warnings` (CI parity) while every test-helper call
  is recorded as a tuple (source, expected, helper, targets, call-site line), plus the review adapter
  (`adapter/lcr_adapter.rs`) and the extra lanes CI lacks (`parcel_selectors` tests,
  `--no-default-features`, wasm32 gate, C bindings, generated-file drift). Output `build.json`.
- **corpus**: runs every case through the base and the head adapter with identical options. Sources:
  `tuple` (all recorded test expectations of both sides), `probe` (curated `corpus/probes/**` + PR
  probes), `mutation` (metamorphic variants of the PR's new test inputs: reversed declarations,
  `!important`, interleaved `var()`, prefixed siblings, `@media`/`@layer`/`@supports` wrapping,
  nesting, non-adjacent duplicates, retargeting), `wpt` (24k property values × print/minify/
  lower-minify), `realworld` (framework CSS, also size deltas). Any normalized difference between base
  and head output is a **delta**. Output `corpus.json`, `corpus/deltas.jsonl`.

Read the log lines: test results per side, delta counts per source, robustness (panics/timeouts),
and the tuple classification (new cases failing on base = the change is exercised; new cases passing
on base = tests that do not demonstrate the change; modified/removed expectations).

## Phase 4: analysis (you)

Work in this order. Do not start writing findings before 4.4.

**4.1 Understand the change.** Read `prepare.json` (`areas`, `radius_areas`, `risk_flags`,
`changed_items`, `blast_radius`, `linked_issues`, `overlapping_prs`), `diff.patch`, the PR body, and
each `issues/<n>.json`. State the intent in one or two sentences and list each behavior the PR claims
to change.

**4.2 Load the knowledge for the touched areas.** Always read `references/checklists/general.md`.
For every area in `prepare.json.areas`, read `references/checklists/<area>.md` and the matching
section of `references/spec/*.md` and `references/regressions.md`. Use `references/architecture.md`
to understand how the touched code is reached (handler order, flush rules, merging). Do not load
references for areas the PR does not touch unless `radius_areas` points there.

**4.3 Write probes** into `<run>/probes/` with the exact format in `templates/probe.css.tmpl`
(spec: `references/probe-format.md`). Required:
- one probe per linked issue, from its repro, `known: open-issue#<n>`, with the assertion the issue
  asks for (it must fail on base and pass on head);
- for every checklist item whose `verify:` asks for a probe, at least one probe;
- at least 3 probes per touched area covering the area checklist's edge cases that the PR's own
  tests do not cover (other order, `var()`, `!important`, prefixes, targets that need and do not need
  lowering, nesting, invalid input staying invalid).
Run `lcr validate-probes <run>/probes` until it reports 0 problems, then:

```sh
$lcr probe <run>        # runs PR probes (+ their mutations) on both builds
$lcr oracle <run>       # browsers: reference engines, then legacy engines for targeted cases
$lcr worklist <run>     # writes analysis.json with every slot the report needs; prints open slots
```

**4.4 Inspect** every case the worklist lists, with `lcr show <run> <case-id>` (input, both
outputs, per-engine diffs). Use the spec, not intuition, to decide whether each output is correct.

**4.5 Fill `analysis.json`** (`templates/analysis.template.json` documents every field):
- `intent`: `kind`, `summary`, `claims`, `behind_flag` (yes/no/n/a, see GEN-02).
- `checklist`: every item from `general.md` and each touched area's checklist, with
  `answer` = PASS | FAIL | N/A and `evidence`. N/A also needs evidence ("no handler changed: diff
  touches only src/values/color.rs").
- `deltas`: one entry per listed case (or a glob such as `w-*` / `source:wpt` for a homogeneous
  group, with the reason). Use exactly one classification:
  - `INTENDED`: the PR claims this change and the oracle shows head equivalent (or `fixed`).
  - `ACCEPTABLE_SIDE_EFFECT`: not claimed, but equivalent in every engine that ran, and spec-correct
    (e.g. shorter serialization).
  - `REGRESSION`: head output is wrong per the spec or the oracle (base right, head wrong). The report
    turns this into a BLOCKER.
  - `NEEDS_MAINTAINER_DECISION`: spec-correct but breaking, spec ambiguous, or a default changes.
  - `ORACLE_NOISE`: only for a documented oracle limitation (`references/oracle.md` §Limitations),
    named in the reason. Never use it to wave away a difference you do not understand.
  For any case the browsers call different (O1, O2, O7, O9), an `INTENDED`,
  `ACCEPTABLE_SIDE_EFFECT` or `ORACLE_NOISE` reason must cite the spec (`https://drafts.csswg.org/…#…`)
  or a WPT file; the report rejects it otherwise. **O9 (engines disagree)**: find which engine follows
  the current spec text and WPT, then classify the group (glob ids like `m-t-<id>-*` are fine): head
  agrees with the spec-conformant engines → `INTENDED`; the spec is new or contested and engines are
  split → `NEEDS_MAINTAINER_DECISION`; head agrees with none → `REGRESSION`.
- `findings`: problems not already produced by a failing check, each with severity
  (BLOCKER: wrong output or crash for valid CSS; MAJOR: missing tests for the change, unflagged draft,
  wrong lowering, behavior change without opt-in; MINOR: style/perf/docs; NOTE: context), evidence,
  and when possible a `suggested_test` in the repo's idiom (`minify_test(...)`, `prefix_test(...,
  Browsers { safari: Some(13 << 16), ..Browsers::default() })`, `nesting_test(...)`).

**4.6 Optional stages.** Run `$lcr perf <run>` (release builds, ~3-5 min) when the PR touches a
core file or a hot path (`risk_flags` contains `core-file`, or the diff changes the printer, a handler
loop, `CssRuleList::minify`, or value representations): it fills checks P1 (consistent slowdown on
the real-world corpus) and P2 (release binary size). Timing is noisy; P1 only fails on a consistent
>10% slowdown. `$lcr baseline` (once per master commit) records which curated probes fail on master
today; the report lists those for the touched areas so they are not blamed on the PR.

**4.7 Render**: `$lcr report <run>` then `$lcr summary <run>`. If `A3` fails, an analysis slot is
missing or lacks evidence: fix analysis.json and re-run. If you changed probes, re-run `probe`,
`oracle`, `worklist`, `report` in that order.

## Phase 5: present

Paste the output of `lcr summary <run>` verbatim (it is the fixed format). Below it you may add at
most five lines of your own: the single most important thing for the maintainer to look at, and any
check you could not run and why. Offer, in one line, to draft a PR comment from the report. Do not
draft or post one unless asked.

## Files

| Path | Purpose |
|---|---|
| `bin/lcr`, `lib/lcr/*.py` | harness (python3 stdlib only on the host) |
| `adapter/lcr_adapter.rs` | JSONL bridge compiled into each tree as an example (sheet / attr / property / value kinds) |
| `tests/`, `oracle/test/` | harness unit tests (`python3 -I -m unittest discover -s tests`) and the oracle self-test cases |
| `oracle/*.mjs`, `oracle/engine-runner.cjs` | DOM synthesis, engine runs, comparison (inside Docker) |
| `oracle/wpt/` | WPT extractor vendored from lightningcss#1328 |
| `config/*.json` | areas, modes/targets, engines, checks/thresholds, test map, property map, WPT revision, real-world pins |
| `corpus/probes/<area>/*.css` | curated probes (spec invariants, past regressions, issue repros) |
| `templates/` | probe, analysis and summary templates |
| `references/` | see below |

## References (load on demand)

| File | Read when |
|---|---|
| `references/checklists/general.md` | every review |
| `references/checklists/<area>.md` | the PR touches that area |
| `references/spec/<cluster>.md` | answering checklist items; writing probes (invariants with spec anchors) |
| `references/regressions.md` | the touched area: how past PRs broke it and what would have caught it |
| `references/architecture.md` | to understand handler order, flushing, rule merging, lowering, blast radius |
| `references/maintainer-playbook.md` | what Devon asks contributors to change; conventions; philosophy |
| `references/browsers.md` | engine divergences, prefix semantics, compat data generation |
| `references/ecosystem.md` | downstream users (Tailwind, Vite, Next/Turbopack, Rspack, Bun, Parcel) and their option sets |
| `references/oracle.md` | how verdicts are computed, tolerances, statuses, limitations |
| `references/probe-format.md` | probe syntax |
| `references/issues.md` | open correctness bugs (do not count them against a PR; do credit fixes) |

## Troubleshooting

- `docker socket permission denied`: the user must run `sudo usermod -aG docker $USER` (new login) or
  `sudo setfacl -m u:$USER:rw /var/run/docker.sock` (current session). With socket activation only
  (`docker.socket` enabled, `docker.service` not), the daemon starts on the first `lcr` call; that is
  fine. The ACL is lost when the socket is recreated (reboot); the group membership is not.
- `lcr selftest` fails: an engine image is broken or a Playwright/engine combination changed. Do not
  review with a failing self-test; rebuild with `lcr setup --rebuild`.
- `adapter … error[E…]` in build.json: the adapter does not compile against that revision (API
  drift). Fix `adapter/lcr_adapter.rs` so it compiles against both sides, then `lcr build` again.
- `T5` lists unreproduced tuples: the helper mapping in `lib/lcr/tuples.py` does not match a changed
  helper. Those tuples are excluded from conclusions. Fix the mapping if the PR changed helpers.
- Many `unverified` deltas: DOM synthesis could not match the selectors (`lcr show` shows the DOM
  stats). Write a probe with a `dom:` line for the important ones, or classify the group.
- WPT lane missing: run `lcr wpt` once. Real-world lane missing: `lcr realworld` once.
