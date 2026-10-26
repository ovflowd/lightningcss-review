# Probe format (lcr-probe v1)

A probe is a tiny, deterministic test case the harness runs through the base and head builds and,
when it expects equivalence, through the browser oracle. One probe per file named `<slug>.css`:
curated probes live in `corpus/probes/<area>/`, PR-specific probes in `<run>/probes/`.
Write probes only for behavior you can justify from the spec, the maintainer, or a browser result.
Validate with `lcr validate-probes <dir|run>`; a file name that differs from the id slug, or an
unknown header key, is a warning.

```
/*! lcr-probe
id: color/oklch-none-hue-gradient
area: color
title: `none` hue must survive minification inside gradients
mode: minify
targets: none
expect: equivalent
known: none
ref: https://drafts.csswg.org/css-color-4/#missing
note: replacing `none` with 0 changes interpolation results
*/
.t { background: linear-gradient(in oklch, oklch(0.7 0.1 none), oklch(0.5 0.2 200)); }
```

Header keys (one per line, `key: value`, no nesting):
- `id` (required): `<area>/<kebab-slug>`, globally unique.
- `area` (required): one id from `references/areas.md`.
- `title` (required): one line.
- `mode` (required): `print` (parse+print, no minify), `minify` (minify, compact output),
  `lower` (minify with targets, pretty output), `lower-minify` (minify with targets, compact output).
- `targets`: `none`, or comma-separated `<browser> <version>` pairs, e.g. `chrome 80, safari 13.1, firefox 78`.
  Browsers: chrome, edge, firefox, safari, ios_saf, opera, samsung, android, ie. Required for
  `lower-minify`; `lower` with `targets: none` is `minify()` plus the pretty printer.
- `flags` (optional, comma-separated): `error-recovery`, `css-modules`, `unused-symbols:<a|b>`, and
  parser flags by kebab-case name: `custom-media`, `deep-selector-combinator`,
  `scroll-navigation-controls`, or a flag the PR adds (`custom-functions` → `ParserFlags::CUSTOM_FUNCTIONS`).
  A revision without that flag answers with a request error (shown as a delta).
- `expect` (required, comma-separated list): `equivalent` (input and output must have identical
  computed styles in every engine that supports the input), `idempotent` (re-running on the output
  changes nothing), `no-panic`, `parse-error` (LightningCSS must reject it),
  `output-contains:"<text>"`, `output-not-contains:"<text>"`, `output-equals:"<text>"` (only when the
  exact output is spec-determined).
- `known` (required): `none`, `open-issue#<n>` / `open-bug` (master fails it; `open-bug` when no
  issue is filed or the issue is about something else), or `fixed-by#<pr or sha>` when it guards a
  past regression or a closed or merely related issue.
- `repro` (optional): `#<n>`, the linked issue this probe reproduces; check A2 keys on it. Set it on
  PR probes only, never on curated ones.
- `ref` (required): one or more space-separated full http(s) URLs (spec anchor, issue, merged PR, WPT file).
  Never an open PR (a curated probe must not pre-judge one) and never a placeholder.
- `timeout` (optional): seconds per request for this probe (default 10) when the input is
  deliberately expensive; a timeout is reported as a probe result, not a hang.
- `dom` (optional, single line): an HTML fragment to use instead of the auto-generated DOM
  (the harness otherwise synthesizes elements that match the selectors).
- `note` (optional): one line on why it matters.

Everything after the closing `*/` is the CSS input. Keep selectors simple and matchable (classes, ids,
type selectors, simple combinators) unless the probe is about selectors.

## Pitfalls

- The synthesized element is a `div`. A value equal to its UA default or the initial value
  (`display: block`, `position: static`) touches nothing, so the oracle has no coverage: use a
  non-default value or a `dom:` line.
- Conditional rules (`@media`, `@supports`, `@container`) need an unconditional baseline for the
  same property, and a pair of probes with the condition true and false.
- Each probe spawns about 12 mutations (`wrap-*`, `nest`, `retarget-*`, `engine-legacy-*`); keep
  inputs small.
- Targets: nesting is lowered below Chrome 120, Firefox 117, Safari 17.2; `@scope` ships from
  Chrome 118, `:has()` from Chrome 105. For equivalence evidence on lowering prefer chrome targets
  (`:is()`/`:-webkit-any()` copies): Safari-only targets can emit selector lists Chromium rejects.
- To assert that input parses, use `output-contains:` on a fragment of it (a rejected sheet has
  no output); `no-panic` passes on a parse error.


## How assertions are evaluated

| expect | decided by | passes when |
|---|---|---|
| `equivalent` | oracle | head output computes like the input in every reference engine that accepts the input and is inside the targets (all engines without targets), and in legacy engines inside the targets |
| `idempotent` | corpus | minifying the output again with the same options changes nothing (evaluated for base and head) |
| `no-panic` | corpus | no panic, abort or timeout |
| `parse-error` | corpus | LightningCSS rejects the input at parse time (note: invalid *property values* are kept as unparsed, not rejected) |
| `output-contains:"…"` / `output-not-contains:"…"` / `output-equals:"…"` | corpus | exact text checks on the head output |

A PR that fixes the issue named in `repro: #<n>` must make that probe pass (check A2). An
assertion that holds on base and fails on head is a finding of its own.

Mode mapping to LightningCSS calls: `print` = parse + print (no `minify()`); `minify` = `minify()` +
compact printer, no targets; `lower` = `minify()` with targets + pretty printer (like `prefix_test`);
`lower-minify` = `minify()` with targets + compact printer (like `minify_test_with_options_and_browsers`).
The repo's `test()` helper is `minify()` + pretty printer without targets; `minify` applies the same
transforms with compact output.
