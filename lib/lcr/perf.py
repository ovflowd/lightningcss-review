"""Optional stage: release-build performance and binary size, base vs head.

Builds the CLI with the repo's real release profile (LTO, codegen-units=1, panic=abort) in the
builder image, then times `lightningcss --minify` on every real-world file (median of N runs,
interleaved base/head to cancel machine drift). Timing is noisy by nature; the thresholds in
config/checks.json only flag consistent slowdowns. Binary size is deterministic for a toolchain.
"""
from __future__ import annotations

import fcntl
import os
import statistics
import subprocess
import time
from pathlib import Path

from .build import HOST, toolchain_channel
from .common import LcrError, cache_dir, docker_run, log, read_json, run, write_json
from .realworld import available_files
from .setup import builder_tag, ensure_builder


def build_release(run_dir: Path, side: str) -> Path:
    tree = run_dir / "src" / side
    out = run_dir / "perf"
    out.mkdir(exist_ok=True)
    cache = cache_dir()
    target = cache / "targets" / f"{side}-release"
    target.mkdir(parents=True, exist_ok=True)
    channel = toolchain_channel(tree)
    script = "cargo build --release --locked --features cli --bin lightningcss"
    with open(cache / "targets" / f"{side}-release.lock", "w") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        if HOST:
            run(["bash", "-c", f"cd {tree} && CARGO_TARGET_DIR={target} {script}"], timeout=3600)
        else:
            ensure_builder(channel)
            docker_run(
                builder_tag(channel),
                ["bash", "-c", f"cd /src && CARGO_HOME=/cargo CARGO_TARGET_DIR=/target {script}"],
                mounts=[(tree, "/src", "ro"), (cache / "cargo-home", "/cargo", "rw"), (target, "/target", "rw")],
                network=True,
                timeout=3600,
            )
        dest = out / f"{side}-lightningcss"
        dest.write_bytes((target / "release" / "lightningcss").read_bytes())
        os.chmod(dest, 0o755)
        fcntl.flock(fh, fcntl.LOCK_UN)
    return dest


def time_once(binary: Path, css: Path) -> float:
    start = time.perf_counter()
    # --error-recovery: several framework sheets carry old hacks (e.g. *zoom) that strict mode rejects
    proc = subprocess.run([str(binary), "--minify", "--error-recovery", str(css)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    elapsed = time.perf_counter() - start
    return elapsed if proc.returncode == 0 else float("nan")


def perf(run_dir: Path, repeats: int = 9) -> dict:
    files = available_files()
    if not files:
        raise LcrError("real-world corpus missing; run `lcr realworld`")
    bins = {side: build_release(run_dir, side) for side in ("base", "head")}
    sizes = {side: bins[side].stat().st_size for side in bins}
    rows = []
    for name, path in files:
        samples = {"base": [], "head": []}
        for i in range(repeats):
            order = ("base", "head") if i % 2 == 0 else ("head", "base")
            for side in order:
                samples[side].append(time_once(bins[side], path))
        med = {side: statistics.median(v) for side, v in samples.items()}
        rows.append({"name": name, "base_ms": round(med["base"] * 1000, 3), "head_ms": round(med["head"] * 1000, 3), "ratio": round(med["head"] / med["base"], 4) if med["base"] else None})
    import math

    valid = [r for r in rows if not math.isnan(r["base_ms"]) and not math.isnan(r["head_ms"])]
    total_base = sum(r["base_ms"] for r in valid)
    total_head = sum(r["head_ms"] for r in valid)
    data = {
        "repeats": repeats,
        "binary_bytes": sizes,
        "binary_ratio": round(sizes["head"] / sizes["base"], 5),
        "total_ms": {"base": round(total_base, 3), "head": round(total_head, 3)},
        "total_ratio": round(total_head / total_base, 4) if total_base else None,
        "slower_share": round(sum(1 for r in valid if r["ratio"] and r["ratio"] > 1.05) / max(1, len(valid)), 3),
        "failed_files": sorted(r["name"] for r in rows if r not in valid),
        "files": rows,
    }
    write_json(run_dir / "perf.json", data)
    log(f"perf: total {data['total_ms']['base']}ms -> {data['total_ms']['head']}ms (x{data['total_ratio']}), binary {sizes['base']} -> {sizes['head']} bytes")
    return data
