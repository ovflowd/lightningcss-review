"""Run status and the agent worklist (analysis.json skeleton with every slot the report requires)."""
from __future__ import annotations

import json
from pathlib import Path

from .common import read_json, read_jsonl, write_json


def status(run_dir: Path) -> None:
    rows = []
    for name, file in (("prepare", "prepare.json"), ("build", "build.json"), ("corpus", "corpus.json"), ("oracle", "oracle.json"), ("analysis", "analysis.json"), ("report", "report.json")):
        rows.append((name, (run_dir / file).exists()))
    for name, ok in rows:
        print(f"{name:9} {'done' if ok else '-'}")
    rep = read_json(run_dir / "report.json")
    if rep:
        print(f"verdict   {rep['verdict']} {rep['counts']}")


def worklist(run_dir: Path) -> dict:
    """Write analysis.json (keeping existing answers) and return the open slots."""
    from .report import evaluate, load_checklists

    ev = evaluate(run_dir)
    prep = ev["prep"]
    path = run_dir / "analysis.json"
    analysis = read_json(path) or {
        "schema": 1,
        "run_id": prep["run_id"],
        "intent": {"kind": "", "summary": "", "claims": [], "behind_flag": ""},
        "checklist": [],
        "deltas": [],
        "findings": [],
        "probes_written": [],
    }
    answered = {a["item"] for a in analysis["checklist"]}
    for it in load_checklists(prep.get("areas", [])):
        if it["item"] not in answered:
            analysis["checklist"].append({"item": it["item"], "answer": "", "evidence": "", "note": "", "_text": it["text"], "_severity": it["severity"], "_verify": it.get("verify", "")})
    have = {d["id"] for d in analysis["deltas"]}
    needs = []
    for ch in ev["checks"]:
        if ch["id"] in ("O1", "O3", "O4", "O5", "O6", "O7", "O8", "S1") and ch["status"] == "FAIL":
            for item in ch["items"]:
                cid = item.split(" ")[0].split("~")[0].split("@")[0]
                needs.append((cid, ch["id"]))
    for cid, check in needs:
        if cid not in have:
            analysis["deltas"].append({"id": cid, "classification": "", "reason": "", "_check": check})
            have.add(cid)
    write_json(path, analysis)
    open_items = {
        "checklist": [a["item"] for a in analysis["checklist"] if not a.get("answer")],
        "deltas": [d["id"] for d in analysis["deltas"] if not d.get("classification")],
        "linked_issues": [i["number"] for i in prep.get("linked_issues", [])],
        "intent": not analysis["intent"].get("summary"),
    }
    print(json.dumps(open_items, indent=2))
    return open_items


def brief(run_dir: Path) -> str:
    """Compact digest of a run for the reviewing agent (instead of reading the raw JSON files)."""
    prep = read_json(run_dir / "prepare.json") or {}
    build = read_json(run_dir / "build.json") or {}
    corpus = read_json(run_dir / "corpus.json") or {}
    oracle = read_json(run_dir / "oracle.json") or {}
    pr = prep.get("pr", {})
    out = [f"# {prep.get('run_id')}: #{pr.get('number')} {pr.get('title')} (@{pr.get('author')})", ""]
    if pr.get("body"):
        out += ["PR body:", pr["body"].strip()[:1200], ""]
    out.append(f"strategy: {prep.get('strategy')}; areas: {', '.join(prep.get('areas', []))}; radius adds: {', '.join(prep.get('radius_areas', [])) or '-'}")
    for path, info in sorted(prep.get("files", {}).items()):
        out.append(f"  {path} +{info['added']}/-{info['removed']}")
    items = sorted({f"{(i.get('impl') or {}).get('type') or '-'}::{(i.get('item') or {}).get('name') or '-'} ({i['file']})" for i in prep.get("changed_items", [])})
    if items:
        out.append("changed items: " + "; ".join(items[:15]))
    for f in prep.get("risk_flags", []):
        out.append(f"risk: {f['id']}: {f['detail']}")
    for i in prep.get("linked_issues", []):
        out.append(f"linked issue #{i['number']} ({i['state']}): {i['title']}  -> {run_dir}/issues/{i['number']}.json")
    for o in prep.get("overlapping_prs", [])[:5]:
        out.append(f"overlaps #{o['number']}: {o['title']} ({', '.join(o['shared_files'])})")
    for side in ("base", "head"):
        b = build.get(side)
        if b:
            out.append(f"build {side}: tests {b['summary']} exit={b['test_exit']} adapter={'ok' if b['adapter_ok'] else 'FAILED'}")
    if corpus:
        out.append(f"cases: {corpus.get('cases')}; deltas: {corpus.get('deltas') or 'none'}")
        for k, v in (corpus.get("tuples") or {}).items():
            if v:
                out.append(f"tests {k}: {len(v)}  e.g. " + ", ".join(f"{e['test'].split('::')[-1]}:{e['line']}" for e in v[:4]))
        rb = corpus.get("robustness", {})
        out.append(f"panics/timeouts: head {len(rb.get('head', []))}, base {len(rb.get('base', []))}")
    if oracle.get("verdicts"):
        trans = {}
        for vs in oracle["verdicts"].values():
            for v in vs:
                t = v["summary"]["latest"]["transition"]
                trans[t] = trans.get(t, 0) + 1
        out.append(f"oracle transitions: {trans}")
    out.append("")
    out.append(f"inspect a case: lcr show {prep.get('run_id')} <case-id>; full diff: {run_dir}/diff.patch")
    text = "\n".join(out)
    print(text)
    return text
