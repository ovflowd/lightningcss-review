"""Test tuples recorded from the LightningCSS test helpers, mapped to adapter requests.

Each helper call (e.g. `prefix_test(source, expected, targets)`) becomes one tuple. Mapping a tuple
to adapter requests reproduces exactly what the helper does, so the *head* expectations can be
evaluated with the *base* build (and vice versa) without compiling one side's tests against the
other side's code. `property_range_test` expands into one request per (property, case).
"""
from __future__ import annotations

import re
from pathlib import Path

from .common import read_jsonl, stable_id
from .targets import parse_browsers_debug, parse_flags_debug, parse_targets_debug

CHROME_95 = {"chrome": 95 << 16}

# helper -> how the helper drives LightningCSS (see references/test-helpers in tests-tooling research)
HELPERS = {
    "test_with_options": {"minify": True, "compact": False, "targets": None},
    "test_with_printer_options": {"minify": True, "compact": "options.minify", "targets": None, "printer_targets": "options.targets"},
    "minify_test_with_options_and_browsers": {"minify": True, "compact": True, "targets": "browsers"},
    "prefix_test": {"minify": True, "compact": False, "targets": "targets"},
    "attr_test": {"kind": "attr", "minify": True, "compact": "minify", "targets": "targets"},
    "nesting_test_with_targets": {"minify": True, "compact": False, "targets": "targets:Targets"},
    "nesting_test_no_targets": {"minify": True, "compact": False, "targets": None},
    "custom_media_test": {"minify": True, "compact": False, "targets": CHROME_95, "printer_targets": None, "flags": ["custom-media"]},
    "css_modules_test": {"minify": True, "compact": "minify", "targets": None, "css_modules": "config"},
    "error_test": {"expect_error": "parse"},
    "error_test_with_options": {"expect_error": "parse"},
    "css_modules_error_test": {"expect_error": "parse", "css_modules": "default"},
    "minify_error_test_with_options": {"expect_error": "minify"},
    "error_recovery_test": {"minify": False, "compact": False, "targets": None, "error_recovery": True, "warnings_only": True},
    "property_range_test": {"expand": "range"},
}

PARSER_FLAG_NAMES = {"NESTING": "nesting", "CUSTOM_MEDIA": "custom-media", "DEEP_SELECTOR_COMBINATOR": "deep-selector-combinator", "SCROLL_NAVIGATION_CONTROLS": "scroll-navigation-controls"}
RUST_STR = r'"((?:[^"\\]|\\.)*)"'


def rust_unescape(s: str) -> str:
    out, i = [], 0
    while i < len(s):
        c = s[i]
        if c != "\\":
            out.append(c)
            i += 1
            continue
        nxt = s[i + 1] if i + 1 < len(s) else ""
        if nxt == "u" and s[i + 2 : i + 3] == "{":
            end = s.index("}", i)
            out.append(chr(int(s[i + 3 : end], 16)))
            i = end + 1
            continue
        out.append({"n": "\n", "t": "\t", "r": "\r", "0": "\0", "\\": "\\", '"': '"', "'": "'"}.get(nxt, nxt))
        i += 2
    return "".join(out)


def parse_css_modules_debug(text: str):
    """`Some(Config { pattern: Pattern { segments: [...] }, dashed_idents: false, ... })`."""
    if not text or text.strip() in ("None",):
        return None
    cfg = {}
    for key in ("dashed_idents", "animation", "grid", "custom_idents", "container", "pure"):
        m = re.search(rf"\b{key}: (true|false)", text)
        if m:
            cfg[key] = m.group(1) == "true"
    m = re.search(r"segments: \[(.*?)\]\s*\}", text, re.S)
    if m:
        parts = []
        for seg in re.finditer(r'Literal\(' + RUST_STR + r'\)|\b(Name|Local|Hash|ContentHash)\b', m.group(1)):
            if seg.group(1) is not None:
                parts.append(rust_unescape(seg.group(1)))
            else:
                parts.append({"Name": "[name]", "Local": "[local]", "Hash": "[hash]", "ContentHash": "[content-hash]"}[seg.group(2)])
        pattern = "".join(parts)
        if pattern and pattern != "[hash]_[local]":
            cfg["pattern"] = pattern
    return cfg


def tuple_identity(t: dict) -> str:
    return stable_id(t["helper"], t["fields"])


def load_tuples(path: Path) -> dict[str, dict]:
    """identity -> tuple (first occurrence; duplicates are counted)."""
    out: dict[str, dict] = {}
    for row in read_jsonl(path):
        ident = tuple_identity(row)
        if ident in out:
            out[ident]["count"] += 1
            continue
        out[ident] = {**row, "identity": ident, "count": 1}
    return out


