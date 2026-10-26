"""Inject the review adapter and a test-tuple recorder into a throwaway LightningCSS source tree.

The recorder makes every leaf test helper in `src/lib.rs` (`minify_test_with_options_and_browsers`,
`prefix_test`, `attr_test`, `nesting_test_with_targets`, ...) append one JSON line per call to
`$LCR_DUMP`: the calling test, the call-site line (via #[track_caller]), and the helper's
arguments. All edits stay on existing lines, so line numbers in the dump match the pristine file.
Nothing here is ever committed; the trees live under the run directory.
"""
from __future__ import annotations

import re
import shutil
from dataclasses import dataclass
from pathlib import Path

from .common import SKILL_DIR, LcrError

# Calls that mark a helper as a "leaf" (it does the real parse/minify/print work).
LEAF_MARKERS = (
    "StyleSheet::parse",
    "StyleAttribute::parse",
    "Property::parse_string",
    "::parse_string(",
)

DUMP_MODULE = (
    '#[allow(dead_code, unused)] pub(crate) mod lcr_dump { use std::io::Write; '
    'static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(()); '
    '#[track_caller] pub(crate) fn dump(helper: &str, fields: serde_json::Value) { '
    'let path = match std::env::var("LCR_DUMP") { Ok(p) => p, Err(_) => return }; '
    'let loc = std::panic::Location::caller(); '
    'let test = std::thread::current().name().unwrap_or("").to_string(); '
    'let record = serde_json::json!({"test": test, "helper": helper, "file": loc.file(), "line": loc.line(), "fields": fields}); '
    'let mut text = record.to_string(); text.push(\'\\n\'); '
    'let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner()); '
    'if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) { let _ = f.write_all(text.as_bytes()); } } } '
)


@dataclass
class Helper:
    name: str
    fn_start: int  # offset of `fn`
    params: list[tuple[str, str]]
    body_open: int  # offset of `{`
    body_close: int
    attrs_start: int  # offset of the first attribute line belonging to this fn
    has_track_caller: bool
    is_test: bool


class RustScanner:
    """Finds structure in Rust source while skipping strings, chars and comments."""

    def __init__(self, text: str):
        self.text = text
        self.n = len(text)

    def skip_literal(self, i: int) -> int:
        """If a string/char/comment starts at i, return the offset after it; else i."""
        t = self.text
        c = t[i]
        if t.startswith("//", i):
            j = t.find("\n", i)
            return self.n if j < 0 else j
        if t.startswith("/*", i):
            depth, j = 1, i + 2
            while j < self.n and depth:
                if t.startswith("/*", j):
                    depth, j = depth + 1, j + 2
                elif t.startswith("*/", j):
                    depth, j = depth - 1, j + 2
                else:
                    j += 1
            return j
        m = re.compile(r'b?r(#*)"').match(t, i)
        if m and (i == 0 or not (t[i - 1].isalnum() or t[i - 1] == "_")):
            end = '"' + m.group(1)
            j = t.find(end, m.end())
            if j < 0:
                raise LcrError("unterminated raw string in src/lib.rs")
            return j + len(end)
        if c == '"' or (c == "b" and t.startswith('b"', i) and not (t[i - 1].isalnum() or t[i - 1] == "_")):
            j = i + (2 if c == "b" else 1)
            while j < self.n:
                if t[j] == "\\":
                    j += 2
                elif t[j] == '"':
                    return j + 1
                else:
                    j += 1
            raise LcrError("unterminated string in src/lib.rs")
        if c == "'":
            # char literal ('a', '\n', '\u{1F600}', '\'') vs lifetime ('a)
            m = re.compile(r"'(\\u\{[0-9a-fA-F]+\}|\\.|[^\\'])'").match(t, i)
            if m:
                return m.end()
            return i + 1
        return i

    def match_brace(self, open_at: int, open_ch="{", close_ch="}") -> int:
        depth, i = 0, open_at
        while i < self.n:
            j = self.skip_literal(i)
            if j != i:
                i = j
                continue
            ch = self.text[i]
            if ch == open_ch:
                depth += 1
            elif ch == close_ch:
                depth -= 1
                if depth == 0:
                    return i
            i += 1
        raise LcrError(f"unbalanced {open_ch}{close_ch} in src/lib.rs")

    def find_code(self, pattern: re.Pattern, start: int, end: int):
        """Yield regex matches that start in code (not in strings/comments) between start and end."""
        i = start
        while i < end:
            j = self.skip_literal(i)
            if j != i:
                i = j
                continue
            m = pattern.match(self.text, i)
            if m:
                yield m
                i = m.end()
            else:
                i += 1


def split_params(text: str) -> list[tuple[str, str]]:
    params, depth, cur = [], 0, ""
    for ch in text:
        if ch in "<([":
            depth += 1
        elif ch in ">)]":
            depth -= 1
        if ch == "," and depth == 0:
            params.append(cur)
            cur = ""
        else:
            cur += ch
    if cur.strip():
        params.append(cur)
    out = []
    for p in params:
        p = p.strip()
        if not p or ":" not in p:
            continue
        name, ty = p.split(":", 1)
        name = name.strip().removeprefix("mut ").strip()
        out.append((name, " ".join(ty.split())))
    return out


