# Changelog

## 0.1.0 (unreleased)

Code from a reviewed pull request no longer reaches the host, the network or the shared cache:

- The adapters run in `builder-sandbox` containers (no network, read-only root, only the binary
  mounted, process and memory limits, the host's stack limit), one per adapter process, killed
  by name on a timeout; exit statuses read as before (`adapter exited (-6)`). perf times the
  release CLIs inside one such container, base and head alike.
- Only `cargo fetch` (on a copy of the tree without `.cargo/` or the toolchain file) and the JS
  lane's `yarn install --ignore-scripts --no-default-rc` have the network. Builds, tests, lanes and
  the other JS steps run offline with the Cargo home and yarn cache read-only; the root package's
  lifecycle scripts run offline after the install.
- Head's target directories (`head`, `head-nowarn`, `head-release`, and the JS lane's new
  `js-head`) are reset to a copy-on-write copy of base's at the start of every run. The JS lane
  builds base into `js-base` first; the old shared `targets/js` is no longer used.
- SECURITY.md describes what runs where and the residual risks. Caches used to review untrusted
  pull requests with an earlier version should have `cargo-home/` and `targets/` deleted once.

First public version: harness (`prepare`, `build`, `corpus`, `probe`, `oracle`, `worklist`,
`report`, `summary`, `perf`, `baseline`, `spec-coverage`, `selftest`), browser oracle with three
engine profiles, 625 curated probes, 38 area checklists, spec digests and reviewer references.

The harness is Node.js 24 with no runtime dependencies, type-checked from its JSDoc; stage files,
case ids and reports keep the format of the earlier Python implementation, so existing runs stay
valid. Images are built and run through Docker Compose (`compose.yaml`, which pins each engine
profile's Playwright release); `lcr setup --update` moves the latest profile to the newest
release only if the selftest passes, and `lcr doctor` checks the Compose and Buildx plugins.
