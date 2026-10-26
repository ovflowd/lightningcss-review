"""Stage 2: CI-parity checks and adapter builds for base and head, inside the builder image.

Per side: `cargo fmt --check` on the pristine tree; then, on an instrumented copy (adapter example +
test-tuple recorder), `cargo test --all-features --no-fail-fast` with RUSTFLAGS=-D warnings (as CI)
and `cargo build --example lcr_adapter`. Target directories persist per side under the cache, so
consecutive reviews reuse compiled dependencies; the workspace crates always rebuild (`touch_tree`).
"""
from __future__ import annotations

import difflib
import fcntl
import os
import re
import shlex
import shutil
import threading
import time
from pathlib import Path

from .common import LcrError, cache_dir, docker_run, image_exists, log, preflight_disk, read_json, require_docker, run, sha256, write_json
from .inject import inject_adapter, inject_dump
from .setup import builder_tag, ensure_builder

# LCR_BUILD=host builds with the host toolchain instead of the builder image (no isolation; the
# toolchain must match rust-toolchain.toml). Browsers always run in Docker.
HOST = os.environ.get("LCR_BUILD") == "host"
TEST_LINE = re.compile(r"^test (.+?) \.\.\. (ok|FAILED|ignored)(?:, .*)?$")
RUNNING = re.compile(r"^\s*Running (?:unittests )?(\S+)")
DOCTESTS = re.compile(r"^\s*Doc-tests (\S+)")
# Two instrumented trees, test logs and incremental target growth per side.
BUILD_DISK = 4 << 30


def toolchain_channel(tree: Path) -> str:
    f = tree / "rust-toolchain.toml"
    if f.exists():
        m = re.search(r'channel\s*=\s*"([^"]+)"', f.read_text())
        if m:
            return m.group(1)
    return "stable"


def touch_tree(root: Path) -> None:
    """Set every file's mtime to now. `git archive` exports carry commit times and the per-side
    target dirs are shared across runs, so without this cargo can judge another tree's artifacts
    fresh and skip the rebuild."""
    now = time.time()
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            path = os.path.join(dirpath, name)
            if not os.path.islink(path):
                os.utime(path, (now, now))


def fresh_copy(pristine: Path, tree: Path) -> None:
    if tree.exists():
        shutil.rmtree(tree)
    shutil.copytree(pristine, tree, symlinks=True)
    touch_tree(tree)


def parse_test_log(text: str) -> dict:
    tests = {}
    failures = {}
    suite = None
    for line in text.splitlines():
        m = RUNNING.match(line) or DOCTESTS.match(line)
        if m:
            suite = m.group(1).split("/")[-1].split("-")[0] if "deps" in m.group(1) else m.group(1)
            continue
        m = TEST_LINE.match(line.strip())
        if m:
            tests[f"{suite}::{m.group(1)}"] = m.group(2).lower()
    # Failure details: blocks "---- name stdout ----" until next "----" or "failures:" list.
    blocks = re.split(r"^---- (.+?) stdout ----$", text, flags=re.M)
    for i in range(1, len(blocks) - 1, 2):
        name = blocks[i].strip()
        body = blocks[i + 1]
        body = body.split("\nfailures:\n")[0]
        failures[name] = "\n".join(body.strip().splitlines()[:60])
    compile_error = None
    if "error: could not compile" in text or re.search(r"^error(\[E\d+\])?: ", text, re.M):
        errs = re.findall(r"^(error(?:\[E\d+\])?: .+)$", text, re.M)
        compile_error = errs[:20]
    summary = {
        "passed": sum(1 for s in tests.values() if s == "ok"),
        "failed": sum(1 for s in tests.values() if s == "failed"),
        "ignored": sum(1 for s in tests.values() if s == "ignored"),
    }
    return {"tests": dict(sorted(tests.items())), "failures": failures, "compile_errors": compile_error, "summary": summary,
            "warnings_as_errors": "implied by `-D warnings`" in text, "lockfile_outdated": "needs to be updated but --locked was passed" in text}


