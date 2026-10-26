# Changelog

## 0.1.0 (unreleased)

First public version: harness (`prepare`, `build`, `corpus`, `probe`, `oracle`, `worklist`,
`report`, `summary`, `perf`, `baseline`, `spec-coverage`, `selftest`), browser oracle with three
engine profiles, 625 curated probes, 38 area checklists, spec digests and reviewer references.

The harness is Node.js 24 with no runtime dependencies, type-checked from its JSDoc; stage files,
case ids and reports keep the format of the earlier Python implementation, so existing runs stay
valid. Images are built and run through Docker Compose (`compose.yaml`, which pins each engine
profile's Playwright release); `lcr setup --update` moves the latest profile to the newest
release only if the selftest passes, and `lcr doctor` checks the Compose and Buildx plugins.
