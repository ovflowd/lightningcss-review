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

`lcr` reviews pull requests, which means it **builds and runs code from the pull request**:
Cargo build scripts, procedural macros and the test suite. Treat a review like checking out and
building the branch yourself.

- Every build, test and browser run happens in a Docker container, as your user, with only the
  run directory and the harness cache mounted. Nothing from the pull request runs on the host.
- The browser oracle runs with networking disabled.
- The builder container needs the network to fetch crates, and it shares a Cargo home and build
  targets across runs to stay fast. A malicious pull request could therefore tamper with the
  cache and influence later reviews. After reviewing code you do not trust, delete `cargo-home/`
  and `targets/` in the cache (`~/.cache/lightningcss-review` by default), or point `LCR_CACHE` at
  a throwaway directory for that review.

Reports that break any of these boundaries (code from a reviewed pull request reaching the host,
the oracle reaching the network, or one review silently changing another's result) are in scope.
