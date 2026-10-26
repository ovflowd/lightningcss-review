"""Run status and the agent worklist (analysis.json skeleton with every slot the report requires)."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from .common import read_json, read_jsonl, write_json


def file_digest(path: Path) -> str | None:
    if not path.exists():
        return None
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def open_analysis_slots(analysis: dict) -> int:
    """Slots in analysis.json still waiting for an answer (stale delta slots do not count)."""
    n = sum(1 for a in analysis.get("checklist", []) if not a.get("answer"))
    n += sum(1 for d in analysis.get("deltas", []) if not d.get("classification") and not d.get("_stale"))
    n += 0 if (analysis.get("intent") or {}).get("summary") else 1
    return n


def stage_rows(run_dir: Path) -> list[tuple[str, str]]:
    rows = []
    for name, file in (("prepare", "prepare.json"), ("build", "build.json"), ("corpus", "corpus.json")):
        rows.append((name, "done" if (run_dir / file).exists() else "-"))
    corpus = read_json(run_dir / "corpus.json") or {}
    probe_dir = run_dir / "probes"
    files = sorted(probe_dir.rglob("*.css")) if probe_dir.exists() else []
    in_corpus = sum(1 for p in corpus.get("probes", []) if p.get("origin") == "pr")
    if not files and not in_corpus:
        rows.append(("probe", "-"))
    else:
        stale = (run_dir / "corpus.json").exists() and any(f.stat().st_mtime > (run_dir / "corpus.json").stat().st_mtime for f in files)
        rows.append(("probe", f"{len(files)} file(s), {in_corpus} in corpus" + ("; stale: run `lcr probe`" if stale or len(files) != in_corpus else "")))
    oracle_path = run_dir / "oracle.json"
    if not oracle_path.exists():
        rows.append(("oracle", "-"))
    else:
        oracle = read_json(oracle_path) or {}
        recorded = oracle.get("inputs") or {}
        cases_path = run_dir / "corpus" / "cases.jsonl"
        if recorded:
            current = {name: file_digest(run_dir / "corpus" / f"{name}.jsonl") for name in ("cases", "outputs-base", "outputs-head")}
            current["probe_files"] = corpus.get("probe_files")
            stale = any(recorded.get(k) != v for k, v in current.items() if k in recorded)
        else:
            stale = cases_path.exists() and cases_path.stat().st_mtime > oracle_path.stat().st_mtime
        errored = sum(1 for vs in (oracle.get("verdicts") or {}).values() if any(v["summary"]["latest"]["transition"] == "errored" for v in vs))
        bits = ["done"] + (["stale: the corpus changed after the oracle ran"] if stale else []) + ([f"{errored} errored case(s)"] if errored else [])
        rows.append(("oracle", "; ".join(bits)))
    analysis = read_json(run_dir / "analysis.json")
    if not analysis:
        rows.append(("analysis", "-"))
    else:
        n = open_analysis_slots(analysis)
        rows.append(("analysis", f"open ({n} slots; refresh with `lcr worklist`)" if n else "done"))
    rows.append(("report", "done" if (run_dir / "report.json").exists() else "-"))
    return rows


def status(run_dir: Path) -> None:
    print(f"run       {run_dir.name}")
    for name, state in stage_rows(run_dir):
        print(f"{name:9} {state}")
    rep = read_json(run_dir / "report.json")
    if rep:
        print(f"verdict   {rep['verdict']}{' (' + rep['verdict_scope'] + ')' if rep.get('verdict_scope') else ''} {rep['counts']}")


def family_glob(case: dict) -> str | None:
    """Glob naming every mutation of the same parent case."""
    if case.get("source") == "mutation" and case.get("parent"):
        return f"m-{case['parent']}-*"
    return None


def delta_slots(ev: dict) -> list[dict]:
    """Open slots grouped by mutation family. A family becomes one glob slot unless it holds a case
    the browsers show head worse than base (those need an exact id, see A3)."""
    from .report import open_slots

    bad = set(ev["oracle_bad"])
    fams: dict[str, list[dict]] = {}
    for s in open_slots(ev):
        key = family_glob(ev["cases"].get(s["id"], {})) or s["id"]
        fams.setdefault(key, []).append(s)
    out = []
    for key, members in sorted(fams.items()):
        if key.endswith("*") and len(members) > 1 and not any(m["id"] in bad for m in members):
            out.append({"id": key, "checks": sorted({c for m in members for c in m["checks"]}), "count": len(members), "cases": [m["id"] for m in members]})
        else:
            out.extend({"id": m["id"], "checks": m["checks"], "count": 1, "cases": [m["id"]]} for m in members)
    return out


def worklist(run_dir: Path) -> dict:
    """Write analysis.json (keeping existing answers) and return the open slots."""
    from .report import evaluate, load_checklists, matches, resolve_answers, untouched_covers

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
    checklist = load_checklists(prep.get("areas", []))
    changed = sorted(prep.get("files", {}))
    by_item = {a.get("item"): a for a in analysis["checklist"] if a.get("item")}
    for it in checklist:
        entry = by_item.get(it["item"])
        if entry is None:
            entry = {"item": it["item"], "answer": "", "evidence": "", "note": "", "_text": it["text"], "_severity": it["severity"], "_verify": it.get("verify", "")}
            analysis["checklist"].append(entry)
        # Items scoped to files the diff does not touch start as N/A; the reviewer can overrule.
        if not entry.get("answer") and untouched_covers(it, changed):
            entry.update({"answer": "N/A", "evidence": f"Covers {', '.join(it['covers'])}; diff touches none", "_prefilled": True})
    slots = delta_slots(ev)
    have = {d.get("id") for d in analysis["deltas"]}
    for s in slots:
        if s["id"] not in have:
            entry = {"id": s["id"], "classification": "", "reason": "", "_check": ", ".join(s["checks"])}
            if s["count"] > 1:
                entry["_count"] = s["count"]
            analysis["deltas"].append(entry)
            have.add(s["id"])
    open_ids = [(cid, ev["cases"].get(cid, {}).get("source", "")) for s in slots for cid in s["cases"]]
    stale = []
    for d in analysis["deltas"]:
        if d.get("classification") or any(matches(d.get("id", ""), cid, src) for cid, src in open_ids):
            d.pop("_stale", None)
        else:
            d["_stale"] = True
            stale.append(d.get("id"))
    write_json(path, analysis)
    answers = resolve_answers(analysis, checklist)
    open_items = {
        "checklist": [it["item"] for it in checklist if not (answers.get(it["item"]) or {}).get("answer")],
        "prefilled_na": [a["item"] for a in analysis["checklist"] if a.get("_prefilled") and a.get("answer") == "N/A"],
        "deltas": [{"id": s["id"], "checks": s["checks"], "count": s["count"]} for s in slots],
        "stale_slots": stale,
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
        if corpus.get("flag_only"):
            out.append("flag-only requests (base rejects the flag): " + ", ".join(f"{k} {len(v)}" for k, v in sorted(corpus["flag_only"].items())))
    if oracle.get("verdicts"):
        trans = {}
        for vs in oracle["verdicts"].values():
            for v in vs:
                t = v["summary"]["latest"]["transition"]
                trans[t] = trans.get(t, 0) + 1
        out.append(f"oracle transitions: {dict(sorted(trans.items()))}")
    out.append("")
    out.append(f"inspect a case: lcr show {prep.get('run_id')} <case-id>; full diff: {run_dir}/diff.patch")
    text = "\n".join(out)
    print(text)
    return text
