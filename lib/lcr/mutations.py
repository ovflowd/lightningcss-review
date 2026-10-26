"""Metamorphic variants of the PR's own test inputs (deterministic edge cases).

A mutation does not have to preserve the meaning of the original input: the oracle compares each
mutated input with its own output. Mutations encode the habits in Devon's tests: both declaration
orders, typed vs var() values, !important, prefixed siblings, nesting, conditional/layer wrapping,
non-adjacent duplicates, different targets.
"""
from __future__ import annotations

import re

from .common import load_config, read_json, SKILL_DIR
from .targets import parse_targets

MUTATIONS = (
    "reverse-decls",
    "important",
    "var-before",
    "var-after",
    "prefixed-sibling",
    "wrap-media",
    "wrap-layer",
    "wrap-supports",
    "nest",
    "duplicate-nonadjacent",
    "upper-props",
    "retarget-none",
    "retarget-modern",
    "retarget-legacy",
)


def _scan_block(css: str, i: int) -> int:
    """Index just past the `}` matching the `{` at css[i], or -1 if the block never closes."""
    depth = 0
    n = len(css)
    while i < n:
        c = css[i]
        if c in "\"'":
            q = c
            i += 1
            while i < n and css[i] != q:
                i += 2 if css[i] == "\\" else 1
        elif css.startswith("/*", i):
            j = css.find("*/", i + 2)
            i = n if j < 0 else j + 1
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return -1


def split_top(css: str) -> list[dict] | None:
    """Top-level items: {'kind': 'rule'|'at-block'|'at-stmt', 'prelude', 'body'} or None if unparseable."""
    items, i, n = [], 0, len(css)
    while i < n:
        while i < n and css[i] in " \t\r\n":
            i += 1
        if i >= n:
            break
        if css.startswith("/*", i):
            j = css.find("*/", i + 2)
            if j < 0:
                return None
            i = j + 2
            continue
        start = i
        depth = 0
        while i < n:
            c = css[i]
            if c in "\"'":
                q = c
                i += 1
                while i < n and css[i] != q:
                    i += 2 if css[i] == "\\" else 1
            elif css.startswith("/*", i):
                j = css.find("*/", i + 2)
                i = n if j < 0 else j + 1
            elif c in "([":
                depth += 1
            elif c in ")]":
                depth -= 1
            elif depth == 0 and c == ";" and css[start] == "@":
                items.append({"kind": "at-stmt", "prelude": css[start:i].strip(), "body": None})
                i += 1
                break
            elif depth == 0 and c == "{":
                end = _scan_block(css, i)
                if end < 0:
                    return None
                prelude = css[start:i].strip()
                body = css[i + 1 : end - 1]
                items.append({"kind": "at-block" if prelude.startswith("@") else "rule", "prelude": prelude, "body": body})
                i = end
                break
            elif depth == 0 and c == "}":
                return None
            i += 1
        else:
            if css[start:].strip():
                return None
    return items


def split_decls(body: str) -> list[str] | None:
    """Declarations of a flat block, or None if the block nests rules."""
    out, cur, depth, i, n = [], "", 0, 0, len(body)
    while i < n:
        c = body[i]
        if c in "\"'":
            q = c
            j = i + 1
            while j < n and body[j] != q:
                j += 2 if body[j] == "\\" else 1
            cur += body[i : j + 1]
            i = j + 1
            continue
        if body.startswith("/*", i):
            j = body.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        if c in "([":
            depth += 1
        elif c in ")]":
            depth -= 1
        elif c in "{}" and depth == 0:
            return None
        if c == ";" and depth == 0:
            if cur.strip():
                out.append(cur.strip())
            cur = ""
        else:
            cur += c
        i += 1
    if cur.strip():
        out.append(cur.strip())
    if any(":" not in d for d in out):
        return None
    return out


def join(items: list[dict]) -> str:
    parts = []
    for it in items:
        if it["kind"] == "at-stmt":
            parts.append(it["prelude"] + ";")
        else:
            parts.append(f"{it['prelude']} {{ {it['body'].strip()} }}")
    return "\n".join(parts) + "\n"


def prop_of(decl: str) -> tuple[str, str, bool]:
    name, value = decl.split(":", 1)
    value = value.strip()
    important = bool(re.search(r"!\s*important\s*$", value, re.I))
    if important:
        value = re.sub(r"\s*!\s*important\s*$", "", value, flags=re.I)
    return name.strip(), value, important


def prefixed_props() -> dict[str, list[str]]:
    data = read_json(SKILL_DIR / "config" / "properties.json", []) or []
    return {p["name"]: p.get("prefixes") or [] for p in data}


