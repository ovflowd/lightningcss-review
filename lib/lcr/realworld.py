"""Pinned real-world stylesheets (config/realworld.json): fetched once, verified by sha256."""
from __future__ import annotations

import urllib.request
from pathlib import Path

from .common import LcrError, cache_dir, load_config, log, sha256, write_json, CONFIG_DIR


def realworld_dir() -> Path:
    d = cache_dir() / "realworld"
    d.mkdir(parents=True, exist_ok=True)
    return d


def ensure_realworld(pin_missing: bool = False) -> Path:
    cfg = load_config("realworld.json")
    changed = False
    for entry in cfg["files"]:
        path = realworld_dir() / f"{entry['name']}.css"
        if path.exists() and entry.get("sha256") == sha256(path.read_bytes()):
            continue
        log(f"fetching {entry['url']}")
        req = urllib.request.Request(entry["url"], headers={"User-Agent": "lightningcss-review"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = resp.read()
        digest = sha256(data)
        if entry.get("sha256") and entry["sha256"] != digest:
            raise LcrError(f"{entry['name']}: sha256 mismatch (pinned {entry['sha256'][:12]}, got {digest[:12]}); the upstream file changed")
        if not entry.get("sha256"):
            entry["sha256"] = digest
            entry["bytes"] = len(data)
            changed = True
        path.write_bytes(data)
    if changed:
        write_json(CONFIG_DIR / "realworld.json", cfg)
        log("pinned new sha256 values in config/realworld.json")
    return realworld_dir()


def available_files() -> list[tuple[str, Path]]:
    cfg = load_config("realworld.json")
    out = []
    for entry in cfg["files"]:
        path = realworld_dir() / f"{entry['name']}.css"
        if path.exists() and entry.get("sha256") == sha256(path.read_bytes()):
            out.append((entry["name"], path))
    if not out:
        log("real-world corpus not downloaded; run `lcr realworld` once")
    return sorted(out)