def builder_script(jobs: int, rustflags: str, locked: bool, lanes: list[str], paths: dict | None = None) -> str:
    """Shell run inside the builder image (or on the host with LCR_BUILD=host).
    Each lane writes <out>/lane-<name>.{log,exit}."""
    p = paths or {"src": "/src", "out": "/out", "target": "/target", "cargo": "/cargo"}
    lock = "--locked" if locked else ""
    extra = {
        "selectors": f"cargo test -p parcel_selectors {lock} -j {jobs}",
        "no-default-features": f"cargo check -p lightningcss --no-default-features --lib {lock} -j {jobs}",
        "wasm-check": f"cargo check --target wasm32-unknown-unknown -p lightningcss_node {lock} -j {jobs}",
        "c-bindings": f"cp c/lightningcss.h /tmp/lightningcss.h.orig && cargo build -p lightningcss_c_bindings {lock} -j {jobs} && diff -u /tmp/lightningcss.h.orig c/lightningcss.h",
    }
    lane_lines = "\n".join(
        f"lane {name} {shlex.quote(extra[name])}" for name in lanes if name in extra
    )
    script = f"""
set -u
cd {p['src']}
export CARGO_HOME={p['cargo']} CARGO_TARGET_DIR={p['target']} RUSTFLAGS='{rustflags}' RUST_BACKTRACE=0
lane() {{ name=$1; shift; s=$(date +%s); sh -c "$1" > {p['out']}/lane-$name.log 2>&1; echo $? > {p['out']}/lane-$name.exit; echo $(( $(date +%s) - s )) > {p['out']}/lane-$name.seconds; }}
start=$(date +%s)
LCR_DUMP={p['out']}/tuples.jsonl cargo test --all-features --no-fail-fast {lock} -j {jobs} > {p['out']}/test.log 2>&1
echo $? > {p['out']}/test.exit
echo $(( $(date +%s) - start )) > {p['out']}/test.seconds
start=$(date +%s)
cargo build --all-features {lock} -j {jobs} --example lcr_adapter > {p['out']}/adapter.log 2>&1
code=$?
echo $code > {p['out']}/adapter.exit
echo $(( $(date +%s) - start )) > {p['out']}/adapter.seconds
if [ $code -eq 0 ]; then cp {p['target']}/debug/examples/lcr_adapter {p['out']}/adapter; fi
{lane_lines}
"""
    return script


def lanes_for(prep: dict, run_dir: Path) -> list[str]:
    files = set(prep.get("files", {}))
    lanes = ["selectors", "no-default-features"]
    patch = (run_dir / "diff.patch").read_text(errors="replace") if (run_dir / "diff.patch").exists() else ""
    wasm_lines = any(l.startswith(("+", "-")) and "target_arch" in l for l in patch.splitlines())
    if any(f.startswith(("napi/", "node/src/", ".cargo/")) for f in files) or wasm_lines:
        lanes.append("wasm-check")
    if any(f.startswith("c/") for f in files):
        lanes.append("c-bindings")
    return lanes


def read_lanes(out: Path) -> dict:
    lanes = {}
    for exit_file in sorted(out.glob("lane-*.exit")):
        name = exit_file.name[len("lane-") : -len(".exit")]
        log_file = out / f"lane-{name}.log"
        text = log_file.read_text(errors="replace") if log_file.exists() else ""
        lanes[name] = {
            "exit": int(exit_file.read_text().strip() or 1),
            "seconds": int((out / f"lane-{name}.seconds").read_text().strip() or 0) if (out / f"lane-{name}.seconds").exists() else None,
            "errors": re.findall(r"^(error(?:\[E\d+\])?: .+)$", text, re.M)[:8],
            "tail": "\n".join(text.strip().splitlines()[-15:]),
        }
    return lanes


