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
