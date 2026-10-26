"""Host checks and Docker image setup. Records exact engine versions in <cache>/env.json."""
from __future__ import annotations

import json
import shutil
import sys

from .common import (
    SKILL_DIR,
    LcrError,
    cache_dir,
    docker_available,
    docker_cmd,
    docker_run,
    image_exists,
    image_id,
    load_config,
    log,
    read_json,
    repo_dir,
    run,
    skill_version,
    which,
    write_json,
)

DOCKER_DIR = SKILL_DIR / "docker"


def builder_tag(channel: str) -> str:
    return f"lcr-builder:rust-{channel}"


def browsers_tag(profile: str) -> str:
    cfg = load_config("engines.json")["profiles"][profile]
    suffix = "-analysis" if cfg.get("analysis") else ""
    return f"lcr-browsers:pw-{cfg['playwright']}{suffix}"


def docker_build(tag: str, dockerfile: str, build_args: dict) -> None:
    cmd = docker_cmd() + ["build", "-f", str(DOCKER_DIR / dockerfile), "-t", tag]
    for k, v in build_args.items():
        cmd += ["--build-arg", f"{k}={v}"]
    cmd.append(str(DOCKER_DIR))
    log(f"building {tag} (this can take a few minutes the first time)")
    proc = run(cmd, check=False, capture=True)
    if proc.returncode != 0:
        raise LcrError(f"docker build {tag} failed:\n{(proc.stdout + proc.stderr)[-3000:]}")


def ensure_builder(channel: str, rebuild: bool = False) -> str:
    tag = builder_tag(channel)
    if rebuild or not image_exists(tag):
        docker_build(tag, "builder.Dockerfile", {"RUST_CHANNEL": channel})
    return tag


def ensure_browsers(profile: str, rebuild: bool = False) -> str:
    cfg = load_config("engines.json")
    prof = cfg["profiles"][profile]
    tag = browsers_tag(profile)
    if rebuild or not image_exists(tag):
        extra = " ".join(cfg["analysis_packages"]) if prof.get("analysis") else ""
        apt = "python3 git" if prof.get("analysis") else ""
        docker_build(tag, "browsers.Dockerfile", {"PLAYWRIGHT_VERSION": prof["playwright"], "DISTRO": prof["distro"], "EXTRA_PACKAGES": extra, "APT_PACKAGES": apt})
    return tag


def engine_versions(profile: str) -> dict:
    tag = browsers_tag(profile)
    proc = docker_run(
        tag,
        ["node", "/opt/lcr/oracle/engine-runner.cjs", "--versions"],
        mounts=[(SKILL_DIR / "oracle", "/opt/lcr/oracle", "ro")],
        check=False,
        timeout=300,
    )
    try:
        return json.loads(proc.stdout.strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError):
        raise LcrError(f"could not read engine versions for {profile}:\n{(proc.stdout + proc.stderr)[-2000:]}")


def default_profiles() -> list[str]:
    return load_config("engines.json")["default_profiles"]


def setup(profiles: str | None = None, rebuild: bool = False) -> int:
    ok, detail = docker_available()
    if not ok:
        raise LcrError(detail)
    wanted = profiles.split(",") if profiles else default_profiles()
    cfg = load_config("engines.json")
    if "latest" not in wanted:
        wanted.insert(0, "latest")
    env = read_json(cache_dir() / "env.json", {}) or {}
    env.setdefault("profiles", {})
    for profile in wanted:
        if profile not in cfg["profiles"]:
            raise LcrError(f"unknown engine profile {profile}")
        tag = ensure_browsers(profile, rebuild)
        versions = engine_versions(profile)
        bad = {k: v for k, v in versions.items() if isinstance(v, str) and v.startswith("ERROR")}
        if bad:
            raise LcrError(f"engines failed to launch in {tag}: {bad}")
        env["profiles"][profile] = {"image": tag, "image_id": image_id(tag), "role": cfg["profiles"][profile]["role"], "versions": versions}
        log(f"{profile}: {tag} -> " + ", ".join(f"{k} {v}" for k, v in versions.items()))
    channel = "stable"
    toolchain = repo_dir() / "rust-toolchain.toml"
    if toolchain.exists():
        import re

        m = re.search(r'channel\s*=\s*"([^"]+)"', toolchain.read_text())
        if m:
            channel = m.group(1)
    tag = ensure_builder(channel, rebuild)
    env["builder"] = {"image": tag, "image_id": image_id(tag), "channel": channel}
    env["skill_version"] = skill_version()
    write_json(cache_dir() / "env.json", env)
    print(json.dumps(env, indent=2, sort_keys=True))
    return 0


def doctor() -> int:
    rows = []

    def check(name, ok, detail=""):
        rows.append((name, "ok" if ok else "MISSING", detail))

    check("python >= 3.12", sys.version_info >= (3, 12), sys.version.split()[0])
    for tool in ("git", "gh", "docker"):
        check(tool, bool(which(tool)), which(tool) or "")
    if which("gh"):
        proc = run(["gh", "auth", "status"], check=False)
        check("gh auth", proc.returncode == 0, (proc.stdout + proc.stderr).strip().splitlines()[1].strip() if proc.returncode == 0 and len((proc.stdout + proc.stderr).strip().splitlines()) > 1 else "run `gh auth login`")
    ok, detail = docker_available()
    check("docker daemon access", ok, detail)
    check("lightningcss clone", (repo_dir() / ".git").exists(), str(repo_dir()))
    free = shutil.disk_usage(cache_dir()).free // (1 << 30)
    check("disk space for images (>= 15 GiB)", free >= 15, f"{free} GiB free in {cache_dir()}")
    if ok:
        env = read_json(cache_dir() / "env.json", {}) or {}
        for profile in default_profiles():
            tag = browsers_tag(profile)
            check(f"image {tag}", image_exists(tag), json.dumps(env.get("profiles", {}).get(profile, {}).get("versions", {})))
    width = max(len(r[0]) for r in rows)
    for name, status, detail in rows:
        print(f"{name.ljust(width)}  {status:8}  {detail}")
    return 0 if all(r[1] == "ok" for r in rows) else 1
