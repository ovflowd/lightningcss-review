# Browser oracle: how verdicts are computed

The oracle answers one question per case and engine: **does the output behave like the input?** It
never asks LightningCSS to judge its own output: selectors are parsed by css-tree, values are
compared by a fixed normalizer, and only browsers compute styles.

## Pipeline

1. `prepare-jobs.mjs` (analysis image): for each case, synthesize one DOM from the selectors of the
   input and both outputs (`dom.mjs`), rewrite user-action pseudo-classes (`:hover`, `:focus`,
   `:focus-visible`, `:focus-within`, `:active`, `:target`, `:visited`) to attribute selectors
   **identically in every sheet**, and list each sheet's declarations, selectors and
   `@media`/`@supports`/`@container` preludes (exact source text) for validity probing. Rules nested
   without `&` are parsed in place; `@keyframes` selectors are neither synthesized nor probed. A
   custom property the input uses without fallback and never defines gets a `:root` stand-in in
   every sheet (`rgb(1, 2, 3)` for colors, else `5px`; listed in `injectedVars`).
2. `engine-runner.cjs`, reference profile (`latest`: current Chromium, Firefox and WebKit). For each
   job it loads the DOM once and, for the sheets `empty`, `input`, `base`, `head`, reads
   `getComputedStyle` of every element plus each pseudo-element the sheets use (also with `dom:`).
   It records:
   - `touched`: properties whose value under `input` differs from `empty` (what the input does);
   - `diff` for base and head: every (element, property) whose value differs from `input`;
   - validity: whether the engine accepts each declaration (CSSOM `setProperty`), selector
     (`insertRule`) and prelude (`@media` that is not `not all`, etc.);
   - for visual areas, a screenshot hash per sheet.
   Light and dark color schemes run as separate jobs when the CSS uses `light-dark()`, `color-scheme`
   or `prefers-color-scheme`.
3. Legacy profiles (old Playwright images), **only for cases with targets**: the same sheets, but
   only the properties the reference engine of the same family saw the input touch. An engine is used
   only when the case's targets include its family and the engine version is >= the target version
   (else the output may use syntax that engine lacks). Differences base and head share exactly
   are dropped when anything else differs (L3).
4. `compare.mjs`: normalizes and classifies.

## Value comparison (`normalize.mjs`)

Values are tokenized into text, numbers (with units) and colors (functions, hex, named).

| Level | Meaning |
|---|---|
| `equal` | identical strings |
| `noise` | numbers within max(0.002, 1e-4 × magnitude); colors with ΔE-OK ≤ 0.0005 (same engine) or ≤ 0.005 (lowering, 8-bit quantization) and alpha within 0.002 |
| `space-changed` | same color, but legacy (rgb/hsl/hwb/hex/named) vs modern (lab/lch/oklab/oklch/color()) spelling |
| `near` | ΔE-OK ≤ 0.02 (the CSS gamut-mapping JND) |
| `custom-changed` | an unregistered custom property's token stream changed, appeared or disappeared: visible to JS and `style()` queries, not to rendering (consumers are compared on their own). Reported as `near`. `--lightningcss-*` polyfill toggles are ignored |
| `different` | anything else, including: different token shapes or units, a `none` component that became a number (interpolation differs), and a legacy/modern switch inside a gradient property (gradients interpolate in sRGB only when every stop is a legacy color) |

Lowering comparisons gamut-map the reference color to sRGB with the CSS Color 4 algorithm
(colorjs.io `toGamut({method: 'css'})`) before measuring.

## Statuses and transitions

Per engine and side: `equivalent` (all diffs equal/noise), `near` (worst is near/space-changed),
`different`, `no-coverage` (the input touched nothing on the synthesized DOM), `unknown`
(no output, or not decidable), `error` (the engine job failed).

The case summary takes the worst status across engines, separately for base and head, and derives
the transition (first matching row wins). Each verdict lists `engines: {engine: {base, head}}`.

