# Spec digest: transforms, transitions, animations, easing, scroll-driven, view transitions

Areas `transform` (checklist XFORM) and `transition-animation` (ANIM). Sources: research `spec-anim-transforms` (13 EDs
read in full; Chrome 156.0.8078, Firefox 157, WebKit 27.2) plus the issue/PR/architecture/ecosystem reports.
`file:line` at `cbeaf83`. ✅ master passes, ❌ master fails (verified). **NEW** = no GitHub issue on 2026-10-25. **integ** =
re-verified for this digest (master build; three engines where behavior is claimed). Anchors (checked in the
fetched EDs): `tf1#x` = `https://drafts.csswg.org/css-transforms-1/#x`; `tf2` css-transforms-2, `tr1`/`tr2`
css-transitions-1/-2, `an1`/`an2` css-animations-1/-2, `sda` scroll-animations-1, `ez1`/`ez2` css-easing-1/-2,
`vt1`/`vt2` css-view-transitions-1/-2, `val4` css-values-4. Probe ids without an area are `<area>/sat-<slug>`.

## 0. Specs read (2026-10-25)
tf1 ED 2025-11-30 · tf2 ED 2025-11-30 (delta, unchanged since WD 2021-11-09) · tr1 ED 2026-10-08 · tr2 ED 2026-04-22 ·
an1 ED 2026-09-13 · an2 ED 2026-08-18 · sda ED 2026-09-25 · vt1 ED 2025-02-16 · vt2 ED 2026-08-31 · ez1 ED 2025-12-16 ·
ez2 ED 2026-02-23 · motion-1 ED 2026-04-28 · css-will-change-1 ED 2022-04-29 · animation-triggers-1 ED 2026-10-16 (partial).
Not yet in the grammar: [csswg #6946](https://github.com/w3c/csswg-drafts/issues/6946) (2022: longhands not in Animations 1
are reset-only sub-properties of `animation`; 2023: a future `name / …` syntax sets them). Open: PR #6930 (composition in
the shorthand). Merged: PR #13306 (`scroll` range, 2026-01-07).

## 1. Transforms

