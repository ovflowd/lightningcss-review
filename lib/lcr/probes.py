"""lcr-probe v1 parser/validator. Format: references/probe-format.md (and templates/probe.css.tmpl)."""
from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

from .common import SKILL_DIR, LcrError, load_config
from .targets import parse_targets

HEADER_RE = re.compile(r"^\s*/\*!\s*lcr-probe\b(.*?)\*/", re.S)
MODES = {"print", "minify", "lower", "lower-minify"}
# Any other kebab-case name is passed through as a ParserFlags name (e.g. a draft flag a PR adds:
# `custom-functions` -> ParserFlags::CUSTOM_FUNCTIONS); revisions without it report a request error.
NON_PARSER_FLAGS = ("error-recovery", "css-modules")
FLAG_RE = re.compile(r"^(error-recovery|css-modules|unused-symbols:[\w|-]+|[a-z][a-z0-9-]*)$")
EXPECT_RE = re.compile(r'^(equivalent|idempotent|no-panic|parse-error|output-(contains|not-contains|equals):"(.*)")$', re.S)
KNOWN_RE = re.compile(r"^(none|open-issue#\d+|open-bug|fixed-by#(\d+|[0-9a-f]{7,40}))$")


@dataclass
class Probe:
    path: Path
    id: str
    area: str
    title: str
    mode: str
    targets: dict | None
    targets_text: str
    flags: list[str]
    expect: list[str]
    known: str
    refs: list[str]
    css: str
    dom: str | None = None
    note: str | None = None
    origin: str = "curated"
    errors: list[str] = field(default_factory=list)

    def request(self) -> dict:
        """Adapter request for this probe (without id)."""
        minify = self.mode != "print"
        compact = self.mode in ("minify", "lower-minify")
        req = {"kind": "sheet", "css": self.css, "minify": minify, "compact": compact, "targets": self.targets if self.mode.startswith("lower") or self.targets else None}
        parser_flags = [f for f in self.flags if f not in NON_PARSER_FLAGS and not f.startswith("unused-symbols:")]
        if parser_flags:
            req["flags"] = parser_flags
        if "error-recovery" in self.flags:
            req["error_recovery"] = True
        if "css-modules" in self.flags:
            req["css_modules"] = {}
            req["filename"] = "test.css"
        for f in self.flags:
            if f.startswith("unused-symbols:"):
                req["unused_symbols"] = sorted(f.split(":", 1)[1].split("|"))
        return req


def split_list(value: str) -> list[str]:
    """Comma-separated list where quoted strings may contain commas."""
    out, cur, quote = [], "", False
    for ch in value:
        if ch == '"':
            quote = not quote
        if ch == "," and not quote:
            if cur.strip():
                out.append(cur.strip())
            cur = ""
        else:
            cur += ch
    if cur.strip():
        out.append(cur.strip())
    return out


def parse_probe(path: Path, origin: str = "curated") -> Probe:
    text = path.read_text()
    m = HEADER_RE.match(text)
    if not m:
        raise LcrError(f"{path}: missing /*! lcr-probe ... */ header")
    header, css = m.group(1), text[m.end():]
    fields: dict[str, str] = {}
    errors = []
    for line in header.splitlines():
        if not line.strip():
            continue
        km = re.match(r"^\s*([a-z-]+):\s?(.*)$", line)
        if not km:
            errors.append(f"bad header line: {line.strip()[:80]}")
            continue
        key, value = km.group(1), km.group(2).strip()
        if key in fields:
            errors.append(f"duplicate key {key}")
        fields[key] = value
    for key in ("id", "area", "title", "mode", "expect", "known", "ref"):
        if not fields.get(key):
            errors.append(f"missing required key {key}")
    areas = load_config("areas.json")["areas"]
    area = fields.get("area", "")
    if area and area not in areas:
        errors.append(f"unknown area {area}")
    mode = fields.get("mode", "")
    if mode and mode not in MODES:
        errors.append(f"unknown mode {mode}")
    targets_text = fields.get("targets", "none")
    try:
        targets = parse_targets(targets_text)
    except LcrError as e:
        errors.append(str(e))
        targets = None
    if mode.startswith("lower") and not targets:
        errors.append("lower modes need targets")
    flags = split_list(fields.get("flags", ""))
    for f in flags:
        if not FLAG_RE.match(f):
            errors.append(f"unknown flag {f}")
    expect = split_list(fields.get("expect", ""))
    for e in expect:
        if not EXPECT_RE.match(e):
            errors.append(f"bad expect {e}")
    known = fields.get("known", "")
    if known and not KNOWN_RE.match(known):
        errors.append(f"bad known {known}")
    pid = fields.get("id", "")
    if pid and not re.match(r"^[a-z0-9-]+/[a-z0-9][a-z0-9._-]*$", pid):
        errors.append(f"bad id {pid} (expected <area>/<kebab-slug>)")
    if not css.strip():
        errors.append("empty CSS body")
    return Probe(
        path=path,
        id=pid,
        area=area,
        title=fields.get("title", ""),
        mode=mode,
        targets=targets,
        targets_text=targets_text,
        flags=flags,
        expect=expect,
        known=known,
        refs=fields.get("ref", "").split(),
        css=css.strip("\n") + "\n",
        dom=fields.get("dom") or None,
        note=fields.get("note") or None,
        origin=origin,
        errors=errors,
    )


def load_probes(dirs: list[tuple[Path, str]]) -> tuple[list[Probe], list[str]]:
    probes, problems, seen = [], [], {}
    for directory, origin in dirs:
        if not directory.exists():
            continue
        for path in sorted(directory.rglob("*.css")):
            try:
                p = parse_probe(path, origin)
            except LcrError as e:
                problems.append(str(e))
                continue
            if p.errors:
                problems.append(f"{path}: " + "; ".join(p.errors))
                continue
            if p.id in seen:
                problems.append(f"{path}: duplicate id {p.id} (also {seen[p.id]})")
                continue
            seen[p.id] = path
            probes.append(p)
    return sorted(probes, key=lambda p: p.id), problems


def curated_dirs() -> list[tuple[Path, str]]:
    return [(SKILL_DIR / "corpus" / "probes", "curated")]


def validate_cli(paths: list[str]) -> int:
    dirs = [(Path(p), "cli") for p in paths] if paths else curated_dirs()
    probes, problems = load_probes(dirs)
    for line in problems:
        print(line)
    by_area: dict[str, int] = {}
    for p in probes:
        by_area[p.area] = by_area.get(p.area, 0) + 1
    print(f"{len(probes)} valid probes, {len(problems)} problems")
    for area, n in sorted(by_area.items()):
        print(f"  {area}: {n}")
    return 1 if problems else 0