def build_side(run_dir: Path, side: str, jobs: int, results: dict, lock: threading.Lock) -> None:
    # Target dirs are shared per side across runs (warm incremental builds). Hold an exclusive
    # lock for the whole sequence so a concurrent review cannot rebuild or overwrite the adapter
    # between our build and our copy.
    lock_path = cache_dir() / "targets" / f"{side}.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "w") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            _build_side(run_dir, side, jobs, results, lock)
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def _build_side(run_dir: Path, side: str, jobs: int, results: dict, lock: threading.Lock) -> None:
    pristine = run_dir / "src" / side
    tree = run_dir / "build" / side / "tree"
    out = run_dir / "build" / side
    out.mkdir(parents=True, exist_ok=True)
    channel = toolchain_channel(pristine)
    if not HOST:
        ensure_builder(channel)
    image = builder_tag(channel) if not HOST else "host"
    cache = cache_dir()
    (cache / "cargo-home").mkdir(exist_ok=True)
    target = cache / "targets" / side
    target.mkdir(parents=True, exist_ok=True)

    # 1. rustfmt on the pristine tree (CI runs `cargo fmt` without --check, so this is advisory).
    if HOST:
        fmt = run(["bash", "-c", f"cd {shlex.quote(str(pristine))} && cargo fmt --all -- --check 2>&1 | head -c 200000; exit ${{PIPESTATUS[0]}}"], check=False)
    else:
        fmt = docker_run(
            image,
            ["bash", "-c", "cd /src && CARGO_HOME=/cargo cargo fmt --all -- --check 2>&1 | head -c 200000; exit ${PIPESTATUS[0]}"],
            mounts=[(pristine, "/src", "ro"), (cache / "cargo-home", "/cargo", "rw")],
            check=False,
        )
    (out / "fmt.txt").write_text(fmt.stdout + fmt.stderr)

    # 2. instrumented copy
    fresh_copy(pristine, tree)
    inject_adapter(tree)
    try:
        injected = inject_dump(tree)
    except LcrError as e:
        injected = {"error": str(e)}
    for name in ("tuples.jsonl", "adapter", "test.log", "adapter.log"):
        (out / name).unlink(missing_ok=True)

    started = time.time()
    attempts = []

    prep = read_json(run_dir / "prepare.json") or {}
    lanes = lanes_for(prep, run_dir)
    for f in out.glob("lane-*"):
        f.unlink()

    def attempt(rustflags: str, locked: bool) -> dict:
        target_dir = target if rustflags else cache / "targets" / f"{side}-nowarn"
        target_dir.mkdir(parents=True, exist_ok=True)
        if HOST:
            paths = {"src": str(tree), "out": str(out), "target": str(target_dir), "cargo": os.environ.get("CARGO_HOME") or str(cache / "cargo-home")}
            run(["bash", "-c", builder_script(jobs, rustflags, locked, lanes, paths)], check=False, timeout=7200)
        else:
            docker_run(
                image,
                ["bash", "-c", builder_script(jobs, rustflags, locked, lanes)],
                mounts=[(tree, "/src", "rw"), (cache / "cargo-home", "/cargo", "rw"), (target_dir, "/target", "rw"), (out, "/out", "rw")],
                network=True,
                check=False,
            )
        text = (out / "test.log").read_text(errors="replace") if (out / "test.log").exists() else ""
        exit_file = out / "test.exit"
        attempts.append({"rustflags": rustflags, "locked": locked, "exit": int(exit_file.read_text().strip() or 1) if exit_file.exists() else None})
        return parse_test_log(text)

    # CI parity first (RUSTFLAGS=-D warnings). Fall back step by step so a lockfile or warning
    # problem is reported as a finding instead of hiding every other result.
    parsed = attempt("-D warnings", True)
    lockfile_outdated = parsed["lockfile_outdated"]
    locked = not lockfile_outdated
    if lockfile_outdated:
        parsed = attempt("-D warnings", False)
    warnings_as_errors = parsed["warnings_as_errors"]
    if warnings_as_errors:
        parsed = attempt("", locked)
    parsed["lockfile_outdated"] = lockfile_outdated
    parsed["warnings_as_errors"] = warnings_as_errors
    adapter_ok = (out / "adapter").exists()
    if adapter_ok:
        bin_dir = run_dir / "bin"
        bin_dir.mkdir(exist_ok=True)
        shutil.copyfile(out / "adapter", bin_dir / f"{side}-adapter")
        os.chmod(bin_dir / f"{side}-adapter", 0o755)
        (out / "adapter").unlink(missing_ok=True)
        if shutil.which("strip"):
            # debug symbols are ~75% of the binary and never needed by the harness
            run(["strip", "--strip-debug", str(bin_dir / f"{side}-adapter")], check=False)
    adapter_log = (out / "adapter.log").read_text(errors="replace") if (out / "adapter.log").exists() else ""
    record = {
        "side": side,
        "toolchain": channel,
        "image": image,
        "fmt_ok": fmt.returncode == 0,
        "fmt_files": sorted(set(re.findall(r"^Diff in (\S+?)(?: at line|:)", fmt.stdout, re.M))),
        "injection": injected,
        "attempts": attempts,
        "test_exit": attempts[-1]["exit"] if attempts else None,
        "test_seconds": int((out / "test.seconds").read_text().strip() or 0) if (out / "test.seconds").exists() else None,
        "adapter_ok": adapter_ok,
        "adapter_errors": re.findall(r"^(error(?:\[E\d+\])?: .+)$", adapter_log, re.M)[:10],
        "tuples": sum(1 for _ in (out / "tuples.jsonl").open()) if (out / "tuples.jsonl").exists() else 0,
        "lanes": read_lanes(out),
        "seconds": int(time.time() - started),
        **{k: parsed[k] for k in ("summary", "compile_errors", "warnings_as_errors", "lockfile_outdated")},
    }
    write_json(out / "tests.json", {"tests": parsed["tests"], "failures": parsed["failures"]})
    with lock:
        results[side] = record


