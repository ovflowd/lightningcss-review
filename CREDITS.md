# Credits

## Code and ideas reused

- **lightningcss#1328 "Setup web platform test harness"** by Devon Govett (MPL-2.0).
  `oracle/wpt/extract.mjs` and `oracle/wpt/read-html.py` are vendored from it unchanged except for
  a header. The `property` request kind in `adapter/lcr_adapter.rs` follows its
  `examples/wpt_adapter.rs`, and `pageProperty` in `oracle/engine-runner.cjs` ports its CSSOM
  oracle (invalid input stays invalid, preceding fallbacks survive, shorthand reset probe,
  contextual computed comparison) to Playwright and three engines.
- **`test-integration.mjs`** in Lightning CSS, Devon's original computed-style equivalence check,
  is the idea behind the browser oracle.
- **Lightning CSS test helpers** (`src/lib.rs`): the tuple recorder reproduces exactly what each
  helper does, so the project's own expectations become cross-revision test cases.

## Data

- **[web-platform-tests](https://github.com/web-platform-tests/wpt)** (BSD-3-Clause): the
  property-value corpus, extracted at the revision pinned in `config/wpt.json`. See
  `oracle/wpt/LICENSE-WPT.md`. This project does not claim WPT or W3C endorsement.
- **[W3C webref](https://github.com/w3c/webref)** (`@webref/css`): property grammars, initial
  values, computed values and longhands for spec cards and the coverage inventory.
- **[MDN browser-compat-data](https://github.com/mdn/browser-compat-data)** and
  **[caniuse](https://caniuse.com/)**: compat facts in the references (Lightning CSS's own
  `scripts/build-prefixes.js` consumes the same sources).
- The real-world corpus (`config/realworld.json`) pins files published on npm by their projects
  under their own licenses; they are downloaded at runtime, not redistributed.

## Libraries

- [Playwright](https://playwright.dev/) and its Docker images: the browser engines.
- [css-tree](https://github.com/csstree/csstree): independent CSS parsing for DOM synthesis.
- [colorjs.io](https://colorjs.io/): color conversion, ΔE OK and CSS gamut mapping.
- [pngjs](https://github.com/pngjs/pngjs): screenshot comparison.

## Research

The references were distilled from a review of 417 Lightning CSS issues, every maintainer and
community PR since 2021, the CSS Working Group editor's drafts, and the issue trackers of
downstream tools and other CSS minifiers, then condensed into the mechanisms a reviewer checks;
the issue-level findings are kept in `docs/findings/`. The research
and much of the code were produced with AI assistance (Claude) and reviewed by the maintainer of
this repository.
