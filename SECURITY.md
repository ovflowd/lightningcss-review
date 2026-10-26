# Security

## Reporting a vulnerability

Please report security problems in this repository privately, through GitHub's
[private vulnerability reporting](https://github.com/ovflowd/lightningcss-review/security/advisories/new)
("Report a vulnerability" on the Security tab). Do not open a public issue for them.

You will get an answer within a week. Once a fix is ready, the advisory is published with credit
to the reporter, unless you prefer otherwise.

Bugs in Lightning CSS itself belong to
[parcel-bundler/lightningcss](https://github.com/parcel-bundler/lightningcss), not here.

## What this tool trusts

`lcr` reviews pull requests, which means it **builds and runs code from the pull request**: Cargo
build scripts, procedural macros, the test suite, the JS lane's scripts, and the library itself,
compiled into the head adapter and the release CLI. The harness treats everything on the head
side as hostile. Base (current `master`, or the merge base) is upstream code and is trusted.

### What runs where

Every container runs as your user (`uid:gid`, no root), with `--init`, is removed when it exits,
and is killed by name when it outlives its timeout.

| Step | Container | Network | Writable | Read-only |
|---|---|---|---|---|
| `cargo fetch` (build and perf, each side) | `builder` | yes | a throwaway copy of the tree, `cargo-home/` | |
| JS lane: `yarn install --frozen-lockfile --ignore-scripts --no-default-rc` | `builder` | yes | the tree copy, `build/<side>/`, `cargo-home/yarn-cache/` | |
| `cargo fmt --check` | `builder-offline` | no | | `src/<side>/`, `cargo-home/` |
| `cargo test`, the adapter build, the CI lanes, `strip` | `builder-offline` | no | the tree copy, `build/<side>/`, the side's target | `cargo-home/` |
| JS lane: every step after the install | `builder-offline` | no | the tree copy, `build/<side>/`, the side's JS target | `cargo-home/` (with the yarn cache) |
| `perf` release build | `builder-offline` | no | the side's release target | `src/<side>/`, `cargo-home/` |
| adapters (`corpus`, `probe`, `oracle`, `show`, `baseline`): one container per adapter process | `builder-sandbox` | no | `/tmp` (tmpfs) | the adapter binary |
| `perf` timings and smoke test: base and head CLIs, one container | `builder-sandbox` | no | `/tmp` (tmpfs) | both binaries, the runner script, the CSS files |
| browsers and the analysis scripts (`oracle`, `selftest`, `wpt`, `spec`) | `browsers-*` | no | the stage's output directory | the harness's oracle scripts |

`builder-sandbox` also has a read-only root filesystem, no capabilities, `no-new-privileges`, at
most 64 processes and 4 GB of memory, and the host's stack limit (so deep nesting overflows the
stack where it did when adapters ran on the host).

Only cargo and yarn run while the network is on, and neither runs code from the tree there:
`cargo fetch` runs no build script, proc-macro or test, and the install runs no lifecycle script
and reads neither the tree's `.yarnrc` nor its `.npmrc` (`--no-default-rc`, plus
`YARN_IGNORE_PATH=1` against a `yarn-path`). The fetch works on a copy of the tree without its
`.cargo/` directory and toolchain file, with `RUSTUP_TOOLCHAIN` pinned to the image's channel, so
a pull request cannot point the download at another registry or source, or have rustup run a
"toolchain" from the tree. The root package's own lifecycle scripts (upstream's `prepare`) run
right after the install, offline.

### What is shared between runs, and why that is safe

- `cargo-home/` (downloaded and unpacked crates, git checkouts, the yarn cache): only `cargo
  fetch` and the dependency install write to it, and both are the tools themselves, not code from
  the tree. Every build, test, adapter and CLI sees it read-only. cargo and yarn verify what they
  download (registry checksums, lockfile integrity hashes) and store it under its name, version
  and source, so a pull request can add entries but cannot change one another review uses.
- `targets/base`, `base-nowarn`, `base-release` and `js-base`: only base builds write to them,
  and base is trusted.
- `targets/head`, `head-nowarn`, `head-release` and `js-head`: head builds write to them, but every
  run first replaces each one with a copy of its base counterpart (copy-on-write where the
  filesystem supports it), holding the target locks so the copy never sees a base being built.
  Whatever one review's build scripts or tests leave there is gone before the next review's head
  build starts, and never reaches base.
- The Docker images: built from this repository's Dockerfiles, never by code from a review.

### Residual risks

- **A pull request controls its own review's results.** Its build scripts, tests and library code
  can write anything into its own run (`build/head/`, the recorded test tuples, the head
  adapter's answers) and can try to make the review look clean; the base and head release CLIs
  share one container for timing, so head can also skew base's timings. The harness compares
  behavior; it does not detect a deliberately deceptive pull request. Read the diff.
- **Downloads.** During the fetch and the install, a pull request decides which crates, git
  repositories and npm packages are downloaded, from any host its manifests and lockfiles name.
  That reveals your IP address to those hosts and adds entries to the caches, but no code of
  yours or of the tree runs in those containers, and nothing secret is mounted there.
- **Resources.** Builds and tests have no CPU, memory or process limits, so a pull request can make
  its review slow, fill the disk through its run directory or head targets, or hang until the
  build timeout (two hours). That is a denial of service, not an escape.
- **The kernel.** Containers share the host's kernel. A kernel or Docker escape breaks every
  boundary above; the harness uses no user namespaces or gVisor.
- **Files the review leaves behind** belong to your user (the containers run as you). Nothing in
  the harness executes them on the host, but treat a run directory of an untrusted review as
  untrusted data.
- **The JS lane does not run dependencies' install scripts.** None of its steps needs one today; a
  pull request whose JS lane would need one fails there, which the report shows as a JS-lane
  failure.
- **Caches from earlier versions.** Before this version, builds ran with the network, a writable
  Cargo home and shared head targets. If you reviewed untrusted pull requests with an earlier
  version, delete `cargo-home/` and `targets/` in the cache (`~/.cache/lightningcss-review` by
  default) once.
- **`LCR_BUILD=host` turns all of this off.** It builds, tests and runs the adapters and the release
  CLIs directly on your machine, with your user's access and network, and keeps the head targets
  shared across runs. Use it only for trees you trust, such as your own branch. Browsers still run
  in their offline containers.

Reports that break any of these boundaries are in scope: code from a reviewed pull request reaching
the host or the network, writing to a shared cache, or one review silently changing another's
result.
