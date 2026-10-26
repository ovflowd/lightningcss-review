"""Inspect cases: `lcr show` prints one case (input, base/head output, per-engine oracle diffs) and
`lcr table` one line per oracle case. Both read the run files line by line, so they stay fast on
large runs."""
from __future__ import annotations

import fnmatch
import json
from pathlib import Path

from .common import LcrError, read_json, read_jsonl

ENGINE_ABBR = {"chromium": "C", "firefox": "F", "webkit": "W"}


def find_rows(path: Path, key: str, value: str) -> list[dict]:
    """Rows of a JSONL file whose `key` equals `value` (substring prefilter before parsing)."""
    if not path.exists():
        return []
    needle = f'"{key}": {json.dumps(value, ensure_ascii=False)}'
    out = []
    with path.open() as f:
        for line in f:
            if needle in line:
                row = json.loads(line)
                if row.get(key) == value:
                    out.append(row)
    return out


def resolve_case(run_dir: Path, case_id: str) -> dict:
    path = run_dir / "corpus" / "cases.jsonl"
    exact = find_rows(path, "id", case_id)
    if exact:
        return exact[0]
    matches = sorted((c for c in read_jsonl(path) if c["id"].startswith(case_id)), key=lambda c: c["id"])
    if not matches:
        raise LcrError(f"no case {case_id}")
    return matches[0]


def case_verdicts(run_dir: Path, cid: str) -> list[dict]:
    rows = find_rows(run_dir / "oracle" / "verdicts.jsonl", "case", cid)
    if rows:
        return sorted(rows, key=lambda v: v.get("scheme") or "")
    return (read_json(run_dir / "oracle.json") or {}).get("verdicts", {}).get(cid, [])


def diff_rows(variants: dict) -> list[tuple[str, str, str, str, str]]:
    """(element, property, input, base, head) for every property either side computes differently
    from the input; `=` means that side matches the input."""
    merged: dict[tuple[str, str], dict] = {}
    for side in ("base", "head"):
        for d in (variants.get(side) or {}).get("diffs", []):
            row = merged.setdefault((d.get("key", ""), d.get("prop", "")), {"ref": d.get("ref")})
            row[side] = d.get("val")
    out = []
    for (key, prop), row in sorted(merged.items()):
        out.append((key, prop, str(row.get("ref")), str(row["base"]) if "base" in row else "=", str(row["head"]) if "head" in row else "="))
    return out


def engine_block(name: str, e: dict) -> list[str]:
    if e.get("skipped"):
        return [f"  {name} {e.get('version', '')}: skipped ({e['skipped']})"]
    if e.get("error"):
        return [f"  {name} {e.get('version', '')}: error {str(e['error'])[:300]}"]
    v = e.get("variants") or {}
    b, h = v.get("base") or {}, v.get("head") or {}
    rej = lambda s: sum(len(x) for x in (s.get("rejected") or {}).values())
    lines = [f"  {name} {e.get('version', '')}: base {b.get('status', '-')}, head {h.get('status', '-')}; touched {e.get('touched', '-')}; rejected base {rej(b)} head {rej(h)}"]
    for side, s in (("base", b), ("head", h)):
        for kind, items in sorted((s.get("rejected") or {}).items()):
            for item in items[:6]:
                lines.append(f"    rejected on {side} ({kind}): {str(item)[:200]}")
    rows = diff_rows(v)
    if rows:
        head = ("element", "property", "input", "base", "head")
        w = [min(40, max(len(r[i]) for r in rows + [head])) for i in range(4)]
        for r in [head] + rows[:40]:
            lines.append("    " + "  ".join(f"{c[:40]:<{w[i]}}" for i, c in enumerate(r[:4])) + "  " + r[4][:80])
        if len(rows) > 40:
            lines.append(f"    … {len(rows) - 40} more")
    return lines