def _range_requests(f: dict) -> list[tuple[str, dict, dict]] | None:
    names = [rust_unescape(n) for n in re.findall(RUST_STR, f.get("names") or "")]
    cases = re.findall(r"\(" + RUST_STR + r", (None|Some\(" + RUST_STR + r"\))\)", f.get("cases") or "")
    if not names or not cases:
        return None
    out = []
    for name in names:
        for value, opt, expected in cases:
            req = {"kind": "value", "property": name, "value": rust_unescape(value), "compact": True}
            exp = {"type": "value", "code": rust_unescape(expected)} if opt != "None" else {"type": "value-unparsed"}
            out.append((stable_id(name, value), req, exp))
    return out


def to_requests(t: dict, bits: dict[str, int]) -> list[tuple[str, dict, dict]] | None:
    """[(suffix, adapter request, expectation)] reproducing the helper, or None if not mappable."""
    spec = HELPERS.get(t["helper"])
    if not spec:
        return None
    f = t["fields"]
    if spec.get("expand") == "range":
        return _range_requests(f)
    if "source" not in f:
        return None
    req: dict = {"kind": spec.get("kind", "sheet"), "css": f["source"]}
    if "expect_error" in spec:
        req.update({"minify": spec["expect_error"] == "minify", "compact": False, "targets": None})
        exp = {"type": "error", "stage": spec["expect_error"], "error": f.get("error")}
    else:
        req["minify"] = spec["minify"]
        c = spec["compact"]
        if c == "options.minify":
            req["compact"] = bool((f.get("options") or {}).get("minify"))
        elif isinstance(c, str):
            req["compact"] = bool(f.get(c))
        else:
            req["compact"] = bool(c)
        tgt = spec["targets"]
        if tgt is None:
            req["targets"] = None
        elif isinstance(tgt, dict):
            req["targets"] = tgt
        elif tgt == "targets:Targets":
            parsed = parse_targets_debug(f.get("targets"), bits)
            req["targets"] = parsed["targets"]
            if parsed["include"]:
                req["include"] = parsed["include"]
            if parsed["exclude"]:
                req["exclude"] = parsed["exclude"]
        else:
            req["targets"] = parse_browsers_debug(f.get(tgt))
        if "printer_targets" in spec:
            pt = spec["printer_targets"]
            if pt is None:
                req["printer_targets"] = None
            else:
                parsed = parse_targets_debug((f.get("options") or {}).get("targets"), bits)
                req["printer_targets"] = {"browsers": parsed["targets"], "include": parsed["include"], "exclude": parsed["exclude"]}
        exp = {"type": "warnings"} if spec.get("warnings_only") else {"type": "code", "code": f.get("expected")}
    flags = list(spec.get("flags", []))
    opts = f.get("options") if isinstance(f.get("options"), dict) else None
    if opts and "flags" in opts:
        for name in parse_flags_debug(opts["flags"]):
            if name in PARSER_FLAG_NAMES:
                flags.append(PARSER_FLAG_NAMES[name])
            else:
                return None
    if flags:
        req["flags"] = sorted(set(flags))
    if opts:
        if opts.get("error_recovery"):
            req["error_recovery"] = True
        cm = parse_css_modules_debug(opts.get("css_modules"))
        if cm is not None:
            req["css_modules"] = cm
        if "filename" in opts:
            req["filename"] = opts["filename"]
    if spec.get("error_recovery"):
        req["error_recovery"] = True
    if spec.get("css_modules") == "config":
        cm = parse_css_modules_debug(f.get("config"))
        req["css_modules"] = cm if cm is not None else {}
        req["filename"] = "test.css"
    elif spec.get("css_modules") == "default":
        req["css_modules"] = {}
    return [("", req, exp)]


def matches_expectation(exp: dict, resp: dict) -> bool | None:
    if exp["type"] == "code":
        return bool(resp.get("ok")) and resp.get("code") == exp["code"]
    if exp["type"] == "value":
        return bool(resp.get("ok")) and resp.get("recognition") not in ("unparsed", "custom") and resp.get("code") == exp["code"]
    if exp["type"] == "value-unparsed":
        return bool(resp.get("ok")) and resp.get("recognition") == "unparsed"
    if exp["type"] == "error":
        if resp.get("ok") or resp.get("stage") != exp["stage"]:
            return False
        want = (exp.get("error") or "").split("(", 1)[0].strip()
        return want in (resp.get("error") or "") if want else True
    return None
