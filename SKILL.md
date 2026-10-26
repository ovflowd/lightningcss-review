---
name: lightningcss-review
description: "Deterministic correctness review of parcel-bundler/lightningcss pull requests. Builds base and head in Docker, diffs their output on the PR's own tests, every existing test expectation, curated edge cases, metamorphic variants, WPT and real-world CSS, checks semantics in headless Chromium/Firefox/WebKit (current and legacy engines), runs the spec checklists, and renders a fixed-format report with a rule-based verdict (UNSAFE / NEEDS_CHANGES / SAFE_WITH_NITS / SAFE / INCONCLUSIVE). TRIGGER when asked to review, verify, test or assess the safety of a LightningCSS PR, branch or commit range (\"review this lightningcss PR\", \"is this lightningcss change safe\", \"check this PR against the spec and browsers\", \"/lightningcss-review <PR>\"). SKIP for other repositories and for implementing LightningCSS features from scratch."
---

# LightningCSS PR review (`lcr`)

This skill builds the evidence a maintainer would build by hand: what the change does to output
against the merge base, whether browsers agree output and input mean the same, what it does
outside its area, and what the spec says.

The harness (`bin/lcr`) is deterministic. Your part is what a script cannot do: read the spec,
write the probes the corpus lacks, classify what the oracle could not decide, and fill the analysis
slots, in `<run>/probes/*.css` and `<run>/analysis.json`.

## Rules

1. **Never post to GitHub** unless the user explicitly asks for that action. Drafted comments are
   short and evidence-first (spec anchor, repro, before/after output).
2. **Never modify the user's LightningCSS checkout** (`lcr doctor` shows which one is used).
3. **The verdict comes from `lcr report`.** Never override or soften it. To change it, change the
   evidence (probes, classifications) and re-run the report.
4. **Run the phases in order.** If a command fails, fix the cause (Troubleshooting) or stop and
   report INCONCLUSIVE with the failing command and its last lines. Never skip a phase silently.
5. **Evidence or it did not happen.** Every answer, classification and finding cites a case id
   (`t-…`, `p-…`, `m-…`, `w-…`, `r-…`), a probe id, a file and function, a spec `URL#anchor`, or
   command output.
6. **Spec first, then browsers, never folklore.** The spec decides what is correct; emitted syntax
   must also be accepted by the target browsers. A CSSWG resolution backed by every engine and WPT
   outranks stale draft grammar text. When they disagree, say so.
7. **Charge the PR only with what it changes.** What base already does wrong the same way is
   pre-existing (FAIL_PRE_EXISTING, PRE_EXISTING), never a FAIL or REGRESSION.
8. **Spend tokens on judgment, not on reading.** Use `lcr brief`, `lcr table` and `lcr show`
   instead of opening run JSON files. Load only the references the loading policy names.

## Setup (once per machine)

```sh
lcr=<this skill's directory>/bin/lcr
$lcr doctor      # git, gh auth, docker, clone, disk
$lcr setup       # builder image + engine images; records versions
$lcr wpt         # pinned WPT checkout and property corpus
$lcr realworld   # pinned real-world stylesheets (sha256-verified)
$lcr selftest    # known-answer cases through every engine profile: must pass all
$lcr baseline    # curated probes on current master (re-run when master moves)
```

`config/engines.json`: `latest` is the reference profile, `legacy-*` old engines for lowering.

## Reading the results

- A **delta** is a normalized output difference between base and head for the same input and
  options. Only deltas are attributed to the PR.