def summary_line(s: dict) -> str:
    bad = lambda side: "".join(ENGINE_ABBR.get(e, e) for e in sorted((s.get(side) or {}).get("bad", []))) or "-"
    return (f"{s.get('transition')} (base {s.get('base')}, head {s.get('head')}; bad engines base {bad('enginesBase')} head {bad('enginesHead')}"
            + ("; divergent" if s.get("divergent") else "") + f"; rejected base {s.get('rejectedBase', 0)} head {s.get('rejectedHead', 0)})")


def case_meta(case: dict) -> dict:
    keep = ("source", "side", "origin", "parent", "mutation", "helper", "test", "line", "in_diff", "mode", "name", "area", "expectation", "dom")
    meta = {k: case[k] for k in keep if k in case}
    if case.get("probe"):
        meta["probe"] = {k: v for k, v in case["probe"].items() if v not in (None, [], "")}
    if case.get("wpt"):
        meta["wpt"] = case["wpt"]
    return meta


def show(run_dir: Path, case_id: str, as_json: bool = False) -> None:
    case = resolve_case(run_dir, case_id)
    cid = case["id"]
    base = (find_rows(run_dir / "corpus" / "outputs-base.jsonl", "id", cid) or [{}])[0]
    head = (find_rows(run_dir / "corpus" / "outputs-head.jsonl", "id", cid) or [{}])[0]
    verdicts = case_verdicts(run_dir, cid)
    if as_json:
        print(json.dumps({"case": case, "base": base, "head": head, "oracle": verdicts}, indent=2, sort_keys=True, ensure_ascii=False))
        return
    print(f"== {cid} ({case['source']})")
    print(json.dumps(case_meta(case), sort_keys=True, ensure_ascii=False))
    req = case["request"]
    print("== request options: " + json.dumps({k: v for k, v in req.items() if k not in ("css",)}, sort_keys=True, ensure_ascii=False))
    src = req.get("css") or f"{req.get('property')}: {req.get('value')}"
    print("== input:\n" + (src if len(src) <= 3000 else src[:3000] + f"\n… ({len(src)} bytes total; `lcr show --json` prints everything)"))
    big = len(base.get("code") or "") > 3000 or len(head.get("code") or "") > 3000
    if big and base.get("ok") and head.get("ok"):
        # Large outputs (real-world sheets): a bounded unified diff of both outputs, each side
        # pretty-printed by its own build (see oracle.focus_css).
        import difflib

        from .adapter import run_requests

        preq = lambda rid, css: {"id": rid, "kind": "sheet", "css": css, "minify": False, "compact": False, "targets": None, "error_recovery": True}
        pretty = {
            **run_requests(run_dir / "bin" / "base-adapter", [preq("base", base["code"])], workers=1),
            **run_requests(run_dir / "bin" / "head-adapter", [preq("head", head["code"])], workers=1),
        }
        a = (pretty["base"].get("code") or base["code"]).splitlines()
        b = (pretty["head"].get("code") or head["code"]).splitlines()
        diff = list(difflib.unified_diff(a, b, "base", "head", n=2, lineterm=""))
        print(f"== base {len(base['code'])} bytes, head {len(head['code'])} bytes; diff of pretty-printed outputs, each side printed by its own build ({len(diff)} lines, first 220):")
        print("\n".join(diff[:220]))
    else:
        for name, r in (("base", base), ("head", head)):
            print(f"== {name}: " + ("ok" if r.get("ok") else f"{r.get('stage')} error"))
            print(r.get("code") if r.get("ok") else r.get("error"))
    for v in verdicts:
        s = v.get("summary") or {}
        print(f"== oracle ({v.get('scheme')}) latest: {summary_line(s.get('latest') or {})}")
        for engine, e in sorted((v.get("latest") or {}).items()):
            print("\n".join(engine_block(engine, e)))
        for prof, engines in sorted((v.get("legacy") or {}).items()):
            print(f"-- {prof}: {summary_line((s.get('legacy') or {}).get(prof) or {})}")
            for engine, e in sorted(engines.items()):
                print("\n".join(engine_block(engine, e)))


