/**
 * The shell scripts the build stage runs inside the builder image (or on the host with
 * `LCR_BUILD=host`): cargo test with the tuple recorder, the adapter build, the extra CI lanes and
 * the JS lane. A script is the one place the harness hands a shell its payload: each step's exit
 * status and duration land in files under `/out`, so one failing step never hides the others.
 *
 * Stage: build. Reads prepare.json (which lanes a change needs) and diff.patch.
 *
 * Invariant: the scripts are byte-identical to py-final's (same steps, flags and output files),
 * because their files (`test.exit`, `lane-*.log`, `tuples.jsonl`, `js.failed`) are what build.json
 * is computed from.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { readPyText } from '../core/files.js';
import { shellJoin } from '../core/proc.js';
import { pySplitlines } from '../core/py.js';

/** @import { Prepare } from '../types.js' */

/**
 * @typedef {object} ScriptPaths Where the script finds things (container paths by default).
 * @property {string} src The instrumented tree.
 * @property {string} out build/<side>/
 * @property {string} target CARGO_TARGET_DIR
 * @property {string} cargo CARGO_HOME
 */

/** @type {ScriptPaths} */
const CONTAINER_PATHS = Object.freeze({ src: '/src', out: '/out', target: '/target', cargo: '/cargo' });

/**
 * The extra lanes CI runs that `cargo test` does not cover.
 *
 * @param {number} jobs
 * @param {string} lock `--locked` or ''.
 * @returns {Record<string, string>}
 */
function laneCommands(jobs, lock) {
  return {
    selectors: `cargo test -p parcel_selectors ${lock} -j ${jobs}`,
    'no-default-features': `cargo check -p lightningcss --no-default-features --lib ${lock} -j ${jobs}`,
    'wasm-check': `cargo check --target wasm32-unknown-unknown -p lightningcss_node ${lock} -j ${jobs}`,
    'c-bindings': `cp c/lightningcss.h /tmp/lightningcss.h.orig && cargo build -p lightningcss_c_bindings ${lock} -j ${jobs} && diff -u /tmp/lightningcss.h.orig c/lightningcss.h`,
  };
}

/**
 * @typedef {object} BuilderScriptOptions
 * @property {number} jobs cargo `-j`.
 * @property {string} rustflags `-D warnings` (CI parity) or '' (the fallback attempt).
 * @property {boolean} locked Pass `--locked`.
 * @property {string[]} lanes Extra lanes to run (see `lanesFor`).
 * @property {ScriptPaths | null} [paths] Host paths for `LCR_BUILD=host`.
 */

/**
 * The per-side build script: `cargo test` with the recorder (`LCR_DUMP`), the adapter example
 * build (copied to `<out>/adapter` on success), then each lane to `<out>/lane-<name>.{log,exit,
 * seconds}`.
 *
 * @param {BuilderScriptOptions} options
 * @returns {string}
 */
export function builderScript({ jobs, rustflags, locked, lanes, paths = null }) {
  const { src, out, target, cargo } = paths ?? CONTAINER_PATHS;
  const lock = locked ? '--locked' : '';
  const commands = laneCommands(jobs, lock);
  const laneLines = lanes
    .filter((name) => Object.hasOwn(commands, name))
    .map((name) => `lane ${name} ${shellJoin([commands[name]])}`)
    .join('\n');

  return `
set -u
cd ${src}
export CARGO_HOME=${cargo} CARGO_TARGET_DIR=${target} RUSTFLAGS='${rustflags}' RUST_BACKTRACE=0
lane() { name=$1; shift; s=$(date +%s); sh -c "$1" > ${out}/lane-$name.log 2>&1; echo $? > ${out}/lane-$name.exit; echo $(( $(date +%s) - s )) > ${out}/lane-$name.seconds; }
start=$(date +%s)
LCR_DUMP=${out}/tuples.jsonl cargo test --all-features --no-fail-fast ${lock} -j ${jobs} > ${out}/test.log 2>&1
echo $? > ${out}/test.exit
echo $(( $(date +%s) - start )) > ${out}/test.seconds
start=$(date +%s)
cargo build --all-features ${lock} -j ${jobs} --example lcr_adapter > ${out}/adapter.log 2>&1
code=$?
echo $code > ${out}/adapter.exit
echo $(( $(date +%s) - start )) > ${out}/adapter.seconds
if [ $code -eq 0 ]; then cp ${target}/debug/examples/lcr_adapter ${out}/adapter; fi
${laneLines}
`;
}