GENERATED_COMPAT = ["src/compat.rs", "src/prefixes.rs", "src/targets.rs", "node/targets.d.ts", "node/flags.js"]


def drift_signature(pristine: bytes, regenerated: bytes) -> str:
    """Hash of the changed lines of regenerated vs committed output, without positions, so the same
    drift on both sides compares equal even when line numbers moved."""
    a = pristine.decode(errors="replace").splitlines()
    b = regenerated.decode(errors="replace").splitlines()
    return sha256("\n".join(l for l in difflib.unified_diff(a, b, n=0, lineterm="") if l[:1] in "+-" and not l.startswith(("+++ ", "--- "))))


def new_drift(head: dict, base: dict) -> list[str]:
    """Generated files whose drift on head (file -> drift_signature) differs from base's."""
    return sorted(rel for rel in head if head[rel] != base.get(rel))


def js_lane(run_dir: Path, regen_compat: bool, regen_ast: bool, run_js: bool, side: str = "head") -> dict:
    """CI test-js job (yarn build/test/tsc) and generated-file drift, on one side's tree."""
    tree = run_dir / "build" / side / "tree"
    pristine = run_dir / "src" / side
    out = run_dir / "build" / side
    image = builder_tag(toolchain_channel(tree))
    steps = ["yarn install --frozen-lockfile --registry=https://registry.npmjs.com/"]
    if run_js:
        steps += ["yarn build", "yarn test", "yarn tsc"]
    if regen_compat:
        steps.append("node scripts/build-prefixes.js")
    if regen_ast:
        steps.append("yarn build-ast")
    body = "\n".join(
        f'echo "### {st}" >> /out/js.log; sh -c {shlex.quote(st)} >> /out/js.log 2>&1; code=$?; echo "### exit $code" >> /out/js.log; '
        f'if [ $code -ne 0 ]; then echo {shlex.quote(st)} > /out/js.failed; exit 0; fi'
        for st in steps
    )
    script = f"""
set -u
cd /src
export CARGO_HOME=/cargo CARGO_TARGET_DIR=/target-js YARN_CACHE_FOLDER=/cargo/yarn-cache PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true PUPPETEER_SKIP_DOWNLOAD=true
{body}
"""
    (out / "js.log").unlink(missing_ok=True)
    (out / "js.failed").unlink(missing_ok=True)
    cache = cache_dir()
    (cache / "targets" / "js").mkdir(parents=True, exist_ok=True)
    with open(cache / "targets" / "js.lock", "w") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        docker_run(image, ["bash", "-c", script], mounts=[(tree, "/src", "rw"), (cache / "cargo-home", "/cargo", "rw"), (cache / "targets" / "js", "/target-js", "rw"), (out, "/out", "rw")], network=True, check=False)
        fcntl.flock(fh, fcntl.LOCK_UN)
    failed = (out / "js.failed").read_text().strip() if (out / "js.failed").exists() else None
    drift = {}
    if not failed:
        for rel in (GENERATED_COMPAT if regen_compat else []) + (["node/ast.d.ts"] if regen_ast else []):
            a, b = pristine / rel, tree / rel
            if a.exists() != b.exists() or (a.exists() and a.read_bytes() != b.read_bytes()):
                drift[rel] = drift_signature(a.read_bytes() if a.exists() else b"", b.read_bytes() if b.exists() else b"")
    return {"ran": True, "steps": steps, "failed_step": failed, "drift": drift, "log": str(out / "js.log"), "js_tests": run_js, "regen_compat": regen_compat, "regen_ast": regen_ast}


