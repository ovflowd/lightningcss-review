# transition-animation checklist (ANIM)
`transition.rs`, `animation.rs`, `easing.rs`, `rules/keyframes.rs`, `@starting-style`, `@view-transition`. Spec: `references/spec/anim-transforms.md`.
Timing is invisible at rest (L5): sample with `animation: k 1s linear -0.5s paused` or `@starting-style` + `transition: … 1000s step-end`.

- [ANIM-01] (BLOCKER) Every `transition-property` rewrite (prefix, logical, shorthand expansion, dedupe, second pass) keeps each name at its index with its timing and logical names on the right axis; only an earlier duplicate may go.
  verify: probes transition-animation/transition-*, logical/transition-inline-size-*; distinct durations
- [ANIM-02] (BLOCKER) Unowned longhands (`transition-behavior`, `animation-composition`/`-trigger`/`-range`/`-timeline`) and `var()` longhands stay after the shorthand.
  verify: probes transition-animation/{transition-behavior-*,sat-animation-range-after-shorthand}; mutations reverse-decls, var-after
- [ANIM-03] (BLOCKER) Invalid transition or easing values stay invalid, never beating a valid earlier one: `none` among items, CSS-wide names, empty `transition:`, bezier x outside [0,1], `steps(0)`; a CSS-wide `transition` never merges with longhands.
  verify: probes transition-animation/{*inherit*,css-wide-*,sat-*-invalid}
- [ANIM-04] (BLOCKER) `animation` prints every non-initial component and each default that disambiguates the name (case-insensitive, incl. `auto`); `none <values>` keeps them; strings stay quoted; `0s` before a delay; items never reorder, merge or dedupe.
  verify: probes transition-animation/{*without-name*,*no-name*,sat-animation-*}; an1#animation
- [ANIM-05] (BLOCKER) Reset-only sub-properties written as longhands are never folded into `animation` (any targets) and stay after it; expansion writes their resets and never an omitted duration as `0s` (`auto` needs a target check).
  verify: probes transition-animation/{*timeline*,*expansion*}; full-support compat keys
- [ANIM-06] (MAJOR) `animation-range` and range selectors round-trip: omitted end = `<name> 100%`, `scroll` kept.
  verify: probes transition-animation/{animation-range-*,*keyframes*range*}
- [ANIM-07] (BLOCKER) Names print escaped (`transition-property` as identifiers), reserved `<keyframes-name>` strings stay quoted, `""` stays invalid.
  verify: probes printer-serialization/transition-property-ident-escaped, transition-animation/*string*; input `\7d`
- [ANIM-08] (MAJOR) CSS modules rename names everywhere consistently, never hash keywords or UA names (`LINEAR`, `none`, `match-element`, `root`); `global()` unwraps only with modules on.
  verify: probes css-modules/*view-transition*, transition-animation/global-fn-without-css-modules
- [ANIM-09] (BLOCKER) The last applicable same-name `@keyframes` wins: replacement never crosses a conditional rule, drops the loser's `@supports` copies; empty rules win.
  verify: probes rule-merging/keyframes-replacement-*, transition-animation/sat-empty-keyframes-last-wins; mutations wrap-media, wrap-layer
- [ANIM-10] (BLOCKER) One invalid declaration or nested at-rule never deletes a keyframe; same-offset blocks merge only with equal easing and composition; `!important` stays ignored; no selector made valid (range, `calc()`); `animation` never expanded inside.
  verify: probes transition-animation/{keyframe*,sat-keyframes-*}; caller `ParserOptions` used
- [ANIM-11] (BLOCKER) Keyframe declarations never emit side rules or `@supports` copies (logical, `color-scheme`, colors) onto the next rule.
  verify: `@keyframes k{to{margin-inline-start:1px}}.b{color:red}`, `chrome 60`; `DeclarationContext::Keyframes`
- [ANIM-12] (MAJOR) Prefixing keeps targets valid: prefixed shorthand + unprefixed longhand keep both values, one prefixed `var()` copy, `@-ms-keyframes` kept, `allow-discrete` lowered after.
  verify: probes transition-animation/{prefixed-*,ms-keyframes-not-dropped}; engine-legacy-2023
- [ANIM-13] (MAJOR) Rules never cross `@starting-style`; `@view-transition` rules never merge; `view-transition-name: none` ↔ a name is never a no-op.
  verify: probes transition-animation/sat-starting-style-cascade-order, at-rules-other/sat-view-transition-rules-not-merged
- [ANIM-14] (NOTE) A timeline inside `animation` is parsed leniently and lowered (pre-existing, pinned by base tests); extending that to other targets is NEEDS_MAINTAINER_DECISION, not a FAIL.
  verify: base `src/lib.rs` tests of the input under other targets
