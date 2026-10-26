# build-release checklist (BUILD)

CI workflows, manifests and lockfiles, `rust-toolchain.toml`, `scripts/*`, `cli/postinstall.js`, `patches/*`. Lock sync, fmt, warnings, crate lanes and generated files are B2-B4, B7-B11; CI often has not run on contributor PRs, so the harness lanes are the evidence.

- [BUILD-01] (MAJOR) A dependency bump that can change output (cssparser, browserslist-rs, serde/serde-content, napi, compat-data packages) comes with a base-vs-head corpus diff in which every changed expectation is explained, and adds no second major version of a core crate.
  verify: realworld and tuple deltas classified; `cargo tree -d -p lightningcss`; probe values-numeric/large-integral-value-no-i32-saturation.
- [BUILD-02] (MAJOR) A toolchain bump is checked where tests cannot see it: wasm linking (B9 compiles only), loading the native module in Node worker threads, CSS-module hash stability (`DefaultHasher` changes across releases), new `-D warnings` lints.
  verify: CI test-wasm (B6) or `yarn wasm:build-release`; a worker-thread load test; module hashes unchanged in tuples.
- [BUILD-03] (MAJOR) Platform and packaging changes are complete: a target appears in release.yml, in `scripts/build-npm.js` (triple, optionalDependencies, `os`/`cpu`/`libc`), in node/index.js detection and in `cli/postinstall.js`; `libc` is set only where a libc exists.
  verify: read the four files together; `npm pack --dry-run` on a generated platform package.
- [BUILD-04] (MAJOR) Runtime metadata matches shipped code and the release workflow: `engines` is copied into every platform package, so tightening it affects every install, and release.yml's Node version must satisfy it.
  verify: diff package.json `engines`/`exports`/`optionalDependencies` and every `node-version` in release.yml.
- [BUILD-05] (MAJOR) CI changes keep each check meaningful: no `continue-on-error` on a blocking job, `-D warnings`, `yarn tsc` and test-wasm kept, `permissions: contents: read`, actions and images pinned, no author-controlled image in release jobs (an image change can raise the glibc floor).
  verify: diff .github/workflows/*; `objdump -T` GLIBC versions of a built binary when images change.
- [BUILD-06] (MAJOR) Release and test builds stay alike: `[profile.release]` (`lto`, `codegen-units = 1`, `panic = 'abort'`) unchanged unless justified, and no behavior depends on `debug_assert!` or overflow checks, which only debug tests run.
  verify: diff Cargo.toml; the harness runs debug builds, so a release-only abort is invisible to R1.
- [BUILD-07] (MAJOR) Versions move together: lightningcss, napi, node and selectors manifests and package.json; a crate gaining a public variant bumps its own version; removing or renaming a cargo feature is breaking; `cargo publish --dry-run` passes for each changed manifest.
  verify: diff every manifest version.
- [BUILD-08] (MAJOR) Wasm packaging is complete: `scripts/build-wasm.js` copies every node file the package needs, `wasm/package.json` exports cover new files, ESM and CJS entries load.
  verify: CI test-wasm (B6); diff scripts/build-wasm.js.
- [BUILD-09] (MAJOR) Tests stay hermetic: CLI browserslist tests ignore config in ancestor directories, node tests run from the repo root, no test needs the network.
  verify: read new tests for cwd, env and network use.
- [BUILD-10] (MINOR) No debug leftovers in library code: no `dbg!`, no `println!`/`eprintln!` outside the CLI, no `todo!()`.
  verify: grep the diff.
