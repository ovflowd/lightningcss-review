---
name: lightningcss-review
description: "Deterministic correctness review of parcel-bundler/lightningcss pull requests. Builds base and head in Docker, diffs their output on the PR's own tests, every existing test expectation, curated edge cases, metamorphic variants, WPT and real-world CSS, checks semantics in headless Chromium/Firefox/WebKit (current and legacy engines), runs the spec checklists, and renders a fixed-format report with a rule-based verdict (UNSAFE / NEEDS_CHANGES / SAFE_WITH_NITS / SAFE / INCONCLUSIVE). TRIGGER when asked to review, verify, test or assess the safety of a LightningCSS PR, branch or commit range (\"review this lightningcss PR\", \"is this lightningcss change safe\", \"check this PR against the spec and browsers\", \"/lightningcss-review <PR>\"). SKIP for other repositories and for implementing LightningCSS features from scratch."
---

# LightningCSS PR review (`lcr`)

CSS has many edge cases, and a small change often affects more than its author thinks. This skill
produces the evidence a maintainer would otherwise build by hand: what the change does to output
(isolated against the merge base), whether browsers agree the output means the same as the input,
what it does outside the area it claims to touch, and what the spec says.

The harness (`bin/lcr`) is deterministic: same PR, base and images give the same report, byte for
byte. Your part is what a script cannot do: read the spec, write the few probes the corpus lacks,
classify what the oracle could not decide, and fill the analysis slots. Everything you add goes into
`<run>/probes/*.css` and `<run>/analysis.json`, both with fixed formats.

## Rules

1. **Never post to GitHub** (comments, reviews, labels, PR edits) unless the user explicitly asks for
   that action. The report is local. A drafted comment is short and evidence-first (spec anchor,
   minimal repro, before/after output, engines) and waits for an explicit "post it".
2. **Never modify the user's LightningCSS checkout** (`lcr doctor` shows which one is used). The
   harness exports base and head into the run directory and instruments those copies only.
3. **The verdict comes from `lcr report`.** Never override or soften it. To change it, change the
   evidence (probes, classifications) and re-run the report.
4. **Run the phases in order.** If a command fails, fix the cause (Troubleshooting) or stop and
   report INCONCLUSIVE with the failing command and its last lines. Never skip a phase silently.
5. **Evidence or it did not happen.** Every answer, classification and finding cites a case id
   (`t-…`, `p-…`, `m-…`, `w-…`, `r-…`), a probe id, a file and function, a spec `URL#anchor`, or
   command output.
6. **Spec first, then browsers, never folklore.** The spec decides what is correct; emitted syntax
   must also be accepted by the target browsers. When they disagree, say so.
7. **Spend tokens on judgment, not on reading.** Use `lcr brief` and `lcr show` instead of opening
   run JSON files. Load only the references the loading policy below names.

## Setup (once per machine)

```sh
lcr=<this skill's directory>/bin/lcr
$lcr doctor      # git, gh auth, docker access, clone, disk
$lcr setup       # builder image + engine images; records versions
$lcr wpt         # pinned WPT checkout and property corpus
$lcr realworld   # pinned real-world stylesheets (sha256-verified)
$lcr selftest    # known-answer cases through every engine profile: must pass all
$lcr baseline    # curated probes on current master (re-run when master moves)
```

If `doctor` reports a docker permission problem, give the user the fix it prints; you cannot grant
group membership. Engine profiles live in `config/engines.json`: `latest` is the reference,
`legacy-*` are old engines for lowering checks.

## Reading the results

- A **delta** is a normalized output difference between base and head for the same input and
  options. Only deltas are attributed to the PR; pre-existing behavior never is.
- Oracle **transitions** (worst across current engines): `regressed` (base matched the input, head
  does not) is what matters; `fixed` is credit; `both-equivalent` means output changed but renders
  the same; `still-different` is pre-existing; `near-introduced` is drift within tolerance;
  `unverified` means the DOM could not exercise it. O9 (engines disagree) means the input itself is
  engine-dependent and the spec decides.
- Legacy profiles judge only cases whose targets include that engine at a version it satisfies:
  lowered output must render in the old engine as the input does in the new one.

## Phase 1-3: automated

```sh
$lcr review <PR>     # prepare + build + corpus, then prints the brief
$lcr brief <run>     # the one-screen digest again: files, items, flags, issues, tests, deltas
```

`prepare` merges the PR head into current master without committing, exports both trees, maps
files to areas, finds changed Rust items, blast radius, risk flags, linked issues and overlapping
PRs. `build` runs fmt, the full test suite with CI flags while recording every test-helper call as
a tuple, the review adapter and lanes CI lacks. `corpus` runs every case on both builds: `tuple`
(all test expectations of both sides), `probe`, `mutation` (metamorphic variants of the PR's new
test inputs), `wpt` and `realworld`.

In the brief, `new_failing_on_base` tuples show the change is exercised; `new_passing_on_base`
tuples are tests that do not demonstrate it; modified or removed expectations need a reason.

## Phase 4: analysis (you)

**4.1 Understand the change.** From `lcr brief`, `diff.patch` and each linked issue file, state the
intent in one or two sentences and list each behavior the PR claims to change.

**4.2 Load only what the change needs.**
- Always: `references/checklists/general.md`.
- Each area in `areas` (not `radius adds`): `references/checklists/<area>.md`.
- A spec digest (`references/spec/*.md`) only when a checklist item's `verify:` points to it or a
  delta needs a spec ruling; read the relevant section, not the whole file.
- `references/architecture.md` only when the diff touches handler, flush, merge, printer or
  minify code (`risk_flags` contains `core-file`).