def mutate(css: str, mutation: str) -> str | None:
    items = split_top(css)
    if not items:
        return None
    blocked = any(it["kind"] == "at-stmt" and re.match(r"@(import|charset|namespace|layer)\b", it["prelude"], re.I) for it in items)
    rules = [it for it in items if it["kind"] == "rule"]
    if mutation in ("wrap-media", "wrap-layer", "wrap-supports"):
        if blocked:
            return None
        head = {"wrap-media": "@media (min-width: 0px)", "wrap-layer": "@layer lcr", "wrap-supports": "@supports (display: block)"}[mutation]
        return f"{head} {{\n{join(items)}}}\n"
    if mutation == "nest":
        if not rules:
            return None
        out = []
        for it in items:
            if it["kind"] == "rule" and not it["prelude"].lstrip().startswith(("&", ":root", "html", "body")):
                out.append({"kind": "rule", "prelude": ".lcr-n", "body": f"{it['prelude']} {{ {it['body'].strip()} }}"})
            else:
                out.append(it)
        return join(out)
    if mutation == "duplicate-nonadjacent":
        if not rules:
            return None
        return join(items + [{"kind": "rule", "prelude": ".lcr-sep", "body": "color: inherit"}, dict(rules[0])])
    changed = False
    prefixes = prefixed_props() if mutation == "prefixed-sibling" else {}
    out = []
    for it in items:
        if it["kind"] != "rule":
            out.append(it)
            continue
        decls = split_decls(it["body"])
        if decls is None or not decls:
            out.append(it)
            continue
        new = None
        if mutation == "reverse-decls" and len(decls) > 1:
            new = list(reversed(decls))
        elif mutation == "important":
            new = [d if re.search(r"!\s*important\s*$", d, re.I) else d + " !important" for d in decls]
        elif mutation in ("var-before", "var-after"):
            new = []
            for d in decls:
                name, value, imp = prop_of(d)
                if name.startswith("--") or not value:
                    new.append(d)
                    continue
                extra = f"{name}: var(--lcr-unset, {value}){' !important' if imp else ''}"
                new += [extra, d] if mutation == "var-before" else [d, extra]
        elif mutation == "prefixed-sibling":
            new = []
            for d in decls:
                name, value, imp = prop_of(d)
                pfx = prefixes.get(name) or []
                webkit = next((p for p in pfx if p.lower() in ("webkit", "-webkit-")), None)
                if webkit:
                    new.append(f"-webkit-{name}: {value}{' !important' if imp else ''}")
                new.append(d)
        elif mutation == "upper-props":
            new = []
            for d in decls:
                name, rest = d.split(":", 1)
                new.append((name if name.strip().startswith("--") else name.upper()) + ":" + rest)
        if new is not None and new != decls:
            changed = True
            out.append({**it, "body": "; ".join(new)})
        else:
            out.append(it)
    return join(out) if changed else None


def engine_targets() -> dict[str, dict]:
    """`engine-<profile>` retargets: exactly the versions of each installed legacy engine set, so the
    lowering for that engine is exercised and then rendered by that engine (wpt-engines §3.3)."""
    from .common import cache_dir

    env = read_json(cache_dir() / "env.json", {}) or {}
    out = {}
    for name, prof in sorted((env.get("profiles") or {}).items()):
        if prof.get("role") != "legacy":
            continue
        v = prof.get("versions") or {}
        t = {}
        for engine, key in (("chromium", "chrome"), ("firefox", "firefox"), ("webkit", "safari")):
            m = re.match(r"(\d+)(?:\.(\d+))?(?:\.(\d+))?", str(v.get(engine, "")))
            if m:
                t[key] = (int(m.group(1)) << 16) | (int(m.group(2) or 0) << 8) | min(int(m.group(3) or 0), 255)
        if t:
            out[f"engine-{name}"] = dict(sorted(t.items()))
    return out


def mutation_cases(parents: list[dict], limit: int = 60) -> list[dict]:
    """parents: corpus cases (tuple/probe) with request.kind == 'sheet'."""
    modes = load_config("modes.json")
    retargets = {"retarget-none": None, "retarget-modern": parse_targets(modes["targets"]["modern"]), "retarget-legacy": parse_targets(modes["targets"]["legacy-2020"])}
    retargets.update(engine_targets())
    out = []
    for parent in sorted(parents, key=lambda c: c["id"])[:limit]:
        req = parent["request"]
        if req.get("kind") != "sheet" or req.get("css_modules") or not req.get("css"):
            continue
        for m in list(MUTATIONS) + [k for k in retargets if k.startswith("engine-")]:
            new_req = dict(req)
            if m.startswith(("retarget-", "engine-")):
                if not req.get("minify"):
                    continue
                t = retargets[m]
                if t == req.get("targets"):
                    continue
                new_req["targets"] = t
                new_req.pop("printer_targets", None)
                new_req.pop("include", None)
                new_req.pop("exclude", None)
            else:
                css = mutate(req["css"], m)
                if not css or css == req["css"]:
                    continue
                new_req["css"] = css
            out.append({
                "id": f"m-{parent['id']}-{m}",
                "source": "mutation",
                "mutation": m,
                "parent": parent["id"],
                "area": parent.get("area") or (parent.get("probe") or {}).get("area"),
                "request": new_req,
            })
    return out