| base → head | transition | meaning |
|---|---|---|
| `error` on either side | `errored` | a job failed: never different, never verified; re-run it |
| input rejected or touching nothing in every engine | `input-rejected` | nothing to judge against: a decision, never O1/O2/T3 |
| base cannot run the request (a flag the PR adds) | `introduced` | head judged against the input alone: different → O2, equivalent → verified |
| ok → ok | `both-equivalent` | the output changed but both are fine |
| ok → near | `near-introduced` | head drifts within tolerance |
| bad → ok | `fixed` | the PR fixes a real difference |
| ok → bad | `regressed` | **the PR breaks something** |
| bad → bad, head's diffs ⊋ base's | `worsened` | head adds differences: counted as `regressed` (O1) |
| bad → bad | `still-different` | pre-existing problem (or both wrong differently) |
| unknown / no coverage | `unverified` | the oracle could not decide: inspect or classify |

**Neutral deltas.** When head shows exactly base's differences from the input in every engine,
the PR changed only the text: the case is `neutral` and needs no classification.

**Engine divergence.** When, on the same side, at least one engine says `equivalent`/`near` and
another says `different`, the engines disagree about what the *input* means (one lags, deviates
from the spec, or implements a newer rule). It needs evidence that they read the input
differently: one rejects part of it, it does nothing in one, or its values differ on the disputed
property. Such cases go to **O9** with the split, not to O1/O2. Exception: base equivalent in
every engine and head different in any is `regressed` (O1). The reviewer decides against the
spec: which engine follows the current spec text (cite `drafts.csswg.org/...#anchor`) and WPT
(cite the test file or wpt.fyi), per engine: REGRESSION only if base matched where head does not.

`rejectedHead > rejectedBase` (a declaration, selector or prelude the engine rejects with no
surviving fallback for the same property) feeds check O3 even when computed styles match.

Property cases (WPT) use a CSSOM check: invalid input stays invalid behind its valid fallback; a
shorthand resets the same longhands (`shorthand-reset-changed`); spelling differences are resolved
with a computed-value fixture (`contextual-match` vs `computed-difference`).

## Limitations (the only valid reasons for `ORACLE_NOISE`)

- L1 **DOM synthesis**: `:has()` beyond one level, `:nth-*` combined with sibling combinators, shadow
  DOM (`:host`, `::slotted`, `::part`), `:state()`, `:popover-open`, `:modal`, `:fullscreen`,
  `:open` and other state pseudo-classes are not synthesized. Cases depending on them are
  `no-coverage`, not wrong.
- L2 **Pseudo-state rewrite**: user-action pseudo-classes become attributes in every sheet, so a PR
  changing their handling (the `pseudoClasses` option) needs output assertions instead.
- L3 **Engine version spread**: legacy engines are specific Playwright builds. Computed-value
  serialization changed between versions (e.g. `font-family` quoting, `normal` vs `auto`), which can
  show as `different` in lowering checks for properties the case does not care about. Always compare
  the base and head transitions: noise affects both equally.
- L4 **Playwright WebKit is not Safari** (WPE/GTK builds): Apple-only features (`-apple-system`,
  some `-webkit-` behaviors) differ.
- L5 **Static snapshot**: animations, transitions, `@starting-style`, scroll-driven timelines and
  view transitions are compared as computed values at rest, not as running animations. Use the
  spec checklist for interpolation semantics.
- L6 **Viewport and media**: fixed 800×600 viewport, light scheme (plus dark when relevant), screen
  media, `prefers-reduced-motion: no-preference`. Media-dependent branches outside that context are
  not exercised.
- L7 **Resources**: `url()` targets do not load (no network); `@import` is not followed; fonts are the
  container defaults.
- L8 **CSS modules**: renamed identifiers make computed-style comparison meaningless; those cases are
  skipped (use output assertions).
- L9 **Initial values**: a value equal to the initial or UA value on the synthesized `div` touches
  nothing (`no-coverage`); output that drops it looks equivalent.
- L10 **Prefixed pseudo-elements** are read through the unprefixed one (`::-moz-placeholder` as
  `::placeholder`); an alias an engine cannot resolve is not judged there.
- L11 **Direction**: synthesized elements get `lang` and, for RTL languages, `dir=rtl`; `:dir(rtl)`
  elements get `lang=ar`. Other direction contexts need a `dom:` line.

Anything else (a real color shift, a dropped declaration, a different cascade winner) is not noise.
Classifying a case the browsers call different as INTENDED, ACCEPTABLE_SIDE_EFFECT or ORACLE_NOISE
requires a spec or WPT URL in the reason, or A3 rejects it.
