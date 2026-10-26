"""Spec data from W3C webref (@webref/css in the analysis image).

- spec_cards(run_dir): grammar/initial/inherited/computed-value cards for the properties a PR
  touches (by handler file and by WPT deltas), rendered as a report appendix.
- spec_coverage(tree): which webref properties, at-rules, selectors and functions LightningCSS
  parses at all (the "detect new CSS features" work stream from discussion #1241).
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from .common import SKILL_DIR, cache_dir, docker_run, log, read_json, read_jsonl, write_json
from .setup import ensure_browsers

MOUNT = "/opt/lcr/oracle"


def _node(args: list[str], work: Path) -> None:
    tag = ensure_browsers("latest")
    docker_run(tag, ["node", f"{MOUNT}/spec-cards.mjs", *args], mounts=[(SKILL_DIR / "oracle", MOUNT, "ro"), (work, "/work", "rw")], timeout=600)


def touched_properties(run_dir: Path, limit: int = 40) -> list[str]:
    prep = read_json(run_dir / "prepare.json") or {}
    props = read_json(SKILL_DIR / "config" / "properties.json", []) or []
    changed = set(prep.get("files", {}))
    # Properties whose WPT cases changed come first (the PR demonstrably affects them), then the
    # properties owned by the changed handler files.
    cases = {c["id"]: c for c in read_jsonl(run_dir / "corpus" / "cases.jsonl")}
    names: list[str] = []
    for d in read_jsonl(run_dir / "corpus" / "deltas.jsonl"):
        w = (cases.get(d["id"]) or {}).get("wpt")
        if w and w["property"] not in names:
            names.append(w["property"])
    for name in sorted({p["name"] for p in props if p.get("file") in changed}):
        if name not in names:
            names.append(name)
    return names[:limit]


def spec_cards(run_dir: Path) -> dict:
    names = touched_properties(run_dir)
    if not names:
        write_json(run_dir / "spec-cards.json", {"order": [], "cards": {}})
        return {}
    work = run_dir / "spec"
    work.mkdir(exist_ok=True)
    (work / "names.json").write_text(json.dumps(names))
    _node(["cards", "/work/names.json", "/work/cards.json"], work)
    cards = read_json(work / "cards.json", {}) or {}
    data = {"order": names, "cards": cards}  # write_json sorts keys; keep the priority order
    write_json(run_dir / "spec-cards.json", data)
    return data


def _strings(paths: list[Path]) -> set[str]:
    """String literals plus kebab-cased PascalCase identifiers (enum variants such as
    `TopLeftCorner` -> `top-left-corner`, which the derive macros parse by kebab name)."""
    out: set[str] = set()
    for p in paths:
        text = p.read_text(errors="replace")
        out |= set(re.findall(r'"([a-z0-9-]+)"', text))
        for ident in re.findall(r"\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)*)\b", text):
            out.add(re.sub(r"(?<!^)(?=[A-Z])", "-", ident).lower())
    return out


def spec_coverage(tree: Path) -> Path:
    work = cache_dir() / "spec"
    work.mkdir(exist_ok=True)
    _node(["inventory", "/work/inventory.json"], work)
    inv = read_json(work / "inventory.json")
    mod = (tree / "src" / "properties" / "mod.rs").read_text()
    table = mod[mod.find("define_properties!"):]
    implemented_props = set(re.findall(r'^\s*"([a-z-]+)":', table, re.M))
    # special-cased ids outside the table (e.g. `"all" => return Ok(PropertyId::All)`)
    implemented_props |= set(re.findall(r'"([a-z-]+)" => return Ok\(PropertyId::', mod))
    parser_strings = _strings([tree / "src" / "parser.rs"] + sorted((tree / "src" / "rules").glob("*.rs")))
    selector_strings = _strings([tree / "src" / "selector.rs", tree / "selectors" / "parser.rs"])
    value_strings = _strings(sorted((tree / "src").rglob("*.rs")))
    rows = {"properties": [], "atrules": [], "selectors": [], "functions": []}
    for p in inv["properties"]:
        if p.get("legacyAliasOf"):
            continue
        rows["properties"].append((p["name"], p["name"] in implemented_props, p.get("href")))
    for a in inv["atrules"]:
        name = a["name"].lstrip("@")
        rows["atrules"].append((a["name"], name in parser_strings, a.get("href")))
    for s in inv["selectors"]:
        name = re.sub(r"^:+|\(\)$", "", s["name"])
        if not name or name in ("*",) or not re.match(r"^[a-z-]+$", name):
            continue
        rows["selectors"].append((s["name"], name in selector_strings, s.get("href")))
    for f in inv["functions"]:
        name = f.strip("<>").removesuffix("()")
        rows["functions"].append((f, name in value_strings, None))
    lines = ["# LightningCSS spec coverage (webref vs. parser)", "",
             f"Tree: `{tree}`. A name counts as implemented when LightningCSS has a typed property entry (properties) or the name appears as a string literal or kebab-cased enum variant in the relevant parser files (others). This is a heuristic inventory, not proof of support; unparsed pass-through is not counted.", ""]
    for kind, items in rows.items():
        missing = sorted([i for i in items if not i[1]])
        lines.append(f"## {kind}: {len(items) - len(missing)}/{len(items)} implemented, {len(missing)} missing")
        lines.append("")
        for name, _, href in missing:
            lines.append(f"- `{name}`" + (f" — {href}" if href else ""))
        lines.append("")
    out = work / "coverage.md"
    out.write_text("\n".join(lines))
    write_json(work / "coverage.json", {k: [{"name": n, "implemented": ok, "href": h} for n, ok, h in v] for k, v in rows.items()})
    log(f"spec coverage: " + ", ".join(f"{k} {sum(1 for i in v if i[1])}/{len(v)}" for k, v in rows.items()))
    return out