def build(run_dir: Path, js: bool = False, jobs: int | None = None) -> dict:
    if not HOST:
        require_docker()
    elif not shutil.which("cargo"):
        raise LcrError("LCR_BUILD=host but cargo is not on PATH")
    prep = read_json(run_dir / "prepare.json")
    if not prep:
        raise LcrError("run `lcr prepare` first")
    preflight_disk(cache_dir(), BUILD_DISK, "build")
    jobs = jobs or max(2, (os.cpu_count() or 4) // 2)
    results: dict = {}
    lock = threading.Lock()
    threads = [threading.Thread(target=build_side, args=(run_dir, side, jobs, results, lock)) for side in ("base", "head")]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    if set(results) != {"base", "head"}:
        raise LcrError("a build thread failed; see build/<side>/*.log")
    flags = {r["id"] for r in prep.get("risk_flags", [])}
    files = set(prep.get("files", {}))
    run_js = js or "bindings" in flags
    regen_compat = bool(files & (set(GENERATED_COMPAT) | {"scripts/build-prefixes.js", "package.json", "yarn.lock"}))
    regen_ast = "public-api" in flags or "ast-types-changed" in flags or "node/ast.d.ts" in files
    if HOST and (run_js or regen_compat or regen_ast):
        js_result = {"ran": False, "skipped": "JS lane needs the builder image (LCR_BUILD=host)"}
    else:
        js_result = js_lane(run_dir, regen_compat, regen_ast, run_js) if (run_js or regen_compat or regen_ast) else {"ran": False}
        if regen_compat or regen_ast:
            # Generated files can already drift on master; only a different drift is the PR's.
            base_js = js_lane(run_dir, regen_compat, regen_ast, False, side="base")
            js_result["base_failed_step"] = base_js["failed_step"]
            js_result["base_log"] = base_js["log"]
            if not base_js["failed_step"]:
                js_result["base_drift"] = base_js["drift"]
                js_result["drift_new"] = new_drift(js_result["drift"], base_js["drift"])
    record = {"base": results["base"], "head": results["head"], "js": js_result}
    write_json(run_dir / "build.json", record)
    for side in ("base", "head"):
        r = results[side]
        log(f"{side}: tests {r['summary']} exit={r['test_exit']} adapter={'ok' if r['adapter_ok'] else 'FAILED'} tuples={r['tuples']} ({r['seconds']}s)")
    return record
