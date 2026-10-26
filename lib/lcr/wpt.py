"""WPT property corpus: pinned sparse checkout + the extractor vendored from lightningcss#1328."""
from __future__ import annotations

import json
from pathlib import Path

from .common import SKILL_DIR, LcrError, cache_dir, docker_run, load_config, log, read_json, require_docker, run
from .setup import browsers_tag, ensure_browsers


def checkout(rev: dict) -> Path:
    path = cache_dir() / "wpt" / "checkout"
    if (path / ".git").exists():
        head = run(["git", "-C", str(path), "rev-parse", "HEAD"], check=False).stdout.strip()
        if head == rev["commit"]:
            return path
        run(["git", "-C", str(path), "fetch", "--quiet", "--depth", "1", "origin", rev["commit"]])
        run(["git", "-C", str(path), "checkout", "--quiet", "--detach", rev["commit"]])
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    log(f"cloning WPT (sparse: css, resources) at {rev['commit'][:12]}; one-time, a few hundred MB")
    run(["git", "clone", "--quiet", "--depth", "1", "--filter=blob:none", "--sparse", rev["repository"], str(path)], timeout=1800)
    run(["git", "-C", str(path), "fetch", "--quiet", "--depth", "1", "origin", rev["commit"]], timeout=1800)
    run(["git", "-C", str(path), "checkout", "--quiet", "--detach", rev["commit"]], timeout=1800)
    run(["git", "-C", str(path), "sparse-checkout", "set", "css", "resources", "common"], timeout=3600)
    return path


def ensure_fixtures(refresh: bool = False) -> Path:
    rev = load_config("wpt.json")
    out_dir = cache_dir() / "wpt"
    fixtures = out_dir / f"fixtures-{rev['commit'][:12]}.json"
    if fixtures.exists() and not refresh:
        return fixtures
    require_docker()
    root = checkout(rev)
    tag = ensure_browsers("latest")
    proc = docker_run(
        tag,
        ["node", "/opt/lcr/oracle/wpt/extract.mjs", "/wpt", "--discovery", "--output", f"/out/{fixtures.name}"],
        mounts=[(SKILL_DIR / "oracle", "/opt/lcr/oracle", "ro"), (root, "/wpt", "rw"), (out_dir, "/out", "rw")],
        check=False,
        timeout=3600,
        env={"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "safe.directory", "GIT_CONFIG_VALUE_0": "*"},
    )
    if proc.returncode != 0 or not fixtures.exists():
        raise LcrError(f"WPT extraction failed:\n{(proc.stdout + proc.stderr)[-3000:]}")
    log(proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else "extracted")
    return fixtures


def load_fixtures() -> dict | None:
    rev = load_config("wpt.json")
    path = cache_dir() / "wpt" / f"fixtures-{rev['commit'][:12]}.json"
    return read_json(path)


def wpt_property_dirs(areas: list[str]) -> list[str]:
    meta = load_config("areas.json")["areas"]
    dirs = []
    for a in areas:
        dirs += meta.get(a, {}).get("wpt", [])
    return sorted(set(dirs))
