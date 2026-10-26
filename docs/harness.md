# How the harness works

`bin/lcr` runs stages that each read and write files in a run directory,
`<cache>/runs/<run-id>/` (cache: `$LCR_CACHE`, default `~/.cache/lightningcss-review`). The run id
encodes the inputs, `pr<N>-h<pr head>-b<base>`, so a new push or a moved `master` gives a new run.
Every stage can be re-run on its own; later stages read only the files listed here.

| Stage | Reads | Writes |
|---|---|---|
| `prepare <PR>` | GitHub (read-only), the Lightning CSS clone | `prepare.json`, `diff.patch`, `src/base/`, `src/head/`, `issues/<n>.json` |
| `build` | `src/*` | `build/<side>/` (instrumented tree, logs including `fetch.log`, `tuples.jsonl`, `tests.json`), `bin/<side>-adapter`, `build.json` |
| `corpus` | adapters, probes, WPT fixtures, real-world files | `corpus/cases.jsonl`, `corpus/outputs-{base,head}.jsonl`, `corpus/deltas.jsonl`, `corpus.json` |
| `probe` | `probes/*.css` in the run | merges PR probes (and their mutations) into the corpus files |
| `oracle` | corpus files, `env.json` | `oracle/` (jobs, raw engine results, screenshots), `oracle.json`, `spec-cards.json` |
| `worklist` | everything above | `analysis.json` skeleton with the open slots |
| `report` | everything above + `analysis.json` | `report.md`, `report.json` |
| `perf` (optional) | `src/*`, real-world files | `perf/` (release binaries, `<side>-fetch.log`), `perf.json` (with `skip_reason` when the release binaries look stale: P1/P2 SKIP) |

Every command that works on a run takes the run id (or `latest`, or a PR number) explicitly and
prints the run it resolved to; nothing falls back to an implicit "last run".

Inspection and housekeeping:

- `lcr table <run> [--transition t1,t2] [--check O9] [--case <glob>] [--json]`: one line per oracle
  case (transition, base/head status, wrong engines per side, legacy transitions). Before the oracle
  runs it prints output-only rows (id, source, area, base/head ok, changed), deltas only unless
  `--case` is given.
- `lcr show <run> <case>`: input, outputs and a per-engine `element | property | input | base | head`
  table; `--json` prints everything untruncated.
- `lcr oracle <run> --rerun <ids|globs>`: re-run only those cases and merge their verdicts. `lcr
  oracle` exits non-zero when a probe case, or more than 5% of the cases, errored in an engine.
- `lcr clean <run>` drops the run's build trees; `lcr clean --results` drops raw oracle results and
  screenshots once `verdicts.jsonl` exists. Stages check free space first and warn when the cache
  is on tmpfs.

## Base and head

`prepare` computes the tree you get by merging the PR head into current `master`
(`git merge-tree --write-tree`); nothing is committed. If that conflicts, head is the PR head and
base its merge base, and the report says so. Both trees are exported with `git archive`.

## Test tuples

`build` patches a copy of `src/lib.rs` (never the clone): every leaf test helper gets a one-line
call that records its arguments and call site (`#[track_caller]`), keeping line numbers intact.
`lib/build/tuples.js` maps each helper back to an adapter request with the same parse, minify and
print options, so every expectation of either side runs on both builds. `T5` reports any recorded
expectation the adapter does not reproduce.

## The adapter

`adapter/lcr_adapter.rs` is copied into each tree as a Cargo example and built with the same
features and flags as the tests. It reads one JSON request per line (`sheet`, `attr`, `property`,
`value` kinds) and answers with the output or the failing stage; panics are caught, aborts and
timeouts restart the process. It uses only public API so the same file compiles against old and
new revisions.

The head adapter is the pull request's code, so every adapter process runs in its own
`builder-sandbox` container of its side's builder image (`lib/adapter/sandbox.js`), with only the
binary mounted, read-only. The container prints a ready line before it runs the adapter, so its
start never counts against a request's timeout; a timeout, crash or close kills the container by
name. An adapter killed by a signal used to report minus the signal number; through tini it exits
with 128 plus the number, which the client maps back, so `adapter exited (-6); stack overflow or
abort` reads as before. An adapter that exits with a status above 128 by itself reads the same way
(the two cannot be told apart through a container). The container gets the host's stack limit,
so a stack overflow happens at the same nesting depth. `LCR_BUILD=host` runs the adapters on the
host instead, and an adapter built that way is refused in a container (its libc is the host's).

## Containers and caches

Three services share the builder image (`compose.yaml`). `builder` has the network and runs only
`cargo fetch` (on a throwaway copy of the tree without `.cargo/` or the toolchain file) and the JS
lane's `yarn install --ignore-scripts --no-default-rc`. `builder-offline` runs everything that
executes the tree's code, with `CARGO_NET_OFFLINE` and the Cargo home read-only: `cargo fmt`, the
tests, the adapter build, the lanes, the JS lane's other steps and perf's release build.
`builder-sandbox` runs built binaries: the adapters, and perf's timing runner
(`docker/cli-runner.mjs`, base and head interleaved in one container, timed inside it). See
[SECURITY.md](../SECURITY.md) for what each one mounts.

Cargo target directories live in `<cache>/targets/` (`lib/build/target-dirs.js`). Base's (`base`,
`base-nowarn`, `base-release`, `js-base`) are shared by every run. Before head builds, each head
directory is replaced by a copy of its base counterpart (`cp --reflink=auto`, so on btrfs or XFS
it takes a fraction of a second), under head's lock and, while copying, base's: `build` seeds
`head` and `head-nowarn` before the two sides start, `perf` seeds `head-release` after building
base, and the JS lane runs base first and seeds `js-head` from `js-base`. Head therefore starts
warm, and nothing a pull request built survives into another run.

