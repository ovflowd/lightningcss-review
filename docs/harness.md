# How the harness works

`bin/lcr` runs stages that each read and write files in a run directory,
`<cache>/runs/<run-id>/` (cache: `$LCR_CACHE`, default `~/.cache/lightningcss-review`). The run id
encodes the inputs, `pr<N>-h<pr head>-b<base>`, so a new push or a moved `master` gives a new run.
Every stage can be re-run on its own; later stages read only the files listed here.

| Stage | Reads | Writes |
|---|---|---|
| `prepare <PR>` | GitHub (read-only), the Lightning CSS clone | `prepare.json`, `diff.patch`, `src/base/`, `src/head/`, `issues/<n>.json` |
| `build` | `src/*` | `build/<side>/` (instrumented tree, logs, `tuples.jsonl`, `tests.json`), `bin/<side>-adapter`, `build.json` |
| `corpus` | adapters, probes, WPT fixtures, real-world files | `corpus/cases.jsonl`, `corpus/outputs-{base,head}.jsonl`, `corpus/deltas.jsonl`, `corpus.json` |
| `probe` | `probes/*.css` in the run | merges PR probes (and their mutations) into the corpus files |
| `oracle` | corpus files, `env.json` | `oracle/` (jobs, raw engine results, screenshots), `oracle.json`, `spec-cards.json` |
| `worklist` | everything above | `analysis.json` skeleton with the open slots |
| `report` | everything above + `analysis.json` | `report.md`, `report.json` |
| `perf` (optional) | `src/*`, real-world files | `perf/`, `perf.json` |

## Base and head

`prepare` computes the tree you get by merging the PR head into current `master`
(`git merge-tree --write-tree`); nothing is committed. If that conflicts, head is the PR head and
base its merge base, and the report says so. Both trees are exported with `git archive`.

## Test tuples

`build` patches a copy of `src/lib.rs` (never the clone): every leaf test helper gets a one-line
call that records its arguments and call site (`#[track_caller]`), keeping line numbers intact.
`lib/lcr/tuples.py` maps each helper back to an adapter request with the same parse, minify and
print options, so every expectation of either side runs on both builds. `T5` reports any recorded
expectation the adapter does not reproduce.

## The adapter

`adapter/lcr_adapter.rs` is copied into each tree as a Cargo example and built with the same
features and flags as the tests. It reads one JSON request per line (`sheet`, `attr`, `property`,
`value` kinds) and answers with the output or the failing stage; panics are caught, aborts and
timeouts restart the process. It uses only public API so the same file compiles against old and
new revisions.

## Verdict

`config/checks.json` lists every check with the severity a failure carries. `lib/lcr/report.py`
evaluates each from the stage files, adds the reviewer's checklist answers and findings, and
applies the rule: any BLOCKER is `UNSAFE`, any MAJOR `NEEDS_CHANGES`, any MINOR `SAFE_WITH_NITS`,
otherwise `SAFE`; a missing stage turns a clean result into `INCONCLUSIVE`. Every check appears in
every report, in catalog order, so reports diff cleanly.

## The oracle

See [`references/oracle.md`](../references/oracle.md) for how DOMs are synthesized, how values are
compared, what each status means, and the known limitations.

## Adding things

- A check: add it to `config/checks.json`, evaluate it in `lib/lcr/report.py`, cover it with a
  unit test or a self-test case.
- An engine profile: add it to `config/engines.json` (a Playwright release), run
  `lcr setup --profiles <name>`, then `lcr selftest`.
- A mutation: `lib/lcr/mutations.py`; it must be deterministic and produce valid CSS or `None`.
- Probes and checklists: see [CONTRIBUTING.md](../CONTRIBUTING.md).