### Grammar essentials
- Unitless `0` angles only inside transform functions; unitless non-zero lengths never. `perspective(<length> | none)`
  (`none` since #6488).
- Primitives (`tf2#transform-primitives`): translate*, scale*, rotate* each share one; **skew, skewX, skewY share none**.
- Interpolation (`tf1#interpolation-of-transforms`, `tf2#interpolation-of-transform-functions`): pad with identity
  functions, pair while names match or share a primitive, matrices from the first mismatch (always for matrix/matrix3d/
  perspective); non-invertible → discrete.
- `translate`/`rotate`/`scale` serialize `none` only if `none` was specified (`tf2#individual-transform-serialization`).
  CTM order (`tf2#ctm`): translate, rotate, scale, offset (motion), `transform`.
- `transform-origin` (`tf1#transform-origin-property`): 1, 2, or 2 values + z `<length>`; **the third value is always z**;
  no 3-value offset form, no 4-value form. `perspective-origin: <position>`, no 3-value form (`tf2#perspective-origin-property`).
- Any non-`none` transform/translate/rotate/scale/perspective (and `preserve-3d`) creates a stacking context and a
  containing block (`tf1#transform-rendering`).

### Invariants (INV-TRF)
- **INV-TRF-001** Never collapse a list into `matrix()`/`matrix3d()` or decompose one (`tf1#matrix-interpolation`): pairs keep
  turns (`rotate(0)` → `rotate(360deg)`). ✅ disabled by #694 (`transform.rs:60-119`, #288). Probe `transform/rotate-over-360-not-matrix`.
- **INV-TRF-002** Rename only within one primitive. ❌ **NEW** `skewX(a)` → `skew(a)`, `skew(0,a)` → `skewY(a)`
  (`transform.rs:1204-1222`, asserted at `src/lib.rs:13612-13613`): 50% of `skewX(10deg)` → `skew(20deg,30deg)` goes from
  `matrix(1.04064, 0.278839, …)` to `matrix(1, 0.267949, 0.267949, 1, 0, 0)`, also against unminified endpoints. Probes
  `sat-skewx-not-rewritten-as-skew`, `sat-skew-zero-x-not-rewritten-as-skewy`, `sat-skewx-keyframe-vs-inline-from`.
- **INV-TRF-003** Keep identity functions in lists (`tf1#identity-transform-function`). ✅ Probe `sat-identity-functions-kept-in-list`.
- **INV-TRF-004** `none` ≠ identity (`tf2#valdef-translate-none`; a fixed child moved 7px → 15px). ✅ since #703 (translate/scale)
  and #1147 (`rotate: 0deg`, #1136). Probes `sat-individual-identity-not-none`, `transform/translate-scale-none-kept`.
- **INV-TRF-005** 3D stays 3D: `translate3d(x,y,0)` → `translate(x,y)`, `scale3d(x,x,1)` → `scale(x)`, `rotate3d(0,0,1,a)`/
  `rotateZ(a)` → `rotate(a)` keep matrix and interpolation but drop the 3D-transformed status (`tf2#3d-transformed-element`;
  #3305's specced 2D rule covers only individual properties), flip `is2D` and kill the `translateZ(0)` hack. ❌ print-time collapse
  (`transform.rs:1061-1085`, `:1123-1203`); #239 open (#1080 dup); PR #1157 closed (Devon: spec-equivalent, an opt-out is
  fine); master needs two passes to reach `translate(0)` (integ; PR #1335 open fixes it). ✅ `translate3d(0,0,1px)` →
  `translateZ(1px)`. Probe `sat-translate3d-zero-keeps-3d-function` (also `idempotent`).
- **INV-TRF-006** Never fold `translate`/`rotate`/`scale` into `transform` or let `transform` reset them. ✅ since #1340 (40fb4ea,
  unreleased; `transform.rs:1742-1749`), fixing #426 (still open)/#1053/#1099. Probe `transform/individual-transform-preserved`.
- **INV-TRF-007** Unitless numbers stay invalid (`val4#lengths`). ✅ `rotate: 0`. ❌ `perspective(1000)` → `1000px`,
  `translateZ(9)` → `9px` (#1199, #682; `src/values/length.rs:145-148`). Probe `values-numeric/unitless-translate-invalid`.
- **INV-TRF-008** Keep `perspective(none)` (`tf2#funcdef-perspective`). ✅ by accident: `transform.rs:1013-1016` parses only
  `<length>`, so the list stays Unparsed.
- **INV-TRF-009** Safe rewrites: `translate(x,0)` → `translate(x)`, `translateX` → `translate`, `scale(x,x)` → `scale(x)`,
  `scale(1,y)` → `scaleY(y)`, `%` → number, `rotate3d(1,0,0,a)` → `rotateX(a)`; never across skew variants or 3D-ness.
- **INV-TRF-010** `rotate` axis normalization is interpolation-visible: `-1 0 0 30deg` prints `x -30deg` (#1147,
  `transform.rs:1576-1630`); to `x 720deg` at 50%: authored Chrome 345deg, Firefox −15deg, WebKit 375deg (bug); output
  345deg in all (O9, no probe).
- **INV-TRF-011** Precision: f32, ~6 significant digits. `matrix(1,0,0,1,1234.5678,0)` → `1234.57`; `matrix(1,1,1,1.0000001,0,0)`
  → singular (not rendered; discrete); `rotate(1rad)` → `57.2958deg`; `scale(calc(100% / 3))` → `.333333`.
- **INV-TRF-012** `transform-origin`'s third value is z. ❌ typed as `Position` (`mod.rs:1474` TODO): `left top 5px` → `0 5px`,
  `top left 30px` → `30px 0`, `center left 6px` → `6px`, `bottom right 7px` → invalid `right 7px bottom`; invalid `left 10px
  top 20px` → valid `10px 20px` (integ). Probes `transform/transform-origin-keywords-z`, `sat-transform-origin-four-value-invalid`.
- **INV-TRF-013** `perspective-origin` has no 3-value form. ❌ `center left 1px` → `1px`, `center top 2px` → `50% 2px` (8 WPT
  invalid cases). Probe `sat-perspective-origin-three-value-invalid`.
- **INV-TRF-014** `perspective: 0` stays 0, negatives invalid (`tf2#valdef-perspective-length-0`) ✅ (#1329).
- **INV-TRF-015** Prefixed/unprefixed transforms with different values keep their order ✅ (`transform.rs:1755-1768`).
- **INV-TRF-016** A 3D-only fallback for 2D-only UAs is deduped (`tf2#two-dimensional-subset`): ok.

### Conformance and handler facts
- `transform`: typed (`transform.rs:29-48`); rewrites run in `Transform::to_css` **only when `dest.minify`**
  (`:1024-1230`), so `print`/`lower` probes and `test()`/`prefix_test()` never show them.
- `TransformHandler` (`:1725-1828`): buffers `transform` + the individual properties; flushes on Unparsed (`:1773-1789`;
  a `var()` transform is prefixed via `get_prefixed`) and on prefix/value mismatch. ❌ integ: `transform:var(--t)`
  (safari 8) gains a `-webkit-` copy on every pass (also `animation`).
- PrefixHandler (`prefix_handler.rs:59-63`): transform-origin/-style, backface-visibility, perspective(-origin). Pushed
  immediately; a later equal value or same prefix overwrites the earlier slot (`:24-38`). ❌ integ
  `perspective:10px;perspective:var(--p);perspective:20px` → `perspective:20px;perspective:var(--p)` (probe
  `rule-merging/prefix-handler-in-place-update-reorders-unparsed`).
- `translate`/`rotate`/`scale` typed (`:1437`, `:1523`, `:1634`), never lowered; `offset*`, `will-change` pass through.

### Engine divergences (oracle)
- Matrix-fallback results differ per engine (WebKit gives `matrix(0.947456, …)` for the INV-TRF-002 example): compare
  within one engine. WebKit matrix-interpolates from inline values even for skewX → skewX, so
  `sat-skewx-keyframe-vs-inline-from` fails only in Chrome/Firefox (O9); INV-TRF-010 and `perspective(1000)` split too.
- Computed `transform` is a resolved matrix (percentages against the box, whose height differs per engine); individual
  properties stay as specified (`translate: 100px 0%` keeps `0%`). Chromium 97 (`legacy-2021`) lacks them.

### Lowering
- Prefixes (`prefixes.rs:338-409`): transform/transform-origin `-webkit-` Chrome 4–35, Safari 3.1–8, iOS 3.2–8.1, Opera
  15–22, Android 2.1–4.4.3; `-moz-` Firefox 3.5–15; `-ms-` IE ≤ 9; `-o-` Opera 10.5–12. perspective(-origin)/transform-style
  `-webkit-` Chrome 12–35, Safari 4–8; `-moz-` Firefox 10–15. Prefixed copies print first; transforms inside `@keyframes`
  are prefixed in every keyframes copy; with targets, an authored prefixed copy equal to the unprefixed one is dropped
  if no target needs it (#396).
- Scale percentages → numbers: exact, more compatible. Not lowerable, pass through: individual transforms (Chrome 104,
  Firefox 72, Safari 14.1; folding is never exact, #1340), `perspective(none)`, motion path.

## 2. Transitions and @starting-style

### Grammar essentials
- `transition-property: none | [all | <custom-ident>]#` (ident excludes `none` and CSS-wide keywords; unknown names are
  kept for index matching). `transition-behavior: [normal | allow-discrete]#` (L2, part of the shorthand).
- `<single-transition> = [none | <single-transition-property>] || <time> || <easing-function> || <time> ||
  <transition-behavior-value>`; first time = duration, second = delay; with several items, an item with `none` makes the
  declaration invalid (`tr1#transition-shorthand-property`). Engines read `transition: linear 1s` as easing `linear`,
  property `all` (integ).
- Coordinating lists (`val4#coordinating-list-property`): other lists repeat/truncate at used-value time (computed values
  unchanged). A property listed several times (directly, via a shorthand or `all`) uses the timing at the index of the
  **last** item naming it (`tr1#transition-property-property`).
- `@starting-style` (`tr2#defining-before-change-style`): grouping rule, no precedence; may nest in style rules.

### Invariants (INV-TRN)
- **INV-TRN-001** Invalid lists stay invalid and never override fallbacks (`none` among several items, CSS-wide keywords or
  `default` in `transition-property`, `transition: initial 1s`, empty `transition:`). ❌ (14 WPT cases; integ
  `transition-property:opacity;transition-property:none,opacity` keeps only the invalid one; `transition:opacity 1s;
  transition:` → `transition:all`). Probes `sat-transition-property-none-in-list-invalid`, `sat-transition-shorthand-none-in-list-invalid`.
- **INV-TRN-002** Every rewrite of `transition-property` keeps each name at its index with its own timing. **Correction
  (integ):** research said ✅; only one pass of the shorthand path's prefix expansion is right (`transition.rs:289-305`).
  ❌ in all three engines (opacity's used duration 2000ms → 1000ms):
  1. **NEW regression from #850** (33265a2, v1.28.2): `merge_properties` (`:383-398`) merges duplicate, case-variant and
     prefixed names at the **first** index: `opacity 1s,opacity 2s` → `opacity 1s`; `opacity 1s,color 2s,opacity 3s` →
     `opacity 1s,color 2s`; prefixed pairs (probes `transition-animation/transition-*`); a second pass over
     a correct prefixed output: `transform 1s,opacity 2s` (safari 8) → `…,opacity 2s` → `…,opacity 1s`.
  2. **NEW** (≤ 1.16.1) `expand_properties` (`:400-470`) inserts names without re-indexing the other lists:
     `inset 1s,opacity 2s` (chrome 80) → `top 1s,bottom 2s,left 1s,right 2s,opacity 1s`;
     `mask-border 1s,opacity 2s` (chrome 100) → `-webkit-mask-box-image 1s,mask-border 2s,opacity 1s` (`:450`); longhand
     path `transition-property:transform,opacity;transition-duration:1s,2s` (safari 8) → `-webkit-transform,transform,opacity`.
- **INV-TRN-003** `transition` resets `transition-behavior` (`tr2#transition-shorthand-property`). ❌ moved before the
  buffered shorthand (#1084, PR #1365 open; `declaration.rs:246-253`).
- **INV-TRN-004** `allow-discrete` in the shorthand is invalid in Chrome < 117, Safari < 17.4, Firefox < 129 (no
  transition).
- **INV-TRN-005** `@starting-style` has no precedence: never move an outer rule across the block or merge across it. ✅ Probe
  `sat-starting-style-cascade-order`. ✅ `.a{@starting-style{…}}` → `@starting-style{.a{…}}` in place; adjacent blocks
  not merged, empty ones removed.
- **INV-TRN-006** Within an item only the duration/delay order is fixed; items never move; dropping an **earlier**
  duplicate is exact (`opacity 1s, opacity 2s` → `opacity 2s`), keeping the first is not.

### Conformance and handler facts
- `transition` (`transition.rs:23-110`), `TransitionHandler` (`:158-381`): the parse loop (`:39-84`) accepts empty input;
  `PropertyId::parse` (`:69`, `mod.rs:240-244`) accepts CSS-wide keywords (#1214); the shorthand needs all four longhands
  with a common prefix. `transition-behavior` is unknown (pushed immediately); `… allow-discrete` stays Unparsed.
- `transition-property` names print as raw text (`PropertyId::to_css`, `mod.rs:265`): ❌ **NEW** (EM-04) `fake\7d name` →
  `fake}name`, closing the block (next rule lost). Probe `printer-serialization/transition-property-ident-escaped`.
  With `dashedIdents`, `transition: --x 1s` is not renamed while `--x` is (F19, integ).
- Logical names: RTL of `inline-size`/`min-`/`max-inline-size` → `height` (`transition.rs:493-497`, wrong axis; probe
  `logical/transition-inline-size-rtl-maps-to-height`).

### Lowering
- `transition: opacity 1s allow-discrete` (invalid pre-L2) lowers exactly to `transition: opacity 1s;
  transition-behavior: allow-discrete`, longhand **after** the shorthand (#1084 breaks this); master does not lower it.
- Prefixes (`prefixes.rs:302-337`): `-webkit-transition*` Chrome 4–25, Safari 3.1–6, iOS 3.2–6, Android 2.1–4.2; `-moz-`
  Firefox 4–15; `-o-` Opera 10–12. Prefixed names keep their index only in one shorthand pass (INV-TRN-002);
  one-to-one logical names keep it via `:dir()`/`:lang()` side rules (more specific, #1018).

## 3. Animations and @keyframes

### Grammar essentials
- `<keyframes-name> = <custom-ident> | <string>` (ident excludes `none`, string excludes `""`; case-sensitive,
  `an1#typedef-keyframes-name`). `animation-duration` L2: `[auto | <time [0s,∞]>]#`, initial **`auto`** (`an2#animation-duration`).
- L2/SDA: `animation-timeline: [auto | none | <dashed-ident> | scroll() | view()]#` (#8746); `animation-range: [<start>
  <end>?]#` (an omitted end after a named start = that name at 100%); composition, trigger.
- `animation` (`an1#animation`): `<time> || <easing-function> || <time> || <iteration-count> || <direction> ||
  <fill-mode> || <play-state> || [none | <keyframes-name>]`. Reset-only: timeline, range
  (`sda#named-range-animation-declaration`), composition (#6946), trigger. The L2 ED still lists a timeline; no engine
  parses one in the shorthand. First time = duration. Defaults must be printed "in at least the cases necessary to
  distinguish an animation-name that could be a value of another property" (`3s none backwards` ≠ `3s backwards`).
- `@keyframes` selectors: `from | to | <percentage [0,100]> | <timeline-range-name> <percentage>` (`sda#named-range-keyframes`);
  out-of-range blocks ignored. Last same-name rule wins (`an1#keyframes`); empty rules run and fire events (`an1#events`).
  `!important` inside: ignored. Animation properties inside: ignored except timing-function (L2: composition).
  Blocks are grouped by (selector, easing, composition) (`an2#keyframe-processing`).

### Invariants (INV-ANI)
- **INV-ANI-001** Keyword disambiguation: a name matching (ASCII case-insensitively) a keyword of an unset longhand needs that
  default before it (easing keywords, `infinite`, direction, fill-mode incl. `none`, play-state, L2 `auto`). ❌ **NEW**:
  `Animation::to_css` (`animation.rs:670-705`) has no `auto` check, uses case-sensitive `EasingFunction::is_ident`
  (`easing.rs:186-191`) and `== "infinite"` (`:685`); strings take the same checks and print unquoted (`:75`).
  `0s auto` → `auto`, `1s ease LINEAR` → `1s LINEAR`, `1s "INFINITE"` → `1s INFINITE` (second pass: `animation:none`).
  Probes `sat-animation-name-auto-keeps-duration`, `sat-animation-name-keyword-case-insensitive`,
  `sat-animation-string-name-not-unquoted-to-keyword`; guard `sat-animation-fill-mode-none-before-keyword-name`.
- **INV-ANI-002** Print `0s` when a delay follows (also `transition`). ✅ Probe `sat-animation-zero-duration-before-delay`.
- **INV-ANI-003** `animation: none <values>` keeps the other components. ❌ #337/#1095 (`animation.rs:668`; `animation:.5s
  ease-out both` → `animation:none`); PR #879 open. Probe `transition-animation/animation-shorthand-without-name-2`.
- **INV-ANI-004** Reset-only sub-properties: never fold into `animation`, keep them after it, emit their resets when expanding.
  ❌ timeline folded (#815, #1115, #1283, #1342, #1369; f4408c7, v1.25.0): `animation.rs:957-965` folds when
  `AnimationTimelineShorthand` is compatible: always without targets (`targets.rs:226-228`), from Chrome 115 because
  `build-prefixes.js:337` keeps BCD's partial entry (`compat.rs:3513`); PR #1306 open. ❌ a timeline inside the shorthand
  parses (`animation.rs:644`): integ `animation:x 1s;animation:y 1s scroll()` keeps only the browser-invalid one.
  ❌ **NEW** expansion drops the range reset (probe `sat-animation-expansion-keeps-range-reset`; integ: after a
  same-selector rule merge an earlier `animation-range` even lands last). ✅ `sat-animation-range-after-shorthand`.
  `animation-composition`/`-trigger` move before the shorthand: no engine resets them yet, wrong per #6946.
- **INV-ANI-005** `animation-duration: auto` (L2 initial) is invalid in Firefox < 159 and Safari < 18.4; expansion must not write
  `0s` for an omitted duration. ❌ #1012 (`animation.rs:650`). Probe `transition-animation/animation-duration-auto-expansion`.
- **INV-ANI-006** Names: `""` invalid; reserved names (none, CSS-wide, `default`) stay strings. ❌ `animation-name:"",b` →
  `animation-name:,b` (probe `sat-animation-name-empty-string-invalid`); integ `@keyframes ""` → `@keyframes {` (does not
  re-parse); `revert-rule` missing from the keep-quoted lists (`animation.rs:75`, `keyframes.rs:76,106`; EM-80 **NEW**,
  probe `transition-animation/keyframes-string-name-revert-rule`). ✅ `sat-keyframes-string-name-reserved-stays-quoted`.
- **INV-ANI-007** `@keyframes` resolve to the last applicable rule in document order (layers by layer order). ❌ **NEW**
  (N2/N3): a later same-name rule replaces the earlier **in place** (`rules/mod.rs:643-648`): the winner moves
  before an intervening conditional same-name rule, and the replaced rule's `@supports` fallbacks stay (`:662-664`).
  ✅ layers kept apart. Probes `rule-merging/keyframes-replacement-*`.
- **INV-ANI-008** An empty `@keyframes` wins over earlier same-name rules, fires events. ✅ Probe `sat-empty-keyframes-last-wins`.
- **INV-ANI-009** Selectors: `from`/`to` ↔ `0%`/`100%` exact. `calc()` selectors: WebKit accepts, Chrome/Firefox reject; master
  simplifies `calc(50%)` → `50%` (integ), activating the block there. ❌ `scroll 50%` dropped (`TimelineRangeName` lacks
  `scroll`, `animation.rs:389-403`; probe `sat-keyframes-scroll-range-selector-kept`; class of #786, fixed by #787).
- **INV-ANI-010** Never merge blocks at one offset unless easing and composition match. ✅ Probe `sat-keyframes-duplicate-offset-distinct-easing`.
- **INV-ANI-011** `!important` in keyframes = ignored: keep the flag or drop the declaration ✅ (`sat-keyframes-important-stays-ignored`).
- **INV-ANI-012** Never expand `animation` into longhands in a keyframe (activates the easing). ✅
- **INV-ANI-013** Truncating/repeating lists changes getComputedStyle (`auto` vs `auto, auto`), not behavior.
- **INV-ANI-014** `animation-timeline` takes `<dashed-ident>`; `scroll()`/`view()` defaults may be omitted. ✅ (`animation.rs:182-377`)
- **INV-ANI-015** Within an item only the two times' order and disambiguating defaults are fixed; the name stays last.
  Items are never reordered, merged or deduplicated (`a, a` is two animations; `an2#animation-composite-order`).

### Conformance and handler facts
- Longhands typed (`mod.rs:1457-1469`); `animation-duration: auto`, `-delay-start/-end`, `animation-trigger*` pass
  through; `animation-composition` typed, no handler arm.
- `AnimationHandler` (`animation.rs:726-1077`): rebuilds the shorthand only when all eight lists have equal length
  (`:947-955`), else longhands. ❌ **NEW** (EM-81) `-webkit-animation:k 1s;animation-name:k` → `…;animation-name:` (empty:
  `names` drained at `:969`, leftover prefix printed at `:1038`). Unparsed `animation`: non-keyword idents are tagged as
  names for CSS modules (`:842-877`) by case-sensitive checks: ❌ integ `animation:var(--d) LINEAR k` hashes `LINEAR`.
- `animation-range` (`:379-582`): ❌ #1226 (39964f1, v1.26.0) parses the end with the start parser, default 0% (`:535-540`):
  `entry exit` → `entry exit 0%`; `entry 0% exit 100%` → `entry exit` → `entry exit 0%` next pass.
- `@keyframes` (`rules/keyframes.rs`): prints webkit/moz/o/none only (`:261-264`): **`@-ms-keyframes` vanishes** (**NEW**,
  probe `transition-animation/ms-keyframes-not-dropped`); no [0,100] check; one invalid item or nested at-rule
  deletes the keyframe (#1103: `ParserOptions::default()` at `:410`, `filter_map(Result::ok)` at `parser.rs:884`).
- Keyframe declarations run the shared handlers in `DeclarationContext::Keyframes` (`keyframes.rs:120-130`). ❌ **NEW**
  (integ, ≤ 1.16.1): logical lowering stays on there (`context.rs:73-80`) and nothing drains the side lists:
  `@keyframes k{to{margin-inline-start:10px}}.b{color:red}` (chrome 60) → `@keyframes k{to{}}` +
  `.b:not(:lang(…)){margin-left:10px}` (all three engines).

### Engine divergences (oracle)
- `animation-duration: auto` in the shorthand: Chrome 115+, Safari 18.4+, not Firefox 157 (BCD 159). `animation` resets
  timeline and range in Chrome/WebKit, never composition, and not `animation-trigger` in Chrome 156: the oracle sees
  reorders only for timeline/range. Firefox 157 has no scroll-driven animations (BCD 159); `scroll` range: Chrome 156,
  WebKit 27.2.

### Lowering
- Prefixes (`prefixes.rs:258-301`): `-webkit-animation*`/`@-webkit-keyframes` Chrome 4–42, Safari 4–8, iOS 3.2–8.1, Opera
  15–29, Android 2.1–4.4.3; `-moz-` Firefox 5–15; `-o-` Opera 12. Prefixed copies stay next to the unprefixed one.
- Not lowerable, pass through as longhands after the shorthand: `animation-duration: auto`, timeline, range, trigger, `linear()`.

## 4. Easing
`cubic-bezier()` x values in [0,1] (`ez2#funcdef-cubic-bezier`); `steps()` count ≥ 1, ≥ 2 with `jump-none`, default
`end` (`ez2#funcdef-steps`). `linear()` keeps whether each input progress was supplied
(`ez2#linear-easing-function-serializing`); coincident end points clamp extrapolation (`ez2#linear-easing-function-output`).
- **INV-EAS-001** Validate before typing. ❌ no checks (`easing.rs:88-105`; 12 WPT cases; integ
  `ease;cubic-bezier(2,0,1,1)` keeps only the invalid one; `steps(0)` → `steps(0,end)`). Probes
  `sat-cubic-bezier-x-out-of-range-invalid`, `sat-steps-zero-invalid`, `sat-steps-jump-none-one-invalid`.
- **INV-EAS-002** Exact: ease keywords ↔ their cubic-bezier; `linear` ↔ `cubic-bezier(0,0,1,1)` ↔ `linear(0, 1)`;
  `step-start` ↔ `steps(1,start)` ↔ `steps(1,jump-start)`; `step-end` ↔ `steps(1)` ↔ `steps(1,jump-end)`. Not outside [0,1]:
  `cubic-bezier(0,0,0,0)` vs `linear`. Computed values keep the authored spelling (`ez1#cubic-bezier-algo`).
- **INV-EAS-003** `jump-start`/`jump-end` → `start`/`end` exact and more compatible (jump-* needs Chrome 77, Firefox 65,
  Safari 14); `jump-none`/`jump-both` have no older form. `steps(2,end)` should print `steps(2)` (`ez2#steps-serialization`).
- **INV-EAS-004** `linear()` is untyped (#232). Typing it: only `linear(0,1)` → `linear` collapses; never dedupe
  coincident end points (`1 100% 100%`) or add/strip input percentages.

## 5. Scroll-driven animations
Ranges `cover | contain | entry | exit | entry-crossing | exit-crossing | scroll`; `timeline-scope: none | all |
<dashed-ident>#`. **INV-SDA-001** CSS modules rename timeline dashed idents in every position (`scroll-/view-timeline`,
`animation-timeline`, `timeline-scope`, inside `animation`) ✅ with `dashedIdents`. **INV-SDA-002** accept every range
name; an omitted end after a named start is `<name> 100%` (❌ keyframes `scroll`; #1226; `animation-range: scroll …`
survives as Unparsed). **INV-SDA-003** one inset value means start and end; `auto` ≠ 0 ✅.

## 6. View transitions
- `view-transition-name: none | auto | match-element | <custom-ident>`; any name forms a stacking context and backdrop
  root, flattens 3D (`vt1#named-and-transitioning`). Only the last `@view-transition` counts (`vt2#vt-rule-algo`).
  Pseudo arguments: `*` or a name, then `.class`es with no whitespace between. The UA sheet sets `:root { view-transition-name: root }`.
- **INV-VT-001** CSS modules never hash keywords or UA names: `match-element` fixed by #1274 (unreleased, #1256);
  ❌ **NEW** `root` in `::view-transition-*(root)` is hashed (`selector.rs:1107`; probe
  `css-modules/sat-view-transition-root-name-not-scoped`); ❌ integ `view-transition-class: NONE` is hashed (`none`
  compared case-sensitively). Types (`@view-transition types`, `:active-view-transition-type()`) are hashed consistently
  but also come from JS: a design question.
- **INV-VT-002** `none` ↔ a name is never a no-op. **INV-VT-003** outer whitespace is fine ✅ (8986055, #1087);
  `name .cls` is a hard parse error without errorRecovery. **INV-VT-004** never merge `@view-transition` rules ✅ (probe
  `at-rules-other/sat-view-transition-rules-not-merged`; unknown descriptors dropped at `view_transition.rs:96`, low).
  **INV-VT-005** `view-transition-class: none` only alone ✅. **INV-VT-006** `.foo::view-transition-group(x)` parses ✅;
  `::view-transition-group-children()` kept with a warning.
- Engines: Firefox 157 drops `@view-transition`; Chrome 156 rejects `view-transition-name: auto` (WebKit accepts);
  groups: Chrome 140 only; `view-transition-scope`: Chrome 147 only.

## 7. Motion path and will-change
**INV-MOT-001** `offset-position: normal` ≠ `auto`, `offset-rotate: auto` ≠ `0deg`, `offset` has a fixed order and resets
omitted parts: ✅ passthrough (probe `transform/sat-motion-offset-shorthand-passthrough`). **INV-MOT-002** never fold the
offset transform into `transform`. **INV-WC-001** `will-change` stays verbatim (stacking contexts).

## 8. What the oracle can and cannot see
- **L5**: list rewrites, 3D collapse and keyframe contents are invisible at rest. Sample with `animation: k 1s linear
  -0.5s paused`; freeze a transition start with `@starting-style` + `transition: … 1000s step-end`. `is2D` is not read:
  3D → 2D needs `output-not-contains`. Stacking changes need a `dom:` line with a positioned child (O1/O6).
- Not normalized, so they show as `different`: list lengths, easing spelling (`cubic-bezier(0.25, 0.1, 0.25, 1)` vs
  `ease`, `jump-start` vs `start`), `translate: 100px 0%` vs `100px`, WebKit's `transition-property` case. No L1-L8
  limitation covers them: `ACCEPTABLE_SIDE_EFFECT` citing `val4#coordinating-list-property`/`ez1#cubic-bezier-algo`,
  but only after checking that each name keeps its own timing; an index shift is a REGRESSION (INV-TRN-002).
- Mutations never touch `@keyframes`/`@starting-style` contents; `var-before`/`-after` reuse the same value, so in-place
  overwrites never show: write probes.
- WPT (O7) has no interpolation helpers and drops `animation-range-shorthand.html`; 39 in-scope invalid-fallback cases
  (12 easing, 13 transition-property, 1 transition, 8 perspective-origin, 3 transform-origin, 1 transform, 1 animation-name)
  are `still-different` on master.
- Default `lower*` targets (legacy-2020) need no transform/transition/animation prefix: use `safari 8`-class targets and
  output assertions (no engine profile is that old). Legacy engines lack `@starting-style`, Chromium-97 individual
  transforms, scroll-driven animations and view transitions: O4 differences there match on base and head.

## 9. Spec changes since 2023 that LightningCSS lags
Missing or passthrough: `transition-behavior` (#1084), `animation-duration: auto` (#1012), reset-only longhands (#6946),
`animation-trigger*`, `animation-delay-start/-end`, `scroll` range (dropped in keyframes), `timeline-scope: all`,
`view-transition-scope`, `::view-transition-group-children()`, `linear()` (#232), `perspective(none)`, pointer-animations-1.

## 10. Corrections to the research
- spec-anim-transforms INV-TRN-002 "✅" and "master cycles the lists … used values stay right": **wrong** (INV-TRN-002).
- arch-props-values: "`Animation::to_css` … careful and correct" misses `auto`, case variants, strings (INV-ANI-001);
  CSS-wide keywords are not Unparsed for `transition`/`transition-property` (#1214); "`animation-range` resets are
  handled" only while the shorthand survives (INV-ANI-004).