Lightning CSS itself is not always deterministic: on a few very large real-world sheets, and on
rule deduplication whose result depends on hash order (the curated probe
`rule-merging/stale-dedupe-key-idempotent`), the same build sometimes gives a different output
for the same request. A single real-world delta, or one from that probe, that does not reproduce
on a re-run is that noise, not the PR. The same goes for a B1 failure of upstream's
`bundler::tests::test_bundle` (media query order) on either side: re-run `lcr build`.

## Verdict

`config/checks.json` lists every check with the severity a failure carries. `lib/report/`
(`evaluate.js`, one module per check group under `checks/`) evaluates each from the stage files,
adds the reviewer's checklist answers and findings, and applies the rule: any BLOCKER is
`UNSAFE`, any MAJOR `NEEDS_CHANGES`, any MINOR `SAFE_WITH_NITS`, otherwise `SAFE`; a missing stage
turns a clean result into `INCONCLUSIVE`. Every check appears in every report, in catalog order,
so reports diff cleanly.

Checks compare head with base, so behavior base already has is never charged to the PR: a checklist
answer `FAIL_PRE_EXISTING` and a `PRE_EXISTING` delta become NOTEs, and so does a T6 failure on a
probe either one names (directly or through its linked finding); a
`NEEDS_MAINTAINER_DECISION` delta feeds a "Decision needed" line (below). An `effective_severity`
on a checklist answer can only lower its severity. Answers and deltas that name an analysis finding
(`"finding": "F3"`) fold into it as evidence, so one defect is counted once; so do check failures
whose cases an analysis finding cites, REGRESSION entries sharing a reason, and a checklist FAIL
whose `same-root-as:` item also failed.

Other verdict rules:

- A check can be `INCONCLUSIVE` (O8 when deltas errored in an engine, A2 when the oracle could not
  judge the linked issue's repro); any INCONCLUSIVE check turns a SAFE or SAFE_WITH_NITS result
  into `INCONCLUSIVE`. An incomplete analysis (A3 fails) makes every verdict short of `UNSAFE`
  `INCONCLUSIVE`: its own MAJOR says nothing about the PR, but a proven BLOCKER still stands.
- T6 fails for probe assertions that hold on base and fail on head. O10 lists cases the browsers
  cannot judge against base (`input-rejected`, or head output equal to what base gives the same
  input under other targets); with NEEDS_MAINTAINER_DECISION entries they make up the
  "Decision needed" lines of the report and summary. A decision is MAJOR only when the oracle
  shows head worse than base, otherwise a NOTE, so it never makes the verdict `UNSAFE`.
- When every delta needs a parser flag the PR adds (`corpus.json` `flag_only`), the verdict carries
  a scope, e.g. `UNSAFE (flag custom-functions only)`, and the summary adds "default path
  byte-identical (N requests)".
- Classifications match in file order and the first match wins. A glob may not clear a `regressed`
  case unless it is REGRESSION; a catch-all (`w-*`, `m-t-*`, `source:wpt`) must cover cases of a
  single transition; REGRESSION is rejected where base is wrong in every engine where head is.
- A checklist answer `{"area": "<area>", "answer": "N/A", "evidence": …}` answers every item of
  that (non-general) area that has no answer of its own.

## The worklist

`lcr worklist <run>` writes every slot into `analysis.json`, keeping existing answers, and prints
`{checklist, prefilled_na, deltas: [{id, checks, count}], stale_slots, linked_issues, intent}`.
Slots come from the same uncapped lists the report evaluates (`open_slots()`); a mutation family
with no oracle-bad case becomes one glob slot with its count. A checklist item with a
`covers: <glob>, …` line starts as N/A when the diff touches none of those files. A slot whose case
no longer fails is marked `_stale` and ignored by A3.

## The oracle

See [`references/oracle.md`](../references/oracle.md) for how DOMs are synthesized, how values are
compared, what each status and transition means, and the known limitations. Jobs that errored can
be re-run on their own with `lcr oracle <run> --rerun <ids>`.

The oracle scripts (`oracle/prepare-jobs.mjs`, `oracle/compare.mjs`, `oracle/spec-cards.mjs`,
`oracle/engine-runner.cjs`) run inside the browser images; `lcr oracle` and `lcr selftest` call
them with fixed flags. Run by hand, an unknown option, a missing value or a stray argument prints
the usage and exits 2.

## Code map

The host side is plain Node.js (24 or newer, ES modules, no runtime dependencies), type-checked
from its JSDoc with `tsc --checkJs`. One directory per stage under `lib/`, each entry module named
after its stage, with its unit tests in a `test/` directory next to it:

| Directory | Contents |
|---|---|
| `lib/cli/` | `bin/lcr`'s command table, argument parsing, run resolution, `lcr clean` |
| `lib/core/` | shared foundation: errors, logging, paths, subprocesses (`proc.js`), Docker Compose, locks, disk checks, stage-file I/O, JSON and other value semantics (below) |
| `lib/setup/` | `doctor`, `setup` (`--update`), image tags and the compose service runners |
| `lib/prepare/`, `lib/build/` | the prepare stage; build, tuple recording and mapping, crate fetching (`fetch.js`), target directories (`target-dirs.js`), `perf` and its release CLIs (`release-cli.js`) |
| `lib/corpus/` | case sources, the base/head differential, probes, mutations |
| `lib/oracle-driver/` | case selection and the oracle pipeline, `selftest`, `baseline` |
| `lib/report/` | check evaluation, findings, verdict, report rendering, `summary` |
| `lib/inspect/` | `status`, `worklist`, `brief`, `show`, `table` |
| `lib/adapter/`, `lib/targets/`, `lib/fixtures/`, `lib/spec/` | adapter client and where its processes run (`sandbox.js`), browser targets, WPT and real-world fixtures, spec cards and coverage |
| `docker/` | the builder and browser Dockerfiles, and `cli-runner.mjs`, which times the release CLIs inside a sandbox container |
| `lib/types.js` | every shared data shape (stage files, config, adapter protocol) as `@typedef` |
| `oracle/*.mjs`, `oracle/lib/` | the analysis-image scripts (`prepare-jobs`, `compare`, `spec-cards`) and their modules: DOM synthesis, value normalization, per-engine verdicts, transitions; shapes in `oracle/lib/types.mjs` |
| `oracle/engine-runner.cjs`, `oracle/runner/` | the engine runner and its in-page functions (CommonJS, ES2020: it also runs on the legacy images' Node 14 and 16) |
| `test/` | shared test helpers (`test/helpers/`) and fixtures, including the frozen golden outputs |

Stage files keep the exact format the harness has always written: `.json` files in Python's
`json.dumps(indent=2, sort_keys=True)` layout, `.jsonl` rows in its compact form, and case ids
hashed from that same serialization (`lib/core/pyjson.js`, `lib/core/ids.js`). These formats
originate from the harness's original Python implementation (tag `py-final`) and are frozen, so
existing runs, baselines and analyses stay valid and reports are byte-identical across versions.
The `lib/core/py*.js` helpers keep the other behaviors this output depends on (number formatting,
rounding, string splitting, sorting by code point, Unicode-aware regex classes); use them instead
of the JavaScript built-ins wherever a value ends up in a stage file or in printed output.

## Adding things

- A check: add it to `config/checks.json`, evaluate it in the matching `lib/report/checks/`
  module, cover it with a unit test (`lib/report/checks/test/`) or a self-test case.
- An engine profile: pin its Playwright image in `compose.yaml` (under `x-frozen-pins` for a
  legacy profile, so Dependabot leaves it alone) and add a `browsers-<name>` service like the
  others; add the profile to `config/engines.json` (role, expected engine versions, `lacks`); then
  run `lcr setup --profiles <name>` and `lcr selftest`. The latest profile moves with
  `lcr setup --update`, which rebuilds the image and keeps the new pin only if the selftest
  passes; a Dependabot PR moves the same pin, so run `lcr setup --profiles latest` and
  `lcr selftest --profiles latest` on it before merging.
- A mutation: `lib/corpus/mutations.js`; it must be deterministic and produce valid CSS or `null`.
- Probes and checklists: see [CONTRIBUTING.md](../CONTRIBUTING.md). A checklist item that restates
  another item's root cause carries a line `  same-root-as: <ID>` after its `verify:` line, so a
  FAIL of both is counted once; an item about specific files carries `  covers: <glob>, …`.
  Curated probes cite spec anchors, WPT files, issues and merged PRs, never an open PR, and never
  set `repro:` (that key marks a PR probe reproducing the linked issue).