- `references/conventions.md` when writing findings or suggested tests.
- Other references only to answer a specific question (table below).

**4.3 Write probes only where evidence is missing.** Format: `templates/probe.css.tmpl`, spec
`references/probe-format.md`.
- One probe per linked issue, from its repro, `known: open-issue#<n>`, asserting what the issue
  asks for (fails on base, passes on head).
- One probe for each checklist item whose `verify:` asks for a probe that the corpus, mutations
  and the PR's tests do not already cover. Do not write probes that restate existing cases.
- Run `lcr validate-probes <run>/probes` until it reports 0 problems.

```sh
$lcr probe <run>      # PR probes (and their mutations) on both builds
$lcr oracle <run>     # reference engines, then legacy engines for targeted cases
$lcr worklist <run>   # writes analysis.json with every slot; prints the open slots
```

**4.4 Inspect** the cases the worklist lists with `lcr show <run> <case-id>` (input, both outputs,
per-engine diffs). For a large homogeneous group, inspect a few representatives and classify the
group with a glob. Decide correctness from the spec, not intuition.

**4.5 Fill `analysis.json`** (`templates/analysis.template.json` documents every field):
- `intent`: `kind`, `summary`, `claims`, `behind_flag` (yes/no/n/a).
- `checklist`: every listed item, `answer` PASS | FAIL | N/A with `evidence`. N/A also needs
  evidence ("no handler changed: diff touches only src/values/color.rs").
- `deltas`: one entry per listed case, or a glob (`w-*`, `m-t-<id>-*`, `source:wpt`) for a
  homogeneous group, with exactly one classification:
  - `INTENDED`: claimed by the PR and equivalent (or `fixed`) in the oracle.
  - `ACCEPTABLE_SIDE_EFFECT`: unclaimed, equivalent in every engine that ran, spec-correct.
  - `REGRESSION`: head wrong per spec or oracle, base right. Becomes a BLOCKER.
  - `NEEDS_MAINTAINER_DECISION`: spec-correct but breaking, spec ambiguous, or a default changes.
  - `ORACLE_NOISE`: only for a limitation listed in `references/oracle.md`, named in the reason.
    Never use it for a difference you do not understand.
  For cases the browsers call different (O1, O2, O7, O9), an `INTENDED`, `ACCEPTABLE_SIDE_EFFECT`
  or `ORACLE_NOISE` reason must cite a spec anchor or a WPT file; the report rejects it otherwise.
  For O9, find which engine follows the current spec and WPT: head agrees with the conformant
  engines → `INTENDED`; spec new or contested and engines split → `NEEDS_MAINTAINER_DECISION`;
  head agrees with none → `REGRESSION`.
- `findings`: problems no failing check already reports, with severity (BLOCKER: wrong output or
  crash for valid CSS; MAJOR: missing tests, unflagged draft feature, wrong lowering, behavior
  change without opt-in; MINOR: style, perf, docs; NOTE: context), evidence, and when possible a
  `suggested_test` in the repo's idiom (`minify_test`, `prefix_test` with `Browsers { … }`,
  `nesting_test`).

**4.6 Optional.** `$lcr perf <run>` (release builds, a few minutes) when `risk_flags` contains
`core-file` or the diff touches a hot path: fills P1 (consistent >10% slowdown on real-world CSS)
and P2 (binary size).

**4.7 Render.** `$lcr report <run>`, then `$lcr summary <run>`. If `A3` fails, a slot is missing
or lacks evidence: fix analysis.json and re-run. After changing probes, re-run `probe`, `oracle`,
`worklist`, `report` in that order.

## Phase 5: present

Paste `lcr summary <run>` verbatim. Below it, at most five lines of your own: the single most
important thing for the maintainer to look at, and any check you could not run and why. Offer in
one line to draft a PR comment; do not draft or post one unless asked.

## References

| File | Read when |
|---|---|
| `references/checklists/general.md` | every review |
| `references/checklists/<area>.md` | the PR touches that area |
| `references/spec/<cluster>.md` | a `verify:` points there or a delta needs a spec ruling |
| `references/architecture.md` | the diff touches handlers, flushing, merging, printing, minify |
| `references/conventions.md` | writing findings and suggested tests in the project's idiom |
| `references/browsers.md` | an engine divergence, prefix semantics or compat data question |
| `references/ecosystem.md` | an option or default change that downstream tools rely on |
| `references/oracle.md` | a status or limitation you need to cite |
| `references/probe-format.md` | writing probes |

Harness internals are in `docs/harness.md`; you do not need them to review.

## Troubleshooting

- Docker socket permission denied: the user runs `sudo usermod -aG docker $USER` (new login) or
  `sudo setfacl -m u:$USER:rw /var/run/docker.sock` (this session; lost on reboot). With only
  `docker.socket` enabled, the daemon starts on the first `lcr` call.
- `lcr selftest` fails: an engine image is broken. Do not review; run `lcr setup --rebuild`.
- Adapter compile error in the build log: API drift. Fix `adapter/lcr_adapter.rs` so it compiles
  against both sides, then `lcr build` again.
- `T5` lists unreproduced tuples: `lib/lcr/tuples.py` does not match a changed test helper. Those
  tuples are excluded from conclusions; fix the mapping if the PR changed helpers.
- Many `unverified` deltas: DOM synthesis could not match the selectors (`lcr show` prints DOM
  stats). Write a probe with a `dom:` line for the important ones, or classify the group.
- WPT or real-world lane missing: run `lcr wpt` or `lcr realworld` once.
