# Spec digest: transforms, transitions, animations, easing, scroll-driven, view transitions

Areas `transform` (XFORM), `transition-animation` (ANIM). `tf1#x` = `https://drafts.csswg.org/css-transforms-1/#x`; likewise
`tf2`, `tr1`/`tr2` css-transitions, `an1`/`an2` css-animations, `sda` scroll-animations-1, `ez2` css-easing-2, `vt1`/`vt2`
css-view-transitions, `val4` css-values-4.

## Transforms
- Interpolation (`tf2#interpolation-of-transform-functions`): pad the shorter list with identity functions, pair while
  names match or share a primitive, matrices from the first mismatch (always for matrix/perspective); non-invertible =
  discrete. List length, names and order are observable; never collapse to or decompose a matrix (`rotate(0)` →
  `rotate(360deg)` turns, a matrix does not; `tf1#matrix-interpolation`).
- Primitives (`tf2#transform-primitives`): translate*, scale*, rotate* share one each; `skew`, `skewX`, `skewY` share
  **none** (`Transform::to_css` renames them today). Exact count-preserving rewrites: `translate(x,0)` → `translate(x)`,
  `translateX` → `translate`, `scale(x,x)` → `scale(x)`, `scale(1,y)` → `scaleY(y)`, scale `%` → number,
  `rotate3d(1,0,0,a)` → `rotateX(a)`. Identity functions in a list stay (`tf1#identity-transform-function`).
- 3D → 2D (`translate3d(x,y,0)`, `scale3d(x,x,1)`, `rotateZ`) keeps the matrix but drops the 3D-transformed status
  (`tf2#3d-transformed-element`), `is2D` and the `translateZ(0)` layer hint: a design decision.
- `none` ≠ identity: any non-`none` transform, individual transform or `perspective` creates a stacking context and a
  containing block for fixed descendants (`tf1#transform-rendering`); individual properties print `none` only if specified.
- CTM order (`tf2#ctm`): translate, rotate, scale, offset, `transform`; the individual properties cascade separately.
- Unitless `0` for lengths and, inside functions, angles; unitless non-zero lengths never (`val4#lengths`; the quirky
  path in `src/values/length.rs` must not leak in). `perspective(<length [0,∞]> | none)` (`tf2#funcdef-perspective`).
- `transform-origin` (`tf1#transform-origin-property`): 1-2 position values plus an optional z `<length>`; the third value
  is always z, no 4-value form. It is typed as `Position` today, which misreads z. `perspective-origin` is a `<position>`
  without a 3-value form.
- `rotate` axis: only z vectors collapse to an angle; negating an axis changes interpolation against an unnormalized
  endpoint, and engines split there (O9).
- f32 printing (~6 digits) can make a near-singular matrix singular (not rendered).
- `Transform::to_css` rewrites only when `dest.minify`. `TransformHandler` buffers and flushes on `Unparsed` or a
  prefix/value mismatch; PrefixHandler overwrites the earlier slot on an equal value or prefix, jumping over an intervening `var()`.

## Transitions and @starting-style
- `transition-property: none | [all | <custom-ident>]#`; ident excludes `none`, CSS-wide keywords and `default`; unknown
  names keep their index. In `transition`, first time = duration; `none` in a list of items is invalid
  (`tr1#transition-shorthand-property`).
- Coordinating lists (`val4#coordinating-list-property`) repeat/truncate at used-value time. A name listed several times
  uses the timing at its **last** index (`tr1#transition-property-property`): dropping an earlier duplicate is exact.
  Inserting or merging names must re-index every sibling list (`merge_properties`, `expand_properties` do not).
- `transition` resets `transition-behavior` (`tr2#transition-shorthand-property`). `allow-discrete` in the shorthand is
  invalid before Chrome 117, Safari 17.4, Firefox 129; exact lowering: shorthand, then `transition-behavior` after it.
- `@starting-style` (`tr2#defining-before-change-style`): grouping rule, no precedence; never reorder across it.