def field_expr(name: str, ty: str) -> str | None:
    t = ty.replace(" ", "")
    if re.fullmatch(r"&('\w+)?str", t) or re.fullmatch(r"Option<&('\w+)?str>", t) or t in ("bool", "u32", "usize", "i32"):
        return f'"{name}": {name}'
    if t in ("Browsers", "Option<Browsers>", "Targets", "crate::targets::Targets", "Option<Targets>"):
        return f'"{name}": format!("{{:?}}", {name})'
    if t.startswith("ParserOptions"):
        return (
            f'"{name}": serde_json::json!({{"flags": format!("{{:?}}", {name}.flags), '
            f'"css_modules": format!("{{:?}}", {name}.css_modules), "error_recovery": {name}.error_recovery, '
            f'"filename": {name}.filename.clone()}})'
        )
    if t.startswith("PrinterOptions"):
        return f'"{name}": serde_json::json!({{"minify": {name}.minify, "targets": format!("{{:?}}", {name}.targets)}})'
    if t.endswith("css_modules::Config") or t == "Config" or t.startswith("ParserError") or t in ("MinifyErrorKind",):
        return f'"{name}": format!("{{:?}}", {name})'
    if t.startswith("&["):
        return f'"{name}": format!("{{:?}}", {name})'
    return None


def find_helpers(text: str) -> tuple[int, int, list[Helper]]:
    sc = RustScanner(text)
    m = re.search(r"^#\[cfg\(test\)\]\s*\nmod tests \{", text, re.M)
    if not m:
        raise LcrError("could not find `#[cfg(test)] mod tests {` in src/lib.rs")
    mod_open = m.end() - 1
    mod_close = sc.match_brace(mod_open)
    helpers = []
    fn_re = re.compile(r"fn\s+([a-z_][a-z0-9_]*)\s*(<[^{(]*>)?\s*\(")
    # Only direct children of `mod tests`: walk top-level items inside the module.
    i = mod_open + 1
    depth_items = []
    while i < mod_close:
        j = sc.skip_literal(i)
        if j != i:
            i = j
            continue
        ch = text[i]
        if ch == "{":
            # a nested item body we are not interested in (impl, mod, fn body handled below)
            i = sc.match_brace(i) + 1
            continue
        fm = fn_re.match(text, i)
        if fm and (i == 0 or not (text[i - 1].isalnum() or text[i - 1] == "_")):
            paren_open = fm.end() - 1
            paren_close = sc.match_brace(paren_open, "(", ")")
            params = split_params(text[paren_open + 1 : paren_close])
            body_open = text.index("{", paren_close)
            body_close = sc.match_brace(body_open)
            line_start = text.rfind("\n", 0, i) + 1
            # attributes: contiguous lines above starting with #[
            attrs_start = line_start
            k = line_start
            while True:
                prev_end = k - 1
                if prev_end <= mod_open:
                    break
                prev_start = text.rfind("\n", 0, prev_end) + 1
                line = text[prev_start:prev_end].strip()
                if line.startswith("#["):
                    attrs_start = prev_start
                    k = prev_start
                else:
                    break
            attrs = text[attrs_start:line_start]
            helpers.append(
                Helper(
                    name=fm.group(1),
                    fn_start=i,
                    params=params,
                    body_open=body_open,
                    body_close=body_close,
                    attrs_start=attrs_start,
                    has_track_caller="#[track_caller]" in attrs or "#[track_caller]" in text[line_start:i],
                    is_test="#[test]" in attrs,
                )
            )
            i = body_close + 1
            continue
        i += 1
    return mod_open, mod_close, helpers


def inject_dump(src_root: Path) -> dict:
    lib = src_root / "src" / "lib.rs"
    text = lib.read_text()
    mod_open, _mod_close, helpers = find_helpers(text)
    leafs = []
    for h in helpers:
        if h.is_test:
            continue
        body = text[h.body_open : h.body_close]
        if not any(marker in body for marker in LEAF_MARKERS):
            continue
        fields = [f for f in (field_expr(n, t) for n, t in h.params) if f]
        skipped = [n for n, t in h.params if not field_expr(n, t)]
        leafs.append((h, fields, skipped))
    if not leafs:
        raise LcrError("no leaf test helpers found in src/lib.rs (helper layout changed?)")
    # Apply edits from the end so offsets stay valid. Every edit keeps the line count unchanged.
    edits = []
    for h, fields, _ in leafs:
        call = f' {{ crate::tests::lcr_dump::dump("{h.name}", serde_json::json!({{{", ".join(fields)}}})); }}'
        edits.append((h.body_open + 1, call))
        if not h.has_track_caller:
            edits.append((h.fn_start, "#[track_caller] "))
    edits.append((mod_open + 1, " " + DUMP_MODULE))
    for offset, insert in sorted(edits, key=lambda e: e[0], reverse=True):
        text = text[:offset] + insert + text[offset:]
    if text.count("\n") != lib.read_text().count("\n"):
        raise LcrError("internal: dump injection changed the line count")
    lib.write_text(text)
    return {
        "helpers": [
            {"name": h.name, "fields": [f.split(":", 1)[0].strip('"') for f in fields], "skipped": skipped}
            for h, fields, skipped in leafs
        ]
    }


def inject_adapter(src_root: Path) -> None:
    examples = src_root / "examples"
    examples.mkdir(exist_ok=True)
    shutil.copyfile(SKILL_DIR / "adapter" / "lcr_adapter.rs", examples / "lcr_adapter.rs")
    cargo = src_root / "Cargo.toml"
    text = cargo.read_text()
    if re.search(r"^autoexamples\s*=\s*false", text, re.M):
        raise LcrError("Cargo.toml disables autoexamples; add an [[example]] entry for lcr_adapter")