def table_rows(verdicts: dict, transitions: set[str] | None = None, ids: set[str] | None = None, pattern: str | None = None) -> list[dict]:
    rows = []
    for cid in sorted(verdicts):
        if ids is not None and cid not in ids:
            continue
        if pattern and not fnmatch.fnmatchcase(cid, pattern):
            continue
        for v in sorted(verdicts[cid], key=lambda v: v.get("scheme") or ""):
            s = (v.get("summary") or {}).get("latest") or {}
            if transitions and s.get("transition") not in transitions:
                continue
            legacy = {p: ls.get("transition") for p, ls in sorted(((v.get("summary") or {}).get("legacy") or {}).items())}
            rows.append({
                "id": cid,
                "scheme": v.get("scheme"),
                "transition": s.get("transition"),
                "base": s.get("base"),
                "head": s.get("head"),
                "bad_base": sorted((s.get("enginesBase") or {}).get("bad", [])),
                "bad_head": sorted((s.get("enginesHead") or {}).get("bad", [])),
                "divergent": bool(s.get("divergent")),
                "legacy": legacy,
                "rejected": [s.get("rejectedBase", 0), s.get("rejectedHead", 0)],
            })
    return rows


def format_table(rows: list[dict]) -> str:
    if not rows:
        return "no matching cases"
    abbr = lambda engines: "".join(ENGINE_ABBR.get(e, e) for e in engines) or "-"
    cells = [("id", "scheme", "transition", "base", "head", "bad b/h", "div", "rej b/h", "legacy")]
    for r in rows:
        legacy = " ".join(f"{p.replace('legacy-', '')}:{t}" for p, t in r["legacy"].items()) or "-"
        cells.append((r["id"], r["scheme"] or "-", r["transition"] or "-", r["base"] or "-", r["head"] or "-", f"{abbr(r['bad_base'])}/{abbr(r['bad_head'])}", "yes" if r["divergent"] else "-", f"{r['rejected'][0]}/{r['rejected'][1]}", legacy))
    w = [max(len(str(c[i])) for c in cells) for i in range(len(cells[0]) - 1)]
    lines = ["  ".join(f"{str(c[i]):<{w[i]}}" for i in range(len(w))) + "  " + c[-1] for c in cells]
    counts: dict[str, int] = {}
    for r in rows:
        counts[r["transition"]] = counts.get(r["transition"], 0) + 1
    lines.append(f"{len(rows)} row(s): " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items(), key=lambda kv: str(kv[0]))))
    return "\n".join(lines)


def check_case_ids(run_dir: Path, check: str) -> set[str]:
    """Case ids a report check lists (from report.json; run `lcr report` first)."""
    rep = read_json(run_dir / "report.json")
    if not rep:
        raise LcrError("--check needs report.json; run `lcr report <run> --allow-incomplete` first")
    for ch in rep.get("checks", []):
        if ch["id"] == check:
            return {str(i).split(" ")[0].split("~")[0].split("@")[0] for i in ch.get("items", [])}
    raise LcrError(f"no check {check} in report.json")


def table(run_dir: Path, transition: str | None = None, check: str | None = None, pattern: str | None = None, as_json: bool = False) -> None:
    verdicts = (read_json(run_dir / "oracle.json") or {}).get("verdicts")
    if verdicts is None:
        raise LcrError("no oracle.json yet; run `lcr oracle <run>` first")
    transitions = {t for t in (transition or "").replace(",", " ").split() if t} or None
    ids = check_case_ids(run_dir, check) if check else None
    rows = table_rows(verdicts, transitions, ids, pattern)
    print(json.dumps(rows, indent=2, sort_keys=True, ensure_ascii=False) if as_json else format_table(rows))
