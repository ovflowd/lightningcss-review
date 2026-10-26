"""Browser target encoding (LightningCSS uses major<<16 | minor<<8 | patch) and Debug-string parsing."""
from __future__ import annotations

import re
from pathlib import Path

from .common import LcrError, load_config

BROWSERS = ("android", "chrome", "edge", "firefox", "ie", "ios_saf", "opera", "safari", "samsung")


def encode_version(text: str) -> int:
    parts = [int(p) for p in text.strip().split(".")]
    parts += [0] * (3 - len(parts))
    major, minor, patch = parts[:3]
    return (major << 16) | (minor << 8) | patch


def decode_version(value: int) -> str:
    major, minor, patch = value >> 16, (value >> 8) & 0xFF, value & 0xFF
    if patch:
        return f"{major}.{minor}.{patch}"
    if minor:
        return f"{major}.{minor}"
    return str(major)


def parse_targets(spec: str | None) -> dict | None:
    """'chrome 80, safari 13.1' -> {'chrome': 5242880, 'safari': 852224}; 'none'/None -> None.
    A preset name from config/modes.json is also accepted."""
    if spec is None:
        return None
    spec = spec.strip()
    if spec in ("", "none", "null"):
        return None
    presets = load_config("modes.json")["targets"]
    if spec in presets:
        return parse_targets(presets[spec])
    out = {}
    for item in spec.split(","):
        item = item.strip()
        if not item:
            continue
        m = re.fullmatch(r"([a-z_]+)\s+(\d+(?:\.\d+){0,2})", item)
        if not m or m.group(1) not in BROWSERS:
            raise LcrError(f"bad target '{item}' (expected '<browser> <version>', browsers: {', '.join(BROWSERS)})")
        out[m.group(1)] = encode_version(m.group(2))
    return dict(sorted(out.items())) or None


def format_targets(targets: dict | None) -> str:
    if not targets:
        return "none"
    return ", ".join(f"{k} {decode_version(v)}" for k, v in sorted(targets.items()))


def parse_browsers_debug(text: str) -> dict | None:
    """Parse `Browsers { chrome: Some(5898240), ... }`, `Some(Browsers {..})` or `None`."""
    if text is None:
        return None
    text = text.strip()
    if text in ("None", ""):
        return None
    found = dict(re.findall(r"\b([a-z_]+): Some\((\d+)\)", text))
    out = {k: int(v) for k, v in found.items() if k in BROWSERS}
    return dict(sorted(out.items())) or None


def feature_bits(src_root: Path) -> dict[str, int]:
    """Read the Features bitflags from a tree's src/targets.rs (names differ across revisions)."""
    text = (src_root / "src" / "targets.rs").read_text()
    m = re.search(r"pub struct Features: u32 \{(.*?)\n  \}", text, re.S)
    if not m:
        raise LcrError("could not find Features bitflags in src/targets.rs")
    bits: dict[str, int] = {}
    for name, expr in re.findall(r"const (\w+) = ([^;]+);", m.group(1)):
        expr = expr.strip()
        shift = re.fullmatch(r"1 << (\d+)", expr)
        if shift:
            bits[name] = 1 << int(shift.group(1))
            continue
        value = 0
        for ref in re.findall(r"Self::(\w+)\.bits\(\)", expr):
            value |= bits.get(ref, 0)
        bits[name] = value
    return bits


def parse_flags_debug(text: str, bits: dict[str, int] | None = None) -> int | list[str]:
    """`Features(Nesting | MediaQueries)` / `Features(0x0)` / `ParserFlags(CUSTOM_MEDIA)`.
    Returns an int when `bits` is given, otherwise the list of names."""
    m = re.fullmatch(r"\s*\w+\((.*)\)\s*", text or "")
    inner = m.group(1).strip() if m else ""
    names, value = [], 0
    for part in [p.strip() for p in inner.split("|") if p.strip()]:
        if re.fullmatch(r"0x[0-9a-fA-F]+", part):
            value |= int(part, 16)
        else:
            names.append(part)
            if bits is not None:
                if part not in bits:
                    raise LcrError(f"unknown flag {part}")
                value |= bits[part]
    return value if bits is not None else names


def parse_targets_debug(text: str, bits: dict[str, int]) -> dict:
    """`Targets { browsers: Some(Browsers {..}), include: Features(..), exclude: Features(..) }`."""
    if text is None:
        return {"targets": None, "include": 0, "exclude": 0}
    browsers = parse_browsers_debug(text)
    include = re.search(r"include: (Features\([^)]*\))", text)
    exclude = re.search(r"exclude: (Features\([^)]*\))", text)
    return {
        "targets": browsers,
        "include": parse_flags_debug(include.group(1), bits) if include else 0,
        "exclude": parse_flags_debug(exclude.group(1), bits) if exclude else 0,
    }
