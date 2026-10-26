# background checklist (BG)
`src/properties/background.rs` (BackgroundHandler) and the shared `src/values/position.rs`. Images in layers: IMG.
Spec: `references/spec/images-effects.md` (anchors as there).

- [BG-01] (BLOCKER) A `Position` parse or print change stays valid in every consumer (bg-position, `background` layers, mask-position, gradient/shape `at`, transform-origin): 3/4-value forms keep keywords before offsets, shortened forms appear only where that grammar allows, and other consumers accept nothing new.
  verify: background/background-position-three-value, */*three-value*; blast_radius lists every `Position` caller; values-4#position
- [BG-02] (BLOCKER) Invalid background values stay unparsed and keep the earlier valid declaration: color in a non-final layer, `background-clip: border`, empty `background:`, 3-value position outside bg-position, unitless non-zero lengths.
  verify: background/*invalid*, values-numeric/*unitless*; `reverse-decls`; O7 `invalid-became-valid`; backgrounds-3#background
- [BG-03] (BLOCKER) Buffered background declarations keep cascade order around `var()`/unparsed and prefixed-image declarations: the handler flushes before pushing an unparsed one, and a prefixed `background` is not re-appended after a later `background-image: var()`.
  verify: background/prefixed-gradient-decl-moved-after-var; `var-before`, `var-after`, `reverse-decls` -> O1
- [BG-04] (BLOCKER) Properties `background` resets that the handler does not own keep source order relative to the deferred shorthand (`-webkit-background-size/-origin`, `background-blend-mode`, L4 longhands); a PR adds none to that set.
  verify: new probe input (shorthand, then the unowned longhand) + `reverse-decls` -> O1; blend-mode resets are spec-only (no oracle engine): compositing-1#background-blend-mode
- [BG-05] (BLOCKER) Longhands collapse into `background` only with equal list lengths; expansion keeps every layer (`none` layers, repeat/truncate to the image count, `size: X` = `X auto`); dedupe or merge in one list re-indexes all sibling lists.
  verify: multi-layer probe with distinct per-layer values -> O1/O6; `duplicate-nonadjacent`; backgrounds-3#layering
- [BG-06] (MAJOR) `background-clip: text` lowering puts `-webkit-background-clip: text` after the shorthand for targets that need it, keeps the unprefixed value, and keeps an authored prefixed copy while any target needs it.
  verify: `prefixed-sibling`, `retarget-none`, `engine-legacy-2021`, `engine-legacy-2023` -> O4; prefix data regenerated (B11)
- [BG-07] (MAJOR) Color and image fallbacks appear once, before the authored value, only for targets that need them; an earlier author fallback is dropped only when the later value is compatible with every target.
  verify: `retarget-none`, `retarget-legacy`, `engine-legacy-2023` -> O4; R2 (no duplicated fallbacks)
- [BG-08] (MAJOR) Box keywords keep meaning: one box = origin and clip, two = origin then clip; `border-area` is never emitted alone for an origin other than `border-box`.
  verify: O9 split decided by backgrounds-4#typedef-bg-clip; `BackgroundClip`/`BackgroundOrigin` printing in the shorthand
- [BG-09] (MAJOR) Rewrites introduce no side-relative or logical longhand forms (`background-position-x: right 10px`, `-inline`) for targets without them.
  verify: `retarget-legacy`, `engine-legacy-2021` -> O3/O4; compat data for the form
- [BG-10] (MAJOR) New typed syntax (`border-area`, `repeat-block/-inline`, `x-start`, `plus-lighter` blend) follows backgrounds-4/compositing-2 exactly and stays unparsed or flagged where engines lack it.
  verify: WPT css-backgrounds parsing via O7; backgrounds-4#typedef-bg-clip
- [BG-11] (MINOR) The all-initial `background` prints a valid value (`none`/`0 0`); `0% 0%` vs `0px 0px` computed position is equivalent.
  verify: `background:none` round trip; classify that delta ACCEPTABLE_SIDE_EFFECT citing backgrounds-3#background-position
