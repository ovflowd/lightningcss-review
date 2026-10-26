"""Shared paths, config, process and JSON helpers for lightningcss-review (stdlib only)."""
from __future__ import annotations

import hashlib
import json
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parents[2]
CONFIG_DIR = SKILL_DIR / "config"
UPSTREAM = "parcel-bundler/lightningcss"
SCHEMA_VERSION = 1


def skill_version() -> str:
    return (SKILL_DIR / "VERSION").read_text().strip()


def cache_dir() -> Path:
    base = os.environ.get("LCR_CACHE")
    if base:
        path = Path(base)
    else:
        xdg = os.environ.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
        path = Path(xdg) / "lightningcss-review"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _is_lightningcss_checkout(path: Path) -> bool:
    cargo = path / "Cargo.toml"
    return cargo.is_file() and 'name = "lightningcss"' in cargo.read_text(errors="replace")


def repo_dir() -> Path:
    """The LightningCSS clone the harness fetches into (read-only use: refs and `git archive`).

    Order: $LCR_REPO, the checkout the command runs in, an existing ~/GitHub/lightningcss, else a
    clone managed under the cache directory."""
    env = os.environ.get("LCR_REPO")
    if env:
        return Path(env).expanduser().resolve()
    try:
        top = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True
        ).stdout.strip()
        if top and _is_lightningcss_checkout(Path(top)):
            return Path(top)
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass
    home = Path.home()
    for candidate in (home / "GitHub" / "lightningcss",):
        if _is_lightningcss_checkout(candidate):
            return candidate
    return cache_dir() / "lightningcss"


def load_config(name: str):
    return json.loads((CONFIG_DIR / name).read_text())


def sha256(data: bytes | str) -> str:
    if isinstance(data, str):
        data = data.encode()
    return hashlib.sha256(data).hexdigest()


def stable_id(*parts) -> str:
    return sha256(json.dumps(parts, sort_keys=True, ensure_ascii=False))[:16]


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n")
    tmp.replace(path)


def read_json(path: Path, default=None):
    if not path.exists():
        return default
    return json.loads(path.read_text())


def write_jsonl(path: Path, rows) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w") as f:
        for row in rows:
            f.write(json.dumps(row, sort_keys=True, ensure_ascii=False) + "\n")
            count += 1
    tmp.replace(path)
    return count


def read_jsonl(path: Path):
    if not path.exists():
        return []
    rows = []
    with path.open() as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def log(message: str) -> None:
    print(f"[lcr] {message}", file=sys.stderr, flush=True)


class LcrError(Exception):
    """A user-facing failure with a fix hint."""


def run(cmd, *, cwd=None, env=None, check=True, capture=True, input=None, timeout=None) -> subprocess.CompletedProcess:
    full_env = None
    if env:
        full_env = os.environ.copy()
        full_env.update(env)
    try:
        proc = subprocess.run(
            cmd,
            cwd=cwd,
            env=full_env,
            text=True,
            input=input,
            capture_output=capture,
            timeout=timeout,
        )
    except FileNotFoundError as e:
        raise LcrError(f"command not found: {cmd[0]} ({e})")
    if check and proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()[-4000:]
        raise LcrError(f"command failed ({proc.returncode}): {shlex.join(map(str, cmd))}\n{detail}")
    return proc


def git(*args, check=True) -> str:
    return run(["git", "-C", str(repo_dir()), *args], check=check).stdout


def which(name: str) -> str | None:
    return shutil.which(name)


# ---------------------------------------------------------------------------------------------
# Docker


def docker_cmd() -> list[str]:
    return ["docker"]


def docker_available() -> tuple[bool, str]:
    if not which("docker"):
        return False, "docker is not installed"
    proc = subprocess.run(docker_cmd() + ["info", "--format", "{{.ServerVersion}}"], capture_output=True, text=True)
    if proc.returncode != 0:
        err = (proc.stderr or "").strip()
        if "permission denied" in err:
            return False, (
                "docker socket permission denied. Fix: sudo usermod -aG docker $USER (then log in again), "
                "or for the current session: sudo setfacl -m u:$USER:rw /var/run/docker.sock"
            )
        if "Cannot connect" in err or "Is the docker daemon running" in err:
            return False, "docker daemon is not running. Fix: sudo systemctl enable --now docker"
        return False, err or "docker info failed"
    return True, proc.stdout.strip()


def require_docker() -> None:
    ok, detail = docker_available()
    if not ok:
        raise LcrError(detail)


def image_exists(tag: str) -> bool:
    proc = subprocess.run(docker_cmd() + ["image", "inspect", tag], capture_output=True, text=True)
    return proc.returncode == 0


def image_id(tag: str) -> str | None:
    proc = subprocess.run(
        docker_cmd() + ["image", "inspect", "--format", "{{.Id}}", tag], capture_output=True, text=True
    )
    return proc.stdout.strip() if proc.returncode == 0 else None


def docker_run(
    image: str,
    command: list[str],
    *,
    mounts: list[tuple[Path, str, str]] = (),
    env: dict | None = None,
    workdir: str | None = None,
    network: bool = False,
    shm: str = "2g",
    check: bool = True,
    capture: bool = True,
    timeout: int | None = None,
    stdin_text: str | None = None,
) -> subprocess.CompletedProcess:
    """Run a throwaway container as the host user. mounts: (host_path, container_path, 'ro'|'rw')."""
    cmd = docker_cmd() + ["run", "--rm", "--init", f"--user={os.getuid()}:{os.getgid()}", f"--shm-size={shm}"]
    if stdin_text is not None:
        cmd.append("-i")
    if not network:
        cmd.append("--network=none")
    for host, container, mode in mounts:
        cmd += ["-v", f"{Path(host).resolve()}:{container}:{mode}"]
    merged_env = {"HOME": "/tmp", "TZ": "UTC", "LANG": "C.UTF-8"}
    merged_env.update(env or {})
    for key, value in sorted(merged_env.items()):
        cmd += ["-e", f"{key}={value}"]
    if workdir:
        cmd += ["-w", workdir]
    cmd.append(image)
    cmd += command
    return run(cmd, check=check, capture=capture, timeout=timeout, input=stdin_text)
