"""Print one case with its outputs and verdicts (for the agent's manual inspection)."""
from __future__ import annotations

import json
from pathlib import Path

from .common import LcrError, read_json, read_jsonl


def show(run_dir: Path, case_id: str) -> None:
    cases = {c["id"]: c for c in read_jsonl(run_dir / "corpus" / "cases.jsonl")}
    matches = [cid for cid in cases if cid == case_id or cid.startswith(case_id)]
    if not matches:
        raise LcrError(f"no case {case_id}")
    cid = sorted(matches)[0]
    case = cases[cid]
    base = {r["id"]: r for r in read_jsonl(run_dir / "corpus" / "outputs-base.jsonl")}.get(cid, {})
    head = {r["id"]: r for r in read_jsonl(run_dir / "corpus" / "outputs-head.jsonl")}.get(cid, {})
    oracle = (read_json(run_dir / "oracle.json") or {}).get("verdicts", {}).get(cid, [])
    print(f"== {cid} ({case['source']})")
    print(json.dumps({k: v for k, v in case.items() if k not in ("request",)}, indent=2, ensure_ascii=False)[:4000])
    req = case["request"]
    print("== request options:", json.dumps({k: v for k, v in req.items() if k not in ("css",)}, ensure_ascii=False))
    src = req.get("css") or f"{req.get('property')}: {req.get('value')}"
    print("== input:\n" + (src if len(src) <= 3000 else src[:3000] + f"\n… ({len(src)} bytes total)"))
    big = len(base.get("code") or "") > 3000 or len(head.get("code") or "") > 3000
    if big and base.get("ok") and head.get("ok"):
        # Large outputs (real-world sheets): show which rules changed, pretty-printed by the head
        # build with parse+print only, as a bounded unified diff.
        import difflib

        from .adapter import run_requests

        # each side pretty-printed by its own build (see oracle.focus_css)
        req = lambda rid, css: {"id": rid, "kind": "sheet", "css": css, "minify": False, "compact": False, "targets": None, "error_recovery": True}
        pretty = {
            **run_requests(run_dir / "bin" / "base-adapter", [req("base", base["code"])], workers=1),
            **run_requests(run_dir / "bin" / "head-adapter", [req("head", head["code"])], workers=1),
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
    for v in oracle:
        print(f"== oracle ({v.get('scheme')}): " + json.dumps(v["summary"], ensure_ascii=False))
        for engine, e in sorted(v.get("latest", {}).items()):
            print(f"-- {engine} {e.get('version')}: " + json.dumps(e.get("variants", e), ensure_ascii=False)[:3000])
        for prof, engines in sorted(v.get("legacy", {}).items()):
            for engine, e in sorted(engines.items()):
                print(f"-- {prof}/{engine} {e.get('version')}: " + json.dumps(e.get("variants", e), ensure_ascii=False)[:2000])
