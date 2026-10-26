# lightningcss-review

A review harness for [Lightning CSS](https://github.com/parcel-bundler/lightningcss) pull
requests. It answers the questions that take a maintainer longest on a CSS change:

- What does the change do to the output, isolated from everything else on `master`?
- Does the output still mean the same thing as the input, in real browsers?
- What else did it change, outside the area it claims to touch?
- What does the spec say about it?

It ships as a [Claude Code](https://docs.claude.com/en/docs/claude-code) skill (`SKILL.md`), but
the harness (`bin/lcr`) is a plain command-line tool you can run without an agent.

```sh
lcr review 1385         # prepare + build + corpus for parcel-bundler/lightningcss#1385
lcr oracle 1385         # browser oracle: Chromium, Firefox, WebKit (current and legacy builds)
lcr report 1385         # checks -> findings -> verdict -> report.md / report.json
```

## Why

Lightning CSS fully parses CSS and rewrites it: it merges rules, folds longhands into
shorthands, drops declarations it considers overridden, and lowers modern syntax for older
browsers. Each of those is easy to get almost right. As the maintainer put it:

> CSS has a lot of edge cases and many times people think they understand how it works
> intuitively but in reality it's more complex or a small change affects more than they think.
> I usually need to verify against the spec, test against browser behavior, etc. which is quite
> time consuming.

This project automates that verification and leaves the judgment calls, written down with
evidence, to the reviewer.

## What it does

| Stage | What happens |
|---|---|
| `prepare` | Merges the PR head into current `master` with `git merge-tree` (no commit), exports base and head trees, maps changed files to areas, finds changed Rust items and their references (blast radius), risk flags, linked issues, overlapping open PRs and CI status. |
| `build` | In a Docker builder pinned to the repo's `rust-toolchain.toml`: `cargo fmt --check`, `cargo test --all-features` with `RUSTFLAGS=-D warnings` like CI, while every test-helper call (`minify_test`, `prefix_test`, ...) is recorded as a tuple. Also the lanes CI does not run: `parcel_selectors` tests, `--no-default-features`, a wasm32 compile gate, C bindings, and drift of generated files (`build-prefixes.js` output, `ast.d.ts`). |
| `corpus` | Every case through the base and the head build with identical options: all recorded test expectations of both sides, 600+ curated probes, metamorphic mutations of the PR's own tests (reversed declarations, `!important`, interleaved `var()`, prefixed siblings, `@media`/`@layer`/`@supports` wrapping, nesting, retargeting), the 24k-case WPT property corpus, and 25 pinned real-world stylesheets. Any difference is a *delta*. |
| `oracle` | Synthesizes a DOM from the selectors (css-tree, not Lightning CSS), applies input, base output and head output, and compares `getComputedStyle` per element and pseudo-element in current Chromium, Firefox and WebKit. Lowered output is also rendered in older engines inside the targets. Classifies each delta: `fixed`, `regressed`, `both-equivalent`, `still-different`, engine divergence. |
| `report` | Evaluates a fixed check catalog (`config/checks.json`) over the stage outputs and the reviewer's `analysis.json`, then renders a fixed-format report with a rule-based verdict: `UNSAFE`, `NEEDS_CHANGES`, `SAFE_WITH_NITS`, `SAFE` or `INCONCLUSIVE`. |

Same PR, same base and same images give a byte-identical report.

Optional stages: `lcr perf` (release build size and timing on the real-world corpus),
`lcr baseline` (which curated probes fail on `master` today), `lcr spec-coverage` (W3C webref
inventory vs what Lightning CSS parses), `lcr selftest` (known-answer cases through every engine).

## Requirements

- git, [gh](https://cli.github.com/) (authenticated, read-only use), Docker, Python 3.12+
- About 15 GB of disk for the images

```sh
git clone https://github.com/ovflowd/lightningcss-review
cd lightningcss-review
bin/lcr doctor      # checks the above
bin/lcr setup       # builds the builder image and the browser images, records engine versions
bin/lcr wpt         # one-time WPT checkout + corpus extraction
bin/lcr realworld   # one-time download of the pinned real-world stylesheets
bin/lcr selftest    # must print 20/20
```

To use it as a Claude Code skill, run `./install.sh` (it symlinks the checkout into your skills
directory) and ask the agent to review a Lightning CSS PR. The agent follows `SKILL.md`: it runs
the stages, writes probes for the change, fills the analysis slots with evidence, and renders the
report. It never posts to GitHub unless you ask it to.

`LCR_REPO` points the harness at an existing Lightning CSS checkout (otherwise it uses
`~/GitHub/lightningcss` if present, or clones one into the cache). `LCR_CACHE` moves the cache
(default `~/.cache/lightningcss-review`). `LCR_BUILD=host` builds with a local Rust toolchain
instead of the builder image; browsers always run in Docker.

## Layout

| Path | Contents |
|---|---|
| `SKILL.md` | the review procedure for an agent (phases, rules, classification) |
| `bin/lcr`, `lib/lcr/` | the harness (Python standard library only) |
| `adapter/lcr_adapter.rs` | JSONL bridge compiled into each tree as a Cargo example |
| `oracle/` | DOM synthesis, engine runner, comparison, spec cards; `oracle/wpt/` is the WPT extractor from lightningcss#1328 |
| `config/` | areas, transform modes and targets, engine profiles, check catalog, test and property maps, pins |
| `corpus/probes/` | curated probes by area (spec invariants, past regressions, issue repros) |
| `references/` | what the reviewing agent loads: per-area checklists, spec digests, architecture, conventions, browsers, ecosystem, oracle (size-budgeted, mechanisms only) |
| `docs/` | how the harness works, and findings about Lightning CSS from building this (`docs/findings/`) |
| `tests/`, `oracle/test/` | unit tests and the oracle's known-answer cases |

## Status

Early. The harness, oracle and references are complete enough to review real PRs; expect the
check catalog and the probe corpus to keep changing. Findings about Lightning CSS itself that came
out of building this (bugs reproducible on `master` with no issue filed yet) are listed in
[`docs/findings/issues.md`](docs/findings/issues.md#3-unfiled-bugs-found-during-this-research-verified-on-master-cbeaf83).

## Credits

See [CREDITS.md](CREDITS.md). In short: the WPT extraction and the CSSOM oracle checks come from
Devon Govett's [lightningcss#1328](https://github.com/parcel-bundler/lightningcss/pull/1328), the
property corpus from [web-platform-tests](https://github.com/web-platform-tests/wpt), spec data
from [W3C webref](https://github.com/w3c/webref), and the browsers from
[Playwright](https://playwright.dev/).

## License

[MPL-2.0](LICENSE), the same license as Lightning CSS. WPT-derived material is BSD-3-Clause
(`oracle/wpt/LICENSE-WPT.md`).
