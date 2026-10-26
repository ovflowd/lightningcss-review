# Contributing

Thanks for helping. The most valuable contributions are the ones that make reviews more
accurate: probes that pin down a CSS behavior, checklist items that would have caught a past
regression, and fixes to the oracle when it calls something different that is not (or the other
way around).

## Setup

See the README. Run the tests before sending a change:

```sh
python3 -I -m unittest discover -s tests          # harness
npm ci && node --test oracle/test/oracle.test.mjs  # oracle normalization and DOM synthesis
bin/lcr selftest                                   # oracle in real engines (needs Docker images)
```

## Probes

A probe is one CSS file with a header (`references/probe-format.md`). Put it in
`corpus/probes/<area>/<slug>.css` and run `bin/lcr validate-probes`.

- Cite the source: a spec URL with anchor, an issue, or a merged PR. Never cite an open PR: a
  curated probe must not pre-judge one.
- Set `known:` honestly. `open-issue#N` or `open-bug` when `master` fails it today (check with
  `bin/lcr baseline`), `fixed-by#N` when it guards a past regression, `none` otherwise.
- Prefer `expect: equivalent` (judged by browsers) plus an output assertion only when the exact
  output is spec-determined.

## Checklists

`references/checklists/<area>.md`. Each item is one line `- [PREFIX-NN] (SEVERITY) statement`
followed by an indented `verify:` line naming the evidence (a check id, mutation, probe, spec
anchor or file to read). Items must be decidable as PASS, FAIL or N/A. Number without gaps.
Two optional lines may follow `verify:`: `same-root-as: <ID>` when the item restates another
item's root cause (a FAIL of both is counted once), and `covers: <glob>, …` when the item is only
about those files (the worklist pre-fills N/A when the diff touches none of them).

Everything under `references/` and `SKILL.md` is loaded into the reviewing agent's context, so it
must stay small and timeless: explain the mechanism (what the code does, why it breaks CSS
semantics, how to spot it in a diff), not the history. No issue or PR numbers, commit hashes,
release versions or line numbers, and only judgment the harness cannot make itself.
`python3 -I scripts/lint_context.py` enforces this and the per-file size budgets. History and
research notes go in `docs/findings/`.

## Harness and oracle

- The harness is Python standard library only; keep it that way so it runs anywhere.
- Determinism is a feature: sort everything, no timestamps in compared output, no network in
  the oracle containers.
- A change to verdict logic (`config/checks.json`, `lib/lcr/report.py`, `oracle/compare.mjs`)
  needs a known-answer case in `oracle/test/selftest.jsonl` or a unit test.

## Pull requests

One change per PR, with a short description of what it fixes and how you checked it. If you used
an AI assistant, say so; you remain responsible for the change.