/** Paths whose change needs the wasm32 check (bindings and cargo config). */
const WASM_PREFIXES = ['napi/', 'node/src/', '.cargo/'];

/**
 * The extra lanes a change needs: always `selectors` and `no-default-features`; `wasm-check`
 * when bindings, cargo config or a `target_arch` line change; `c-bindings` when c/ changes.
 *
 * @param {Partial<Prepare>} prep
 * @param {string} runDir
 * @returns {string[]}
 */
export function lanesFor(prep, runDir) {
  const files = Object.keys(prep.files ?? {});
  const patchFile = join(runDir, 'diff.patch');
  const patch = existsSync(patchFile) ? readPyText(patchFile, { replace: true }) : '';
  const wasmLines = pySplitlines(patch).some(
    (line) => (line.startsWith('+') || line.startsWith('-')) && line.includes('target_arch'),
  );
  const lanes = ['selectors', 'no-default-features'];

  if (files.some((file) => WASM_PREFIXES.some((prefix) => file.startsWith(prefix))) || wasmLines) {
    lanes.push('wasm-check');
  }

  if (files.some((file) => file.startsWith('c/'))) {
    lanes.push('c-bindings');
  }

  return lanes;
}

/** The registry the JS lane installs from (never a private mirror). */
const YARN_REGISTRY = 'https://registry.npmjs.com/';

/**
 * @typedef {object} JsSteps Which JS-lane steps run.
 * @property {boolean} runJs `yarn build`, `yarn test`, `yarn tsc` (CI's test-js job).
 * @property {boolean} regenCompat Regenerate src/compat.rs and friends (`build-prefixes.js`).
 * @property {boolean} regenAst Regenerate node/ast.d.ts (`yarn build-ast`).
 */

/**
 * The JS-lane steps, in order.
 *
 * @param {JsSteps} steps
 * @returns {string[]}
 */
export function jsSteps({ runJs, regenCompat, regenAst }) {
  const steps = [`yarn install --frozen-lockfile --registry=${YARN_REGISTRY}`];

  if (runJs) {
    steps.push('yarn build', 'yarn test', 'yarn tsc');
  }

  if (regenCompat) {
    steps.push('node scripts/build-prefixes.js');
  }

  if (regenAst) {
    steps.push('yarn build-ast');
  }

  return steps;
}

/**
 * The JS-lane script: each step appends to `/out/js.log`; the first failing step is written to
 * `/out/js.failed` and ends the script.
 *
 * @param {string[]} steps
 * @returns {string}
 */
export function jsLaneScript(steps) {
  const body = steps
    .map(
      (step) =>
        `echo "### ${step}" >> /out/js.log; sh -c ${shellJoin([step])} >> /out/js.log 2>&1; code=$?; echo "### exit $code" >> /out/js.log; ` +
        `if [ $code -ne 0 ]; then echo ${shellJoin([step])} > /out/js.failed; exit 0; fi`,
    )
    .join('\n');

  return `
set -u
cd /src
export CARGO_HOME=/cargo CARGO_TARGET_DIR=/target-js YARN_CACHE_FOLDER=/cargo/yarn-cache PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true PUPPETEER_SKIP_DOWNLOAD=true
${body}
`;
}

/** fmt.txt keeps at most this much of `cargo fmt --check` (a badly formatted tree prints its whole diff). */
const FMT_OUTPUT_BYTES = 200_000;

/**
 * `cargo fmt --check` on the pristine tree, output capped, exiting with cargo's status rather
 * than `head`'s.
 *
 * @param {string} cd The directory to run in, already shell-quoted.
 * @param {{ prefix?: string }} [options] Environment assignments before `cargo`.
 * @returns {string}
 */
export function fmtScript(cd, { prefix = '' } = {}) {
  return `cd ${cd} && ${prefix}cargo fmt --all -- --check 2>&1 | head -c ${FMT_OUTPUT_BYTES}; exit \${PIPESTATUS[0]}`;
}