## Animations and @keyframes
- `<keyframes-name> = <custom-ident> | <string>`, case-sensitive; `none`, CSS-wide keywords (incl. `revert-rule`) and
  `default` must stay strings; `""` is invalid (`an1#typedef-keyframes-name`).
- `animation` (`an1#animation`): `<time> || <easing> || <time> || <iteration-count> || <direction> || <fill-mode> ||
  <play-state> || [none | <keyframes-name>]`. Defaults print where needed to tell the name from another longhand's
  keyword, matched ASCII case-insensitively (`3s none backwards` ≠ `3s backwards`; L2 `auto`). `none 1s ease-out`
  keeps its other components. Duration L2 initial `auto` (`an2#animation-duration`): invalid before Firefox 159, Safari 18.4.
- Reset-only sub-properties: timeline, range (`sda#named-range-animation-declaration`), composition, trigger. No engine
  parses them in the shorthand; engines reset timeline and range, not yet composition or trigger.
- Precedence: a CSSWG resolution backed by every engine and WPT (`css/css-animations/parsing/animation-shorthand.html`)
  outranks stale ED grammar text that still lists a timeline in `an2#animation-shorthand`. Base already parses a timeline
  inside `animation` leniently and lowers it (pinned by its tests): extending that is a decision, not a regression. If a
  maintainer asked for something else on the PR, classify NEEDS_MAINTAINER_DECISION.
- `@keyframes`: last same-name rule in document order wins (layers by order); an empty one still wins and fires events
  (`an1#events`). Selectors `from | to | <percentage [0,100]> | <timeline-range-name> <percentage>`
  (`sda#named-range-keyframes`); `calc()` only in WebKit. Blocks group by (offset, easing, composition)
  (`an2#keyframe-processing`); `!important` and animation properties other than easing and composition are ignored inside.
- Items never reorder, merge or dedupe: `a 1s, a 1s` is two animations (`an2#animation-composite-order`).

## Easing, scroll-driven, view transitions, motion
- `cubic-bezier()` x in [0,1]; `steps()` count ≥ 1, ≥ 2 with `jump-none` (`ez2#funcdef-steps`). Exact: ease keywords ↔
  their bezier; `linear` ↔ `cubic-bezier(0,0,1,1)` ↔ `linear(0, 1)`; `step-start` ↔ `steps(1,start)`, `step-end` ↔
  `steps(1)`; `jump-start`/`-end` ↔ `start`/`end`. `linear()` keeps supplied input percentages and coincident points.
- Ranges `cover | contain | entry | exit | entry-crossing | exit-crossing | scroll`; omitted end after a named start =
  `<name> 100%`; one inset = start and end, `auto` ≠ 0.
- Any `view-transition-name` but `none` forms a stacking context (`vt1#named-and-transitioning`); `:root` is named `root`
  by the UA; only the last `@view-transition` counts (`vt2#vt-rule-algo`); no whitespace before `.class` in pseudo args.
- `offset` has a fixed order and resets omitted parts; `offset-position: normal` ≠ `auto`, `offset-rotate: auto` ≠
  `0deg`. `will-change` values create stacking contexts.

## Oracle and lowering limits
- At rest (L5) interpolation, list shape, 3D status and keyframe contents are invisible: sample with `animation: k 1s
  linear -0.5s paused` or `@starting-style` + `transition: … 1000s step-end`; `is2D` needs output assertions; stacking
  needs a `dom:` line with a `position: fixed` child. Mutations never reach keyframe contents.
- List lengths, easing spelling and `translate: 100px 0%` vs `100px` show as `different`: classify only after checking
  each name keeps its own timing. Matrix fallbacks and percentage resolution differ per engine: compare within one. WebKit matrix-interpolates
  `skewX` → `skewX` from inline values, so a skew probe passing only there is O9.
- Default `lower*` targets need no prefix here: use `safari 8` targets with output assertions. Not lowerable:
  individual transforms (Chrome < 104, Firefox < 72, Safari < 14.1), `perspective(none)`, motion path, duration
  `auto`, timeline, range, trigger, `linear()`.
- Firefox lacks scroll-driven animations and `@view-transition`; Chrome rejects `view-transition-name: auto` (O9).