- Oracle **transitions** (`references/oracle.md`): `regressed` and `worsened` matter; `introduced`
  judges head alone (base lacks the PR's flag); `fixed` is credit; `errored` is never verified nor
  different; `input-rejected` needs a decision, not a verdict. O9: engines disagree on the input.
- T6: probe assertions head breaks. O10 and "Decision needed": cases browsers cannot judge
  against base, plus NEEDS_MAINTAINER_DECISION entries.
- Legacy profiles judge only cases whose targets include that engine at a version it satisfies.

## Phase 1-3: automated

```sh
$lcr review <PR>     # prepare + build + corpus, then prints the brief
$lcr brief <run>     # the one-screen digest again: files, items, flags, issues, tests, deltas
```

`corpus` runs every case on both builds: `tuple` (recorded test expectations), `probe`,
`mutation` (variants of new test inputs), `wpt`, `realworld`. In the brief,
`new_failing_on_base` tuples show the change is exercised; `new_passing_on_base` tuples do not;
modified or removed expectations need a reason.

## Phase 4: analysis (you)

**4.1 Understand the change.** From `lcr brief`, `diff.patch` and each linked issue file, state the
intent in one or two sentences and list each behavior the PR claims to change.

**4.2 Load only what the change needs.**
- Always: `references/checklists/general.md`.
- Each code area in `areas`: `references/checklists/<area>.md`. Test-derived and `radius adds`
  areas are context: load their checklists only if the diff reaches their code.
- A spec digest only when a `verify:` points to it or a delta needs a ruling (that section only).
- `references/architecture.md` if `risk_flags` has `core-file`; `conventions.md` for findings.

**4.2b Thread and reach.** Answer each maintainer request or question in the thread with
evidence; run any WPT file a maintainer names. Name duplicate or alternative PRs and recommend
one. For each regression state its reach: real-world hits, common patterns, flag or default path,
pre-existing defect newly reachable.

**4.3 Write probes only where evidence is missing.** Format: `templates/probe.css.tmpl`, spec
`references/probe-format.md`.
- At least 3 probes per code area with CSS behavior (`tests`, `docs`, `bindings-api`,
  `build-release` need none). A curated probe, mutation or PR test that covers an item satisfies
  its `verify:`; never restate existing cases.
- Linked issue: one probe from its repro with `repro: #N`. If base is already browser-equivalent
  on it, assert the requested output (`output-contains`/`output-equals`) and add a probe for the
  browser-visible variant. A request contradicting the spec: assert the spec, note it in `intent`.
  List each part of the issue's expected behavior the PR does not deliver. Closed or related
  issues use `known: fixed-by#PR`.
- Pitfalls: the synthesized element is a `div` (a UA-default value has no coverage); conditional
  probes need an unconditional baseline and a true/false pair; prefer chrome targets for lowering
  equivalence; each probe spawns about 12 mutations. `lcr validate-probes <run>/probes` → 0.

```sh
$lcr probe <run>      # PR probes (and their mutations) on both builds
$lcr oracle <run>     # reference engines, then legacy engines for targeted cases
$lcr worklist <run>   # writes analysis.json with every slot; prints the open slots
```

Errored oracle jobs: `lcr oracle <run> --rerun <ids>`. Never cite browser output the report
cannot read.

**4.4 Inspect** listed cases with `lcr table <run>` and `lcr show <run> <case-id>`; for a large
homogeneous group, inspect a few and classify the group with a glob.

**4.5 Fill `analysis.json`** (`templates/analysis.template.json` documents every field):
- `intent`: `kind`, `summary`, `claims`, `behind_flag`.
- `checklist`: every listed item, `answer` PASS | FAIL | FAIL_PRE_EXISTING | N/A with `evidence`.
  N/A needs evidence ("diff touches only src/values/color.rs"). FAIL_PRE_EXISTING cites a base
  case or probe that fails the same way (a NOTE). A FAIL says why each `verify:` alternative fails.
  `effective_severity` + `severity_reason` may lower an item's severity, never raise it. Link an
  answer to the finding it restates with `finding: F<n>`. A whole area may be N/A:
  `{"area": "<area>", "answer": "N/A", "evidence": …}`.
- `deltas`: one entry per listed case, or a glob (`m-t-<id>-*`) for a group sharing one root
  cause. Globs match in file order and the first match wins; a glob never clears a `regressed`
  case unless REGRESSION; no catch-all source glob (`w-*`, `source:wpt`). Exactly one classification:
  - `INTENDED`: claimed by the PR and equivalent (or `fixed`) in the oracle.
  - `ACCEPTABLE_SIDE_EFFECT`: unclaimed, equivalent in every engine that ran, spec-correct.
  - `REGRESSION`: base matched the browsers (or the spec, per engine) and head does not. Group by
    root cause, one glob each.
  - `PRE_EXISTING`: base is wrong the same way; cites a probe, issue or base case (a NOTE at most).
  - `NEEDS_MAINTAINER_DECISION`: spec-correct but breaking, spec ambiguous, a default changes, or
    pre-existing behavior extended to new targets. Caps the verdict at NEEDS_CHANGES. First grep
    base `src/lib.rs` tests for the same input under other targets and cite what you find.
  - `ORACLE_NOISE`: only for a limitation in `references/oracle.md`, named in the reason; also an
    initial-value or no-touched-property case (cite its L-number).
  An `unverified` delta whose parent case is verified takes the parent's classification and cites
  it. For cases the browsers call different, a non-REGRESSION reason cites a spec anchor or WPT
  file. For O9, judge each engine against the spec meaning of the input in that engine: REGRESSION
  only if base matched in every engine where head does not; if base was also wrong somewhere, use
  PRE_EXISTING or NEEDS_MAINTAINER_DECISION; spec new or contested → NEEDS_MAINTAINER_DECISION.
- `findings`: problems no failing check reports, with severity (BLOCKER: wrong output or crash
  for valid CSS; MAJOR: missing tests, unflagged draft, wrong lowering, behavior change without
  opt-in; MINOR: style, perf, docs; NOTE: context), evidence, and a `suggested_test` if possible.

**4.6 Optional.** `$lcr perf <run>` when `risk_flags` contains `core-file` or the diff touches a
hot path (P1 slowdown, P2 binary size). A property's `ToCss` change is not a printer change unless
it touches `src/printer.rs` or a shared serializer.

**4.7 Render.** `$lcr report <run>`, then `$lcr summary <run>`. If `A3` fails, fix analysis.json
and re-run. Re-run `lcr worklist` after classifying until it reports 0 open slots. After changing
probes, re-run `probe`, `oracle`, `worklist`, `report` in that order.

## Phase 5: present

Paste `lcr summary <run>` verbatim. Below it, at most five lines of your own: the most
important thing for the maintainer to look at, and any check you could not run and why. Offer in
one line to draft a PR comment; do not draft or post one unless asked.

## References

| File | Read when |
|---|---|
| `references/spec/<cluster>.md` | a `verify:` points there or a delta needs a spec ruling |
| `references/architecture.md` | the diff touches handlers, flushing, merging, printing, minify |
| `references/conventions.md` | writing findings and suggested tests in the project's idiom |
| `references/browsers.md` | an engine divergence, prefix semantics or compat data question |
| `references/ecosystem.md` | an option or default change that downstream tools rely on |
| `references/oracle.md` | a status, transition or limitation to cite |
| `references/probe-format.md` | writing probes |


## Troubleshooting

- Docker socket permission denied: give the user the fix `lcr doctor` prints.
- `lcr selftest` fails: an engine image is broken. Do not review; run `lcr setup --rebuild`.
- Adapter compile error in the build log: API drift. Fix `adapter/lcr_adapter.rs` so it compiles
  against both sides, then `lcr build` again.
- `T5` lists unreproduced tuples: `lib/lcr/tuples.py` misses a changed test helper; those are
  excluded from conclusions until the mapping is fixed.
- Many `unverified` deltas: DOM synthesis could not match the selectors (`lcr show` prints DOM
  stats). Write a probe with a `dom:` line for the important ones, or classify the group.
- WPT or real-world lane missing: `lcr wpt` / `lcr realworld` once.
