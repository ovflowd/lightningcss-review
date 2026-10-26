# Area ids

| id | covers |
|---|---|
| parser-syntax | tokenizer/cssparser, error recovery, comments, escapes, unicode, @charset, invalid input handling |
| values-numeric | numbers, lengths, percentages, angles, times, resolutions, ratios, units, scientific notation, precision |
| calc-math | calc(), min/max/clamp, round/mod/rem, trig, exp/pow/sqrt/hypot/log, sign/abs, simplification |
| color | all color syntaxes, conversions, gamut mapping, color-mix(), relative colors, light-dark(), system colors, currentcolor |
| gradient-image | gradients, image-set(), url(), cross-fade(), image() |
| background | background shorthand/longhands, background-clip:text |
| border-outline | border*, border-radius, border-image, outline |
| box-model-size | margin, padding, width/height/min/max, aspect-ratio, box-sizing, inset, sizing keywords |
| logical | logical properties and their physical lowering (incl. :dir()/:lang() fallbacks) |
| display-layout | display, position, float, visibility, overflow, contain, content-visibility, z-index |
| flex-grid-align | flexbox incl. legacy -webkit-box/-ms-flex syntaxes, grid, box alignment, gap |
| font | font shorthand/longhands, @font-face, @font-feature-values, @font-palette-values, system-ui |
| text | text-*, white-space, word/line-break, text-decoration, text-emphasis, text-shadow, hyphens, text-size-adjust |
| transform | transform, individual transforms (translate/rotate/scale), perspective, transform-origin |
| transition-animation | transition, animation, @keyframes, easing functions, scroll-driven animations, view transitions, @starting-style |
| effects-masking | filter, backdrop-filter, mask*, clip-path, box-shadow, opacity, blend modes |
| ui-misc | appearance, user-select, cursor, caret, accent-color, color-scheme, resize, lists/counters, svg props, everything else |
| custom-properties | custom properties, var(), env(), @property, unparsed/token-list values |
| selectors | selector parsing/serialization, pseudo-classes/elements, :is/:where/:not/:has, specificity, prefixed selectors, selector downleveling |
| nesting | CSS nesting parsing and lowering, & semantics, nested declarations |
| media-queries | media queries, range syntax lowering, custom media |
| supports-container | @supports, @container |
| cascade-layers-scope | @layer, @scope, @import layer(), ordering |
| at-rules-other | @page, @counter-style, @namespace, @viewport, @-moz-document, @position-try, @view-transition, unknown at-rules |
| rule-merging | stylesheet-level minification: rule merging, dedupe, declaration merging, shorthand/longhand merging, !important |
| prefixing-compat | vendor prefixes, compat data (compat.rs/prefixes.rs/build-prefixes.js), targets, browserslist, include/exclude Features |
| printer-serialization | printer, whitespace, quoting, escaping, number formatting |
| css-modules | CSS modules (local names, composes, dashed idents, pure mode) |
| bundler | @import bundling and resolvers |
| sourcemap | source maps |
| visitor-api | Rust/JS visitors, custom at-rules, composeVisitors |
| bindings-api | node/napi, wasm, C bindings, TS types (index.d.ts/ast.d.ts), CLI, Rust public API, serde |
| perf | performance |
| build-release | build, CI, release, dependencies |

Extra ids used by the harness: `properties-registry` (src/properties/mod.rs), `tests` (src/lib.rs tests), `docs` (website, README), `other`.
