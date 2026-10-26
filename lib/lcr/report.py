"""Stage 6: evaluate the check catalog over stage outputs, compute the verdict, render the report.

Everything here is a pure function of the run directory: the same inputs produce byte-identical
report.md / report.json. The agent's judgment enters only through analysis.json, whose slots are
validated (missing slots make the verdict INCONCLUSIVE).
"""
from __future__ import annotations

import fnmatch
import json
import re
from pathlib import Path

from .common import SKILL_DIR, LcrError, cache_dir, load_config, read_json, read_jsonl, skill_version, write_json
from .prepare import test_area_map
from .targets import format_targets

SEV_RANK = {"BLOCKER": 0, "MAJOR": 1, "MINOR": 2, "NOTE": 3}
CHECKLIST_RE = re.compile(r"^- \[([A-Z0-9]+-\d+)\] \((BLOCKER|MAJOR|MINOR|NOTE)\) (.+)$")
CLASSIFICATIONS = {"INTENDED", "ACCEPTABLE_SIDE_EFFECT", "REGRESSION", "NEEDS_MAINTAINER_DECISION", "ORACLE_NOISE"}
SPEC_CITE = re.compile(r"https?://(drafts\.csswg\.org|www\.w3\.org|drafts\.fxtf\.org|html\.spec\.whatwg\.org|wpt\.fyi|github\.com/web-platform-tests/wpt)/\S+")


# ---------------------------------------------------------------------------------------------
# inputs


def load_checklists(areas: list[str]) -> list[dict]:
    root = SKILL_DIR / "references" / "checklists"
    items = []
    for name in ["general"] + sorted(areas):
        path = root / f"{name}.md"
        if not path.exists():
            continue
        current = None
        for line in path.read_text().splitlines():
            m = CHECKLIST_RE.match(line.strip())
            if m:
                current = {"item": m.group(1), "severity": m.group(2), "text": m.group(3), "list": name, "verify": ""}
                items.append(current)
            elif current and line.strip().startswith("verify:"):
                current["verify"] = line.strip()[len("verify:"):].strip()
    seen, out = set(), []
    for it in items:
        if it["item"] not in seen:
            seen.add(it["item"])
            out.append(it)
    return out


def property_areas() -> dict[str, str]:
    data = read_json(SKILL_DIR / "config" / "properties.json", []) or []
    return {p["name"]: p.get("area") for p in data if p.get("name")}


def case_area(case: dict, tmap: dict, pmap: dict) -> list[str]:
    if case["source"] == "probe":
        return [case["probe"]["area"]]
    if case["source"] == "mutation":
        return [case.get("area") or "tests"]
    if case["source"] == "tuple":
        name = case["test"].split("::")[-1]
        return tmap.get(name, ["tests"])
    if case["source"] == "wpt":
        prop = case["wpt"]["property"]
        a = pmap.get(prop) or pmap.get(re.sub(r"^-(webkit|moz|ms|o)-", "", prop))
        return [a] if a else ["unknown"]
    return ["realworld"]


def classified(analysis: dict, cid: str, source: str) -> dict | None:
    for d in analysis.get("deltas", []):
        pattern = d.get("id", "")
        if pattern == cid or (("*" in pattern or "?" in pattern) and fnmatch.fnmatch(cid, pattern)) or pattern == f"source:{source}":
            if d.get("classification") in CLASSIFICATIONS:
                return d
    return None


def snippet(text, limit):
    if text is None:
        return "∅"
    text = str(text)
    return text if len(text) <= limit else text[: limit - 1] + "…"


# ---------------------------------------------------------------------------------------------
# evaluation


def evaluate(run_dir: Path) -> dict:
    prep = read_json(run_dir / "prepare.json")
    if not prep:
        raise LcrError("no prepare.json; run `lcr prepare`")
    build = read_json(run_dir / "build.json") or {}
    corpus = read_json(run_dir / "corpus.json") or {}
    oracle = read_json(run_dir / "oracle.json") or {}
    analysis = read_json(run_dir / "analysis.json") or {}
    cfg = load_config("checks.json")
    th = cfg["thresholds"]
    cases = {c["id"]: c for c in read_jsonl(run_dir / "corpus" / "cases.jsonl")}
    deltas = {d["id"]: d for d in read_jsonl(run_dir / "corpus" / "deltas.jsonl")}
    verdicts = oracle.get("verdicts", {})
    tmap = test_area_map()
    pmap = property_areas()
    stages = {
        "prepare": True,
        "build": bool(build),
        "corpus": bool(corpus),
        "oracle": bool(oracle),
        "analysis": bool(analysis),
    }
    # Side effects are judged against the areas the PR directly touches; the blast radius explains
    # deltas but does not excuse them.
    declared = set(prep.get("areas", [])) | {"tests"}
    checks = []

    def add(cid, status, evidence="", items=None, severity=None):
        meta = next(c for c in cfg["checks"] if c["id"] == cid)
        sev = None
        if status == "FAIL":
            sev = severity or (meta["fail"] if meta["fail"] in SEV_RANK else "MAJOR")
        elif status == "PARTIAL":
            sev = severity or meta.get("partial", "NOTE")
        checks.append({"id": cid, "group": meta["group"], "title": meta["title"], "status": status, "severity": sev, "evidence": evidence, "items": items or []})

    def light(v):  # light-scheme verdict entry
        return next((x for x in v if x.get("scheme") == "light"), v[0]) if v else None

    # ---- build
    head = build.get("head", {})
    base = build.get("base", {})
    if not build:
        for cid in ("B1", "B2", "B3", "B4"):
            add(cid, "SKIP", "build stage did not run")
    else:
        head_tests = read_json(run_dir / "build" / "head" / "tests.json", {}) or {}
        base_tests = read_json(run_dir / "build" / "base" / "tests.json", {}) or {}
        failed = sorted(k for k, v in head_tests.get("tests", {}).items() if v == "failed")
        base_failed = {k for k, v in base_tests.get("tests", {}).items() if v == "failed"}
        new_failed = [f for f in failed if f not in base_failed]
        if head.get("compile_errors") and not head_tests.get("tests"):
            add("B1", "FAIL", "head does not compile", head["compile_errors"][:8])
        elif new_failed:
            add("B1", "FAIL", f"{len(new_failed)} test(s) fail on head but not on base", new_failed[: th["max_listed_cases"]])
        elif failed:
            add("B1", "PARTIAL", f"{len(failed)} test(s) fail on both base and head (pre-existing)", failed[:8], severity="NOTE")
        else:
            add("B1", "PASS", f"{head.get('summary', {}).get('passed', 0)} passed, {head.get('summary', {}).get('ignored', 0)} ignored")
        add("B2", "FAIL" if head.get("warnings_as_errors") else "PASS", "warnings become errors under RUSTFLAGS=-D warnings" if head.get("warnings_as_errors") else "")
        changed = set(prep.get("files", {}))
        fmt_bad = sorted(f for f in head.get("fmt_files", []) if f.lstrip("/").replace("/src/", "", 1) in changed or any(f.endswith(c) for c in changed))
        add("B3", "FAIL" if fmt_bad else "PASS", "rustfmt would change: " + ", ".join(fmt_bad) if fmt_bad else "")
        add("B4", "FAIL" if head.get("lockfile_outdated") else "PASS", "Cargo.lock needs updating" if head.get("lockfile_outdated") else "")
    js = build.get("js", {})
    if js.get("ran") and js.get("js_tests"):
        add("B5", "FAIL" if js.get("failed_step") else "PASS", f"failed at `{js['failed_step']}`" if js.get("failed_step") else "yarn build, test, tsc")
    elif js.get("ran") and js.get("failed_step"):
        add("B5", "FAIL", f"failed at `{js['failed_step']}`")
    else:
        add("B5", "SKIP", "bindings not touched")
    def lane_check(cid, lane, why):
        hl = head.get("lanes", {}).get(lane)
        bl = base.get("lanes", {}).get(lane)
        if not hl:
            add(cid, "SKIP", why)
        elif hl["exit"] == 0:
            add(cid, "PASS", f"{hl.get('seconds')}s")
        elif bl and bl["exit"] != 0:
            add(cid, "PARTIAL", "fails on base too (pre-existing)", hl["errors"][:4] or [hl["tail"][-300:]], severity="NOTE")
        else:
            add(cid, "FAIL", "fails on head, passes on base", hl["errors"][:6] or [hl["tail"][-400:]])

    if build:
        lane_check("B7", "selectors", "lane not run")
        lane_check("B8", "no-default-features", "lane not run")
        lane_check("B9", "wasm-check", "no napi/node/cfg(target_arch) changes")
        lane_check("B10", "c-bindings", "c/ not touched")
        if js.get("regen_compat") or js.get("regen_ast"):
            drift = js.get("drift", {})
            add("B11", "FAIL" if drift else ("SKIP" if js.get("failed_step") else "PASS"), ("regenerate and commit: " + ", ".join(sorted(drift))) if drift else (f"regeneration failed at `{js['failed_step']}`" if js.get("failed_step") else "regenerated output matches the PR"))
        else:
            add("B11", "SKIP", "no generated inputs touched")
    ci = prep.get("ci_checks") or []
    if not ci:
        add("B6", "SKIP", "no checks reported (first-time contributor workflows may need approval)")
    else:
        bad = [c["name"] for c in ci if c.get("bucket") == "fail"]
        pending = [c["name"] for c in ci if c.get("bucket") == "pending"]
        if bad:
            add("B6", "FAIL", "failing: " + ", ".join(bad))
        elif pending:
            add("B6", "PARTIAL", "pending: " + ", ".join(pending), severity="NOTE")
        else:
            add("B6", "PASS", ", ".join(c["name"] for c in ci))

    # ---- tests
    flags = {f["id"]: f for f in prep.get("risk_flags", [])}
    add("T1", "FAIL" if "no-tests" in flags else "PASS", flags["no-tests"]["detail"] if "no-tests" in flags else "")
    tup = corpus.get("tuples", {})
    nf, np_ = tup.get("new_failing_on_base", []), tup.get("new_passing_on_base", [])
    src_changed = any(p.startswith(("src/", "selectors/")) and p != "src/lib.rs" for p in prep.get("files", {}))
    if not corpus:
        add("T2", "SKIP", "corpus stage did not run")
    elif not nf and not np_:
        add("T2", "SKIP", "no new test cases")
    elif not nf and src_changed:
        add("T2", "FAIL", f"all {len(np_)} new test case(s) already pass on base: none demonstrates the change", [f"{e['test']} (lib.rs:{e['line']})" for e in np_][: th["max_listed_cases"]])
    elif np_:
        add("T2", "PARTIAL", f"{len(nf)} new case(s) fail on base (exercise the change); {len(np_)} pass on base too", [f"{e['test']} (lib.rs:{e['line']})" for e in np_][:8])
    else:
        add("T2", "PASS", f"{len(nf)} new case(s), all fail on base")
    modified = tup.get("modified", [])
    if modified:
        bad, unver = [], []
        for m in modified:
            v = light(verdicts.get(m["head_id"]) or verdicts.get(m["id"]) or [])
            st = v["summary"]["latest"]["head"] if v else "unknown"
            if st == "different":
                bad.append(m)
            elif st in ("unknown", "no-coverage"):
                unver.append(m)
        if bad:
            add("T3", "FAIL", f"{len(bad)} changed expectation(s) are not equivalent to their input in browsers", [f"{m['test']} lib.rs:{m.get('head_line')} ({m['head_id']})" for m in bad][: th["max_listed_cases"]])
        elif unver:
            add("T3", "PARTIAL", f"{len(unver)} changed expectation(s) could not be verified in browsers", [f"{m['test']} lib.rs:{m.get('head_line')}" for m in unver][:8])
        else:
            add("T3", "PASS", f"{len(modified)} changed expectation(s) verified")
    else:
        add("T3", "SKIP", "no existing expectation changed")
    rc = tup.get("removed_changed", [])
    add("T4", "FAIL" if rc else "PASS", f"{len(rc)} expectation(s) removed and the behavior changed" if rc else (f"{len(tup.get('removed_same', []))} removed, behavior unchanged" if tup.get("removed_same") else ""), [f"{e['test']} lib.rs:{e['line']}" for e in rc][:8])
    hm = tup.get("head_mismatch", [])
    stats = corpus.get("tuple_stats", {})
    add("T5", "PARTIAL" if hm else "PASS", (f"{len(hm)} recorded expectation(s) not reproduced by the adapter; excluded from conclusions" if hm else f"{stats.get('head_tuples', 0)} head tuples reproduced") + (f"; unmappable helpers: {', '.join(stats.get('unmappable_helpers', []))}" if stats.get("unmappable_helpers") else ""), [f"{e['test']} lib.rs:{e['line']}" for e in hm][:8], severity="NOTE")

    # ---- oracle
    regressed, new_bad, rejected, legacy_reg, near, visual, wpt_reg, unverified, divergent = [], [], [], [], [], [], [], [], []
    for cid, vs in sorted(verdicts.items()):
        case = cases.get(cid, {})
        src = case.get("source", "?")
        for v in vs:
            s = v["summary"]["latest"]
            tag = f"{cid}{'~dark' if v.get('scheme') == 'dark' else ''}"
            is_divergent = bool(s.get("divergent")) and s["head"] == "different" and not s.get("neutral")
            if is_divergent and (s["transition"] in ("regressed", "still-different") or (src == "tuple" and case.get("side") == "head")):
                eh = s.get("enginesHead", {})
                divergent.append(f"{tag} [head equivalent in {', '.join(eh.get('ok', []))}; different in {', '.join(eh.get('bad', []))}]")
            elif s["transition"] == "regressed":
                (wpt_reg if src == "wpt" else regressed).append(tag)
            if s["transition"] == "near-introduced":
                near.append(tag)
            if s["rejectedHead"] > s["rejectedBase"]:
                rejected.append(tag)
            if s.get("visualHead") and not s.get("visualBase"):
                visual.append(tag)
            if src == "tuple" and case.get("side") == "head" and s["head"] == "different" and not is_divergent:
                new_bad.append(tag)
            for prof, ls in v["summary"].get("legacy", {}).items():
                if ls["transition"] == "regressed":
                    legacy_reg.append(f"{tag}@{prof}")
            if s["transition"] == "unverified" and cid in deltas:
                unverified.append(tag)

    def unexplained(ids):
        out = []
        for t in ids:
            cid = t.split("~")[0].split("@")[0]
            d = classified(analysis, cid, cases.get(cid, {}).get("source", ""))
            if not d or d["classification"] in ("REGRESSION", "NEEDS_MAINTAINER_DECISION"):
                out.append(t)
        return out

    if not oracle:
        for cid in ("O1", "O2", "O3", "O4", "O5", "O6", "O7", "O8", "O9"):
            add(cid, "SKIP", "oracle stage did not run")
    else:
        r = unexplained(regressed)
        add("O1", "FAIL" if r else "PASS", f"{len(r)} case(s) equivalent on base but different on head" if r else (f"{len(regressed)} regression(s) classified as noise/intended in analysis" if regressed else ""), r[: th["max_listed_cases"]])
        nb = unexplained(new_bad)
        add("O2", "FAIL" if nb else "PASS", f"{len(nb)} new/changed test output(s) render differently from their input in every engine" if nb else (f"{len(new_bad)} classified in analysis" if new_bad else ""), nb[: th["max_listed_cases"]])
        rj = unexplained(rejected)
        add("O3", "FAIL" if rj else "PASS", f"{len(rj)} case(s) emit CSS an engine rejects with no surviving fallback" if rj else "", rj[: th["max_listed_cases"]])
        if oracle.get("profiles") and len(oracle["profiles"]) > 1:
            lr = unexplained(legacy_reg)
            add("O4", "FAIL" if lr else "PASS", f"{len(lr)} lowering regression(s) in legacy engines" if lr else ", ".join(p for p in oracle["profiles"] if p != "latest"), lr[: th["max_listed_cases"]])
        else:
            add("O4", "SKIP", "no legacy engine profile ran")
        nr = unexplained(near)
        add("O5", "FAIL" if nr else "PASS", f"{len(nr)} case(s) drift within tolerance (color/number)" if nr else "", nr[:8])
        vi = unexplained(visual)
        add("O6", "FAIL" if vi else "PASS", f"{len(vi)} case(s) render different pixels" if vi else "", vi[:8])
        wr = unexplained(wpt_reg)
        add("O7", "FAIL" if wr else ("PASS" if any(c.get("source") == "wpt" for c in cases.values()) else "SKIP"), f"{len(wr)} WPT case(s) regressed" if wr else "", wr[: th["max_listed_cases"]])
        dv = unexplained(divergent)
        add("O9", "FAIL" if dv else "PASS", f"{len(dv)} case(s) where engines disagree about the input; decide against the spec" if dv else (f"{len(divergent)} engine-divergent case(s) classified" if divergent else ""), dv[: th["max_listed_cases"]])
        not_run = [cid for cid in sorted(deltas) if cid not in verdicts]
        open_items = unexplained(unverified + not_run)
        add("O8", "FAIL" if open_items else "PASS", f"{len(open_items)} delta(s) not verified by the oracle and not classified in analysis.json" if open_items else f"{len(deltas)} delta(s) verified or classified", open_items[: th["max_listed_cases"]])

    # ---- robustness
    rb = corpus.get("robustness", {"head": [], "base": []})
    base_ids = {r["id"] for r in rb.get("base", [])}
    new_crash = [r for r in rb.get("head", []) if r["id"] not in base_ids]
    if not corpus:
        add("R1", "SKIP", "corpus stage did not run")
        add("R2", "SKIP", "corpus stage did not run")
    else:
        add("R1", "FAIL" if new_crash else ("PARTIAL" if rb.get("head") else "PASS"), f"{len(new_crash)} new panic/crash/timeout" if new_crash else (f"{len(rb['head'])} pre-existing (also on base)" if rb.get("head") else ""), [f"{r['id']} {r['stage']}: {snippet(r['error'], 120)}" for r in (new_crash or rb.get("head", []))][:8], severity=None if new_crash else "NOTE")
        idem = [i for i in corpus.get("idempotency_failures", []) if i in deltas or cases.get(i, {}).get("origin") == "pr"]
        add("R2", "FAIL" if idem else "PASS", f"{len(idem)} changed case(s) are not stable under a second minify pass" if idem else "", idem[:8])

    # ---- side effects
    outside, auto_ok = [], []
    for cid in sorted(deltas):
        case = cases.get(cid)
        if not case:
            continue
        areas = case_area(case, tmap, pmap)
        if set(areas) & declared:
            continue
        vs = verdicts.get(cid) or []
        # Accepted without classification when the browsers say the PR's change is harmless: output
        # still equivalent everywhere, or exactly the same pre-existing differences as base
        # (`neutral`), with no legacy-engine regression.
        verified_ok = bool(vs) and all(
            (v["summary"]["latest"]["transition"] == "both-equivalent" or v["summary"]["latest"].get("neutral"))
            and not any(ls["transition"] == "regressed" or (ls["transition"] == "still-different" and not ls.get("neutral")) for ls in v["summary"].get("legacy", {}).values())
            for v in vs
        )
        if verified_ok:
            auto_ok.append(cid)
        elif not classified(analysis, cid, case["source"]):
            outside.append(f"{cid} [{', '.join(areas)}]")
    if not corpus:
        add("S1", "SKIP", "corpus stage did not run")
    else:
        scope = ", ".join(sorted(declared - {"tests"})) or "none"
        note = f"; {len(auto_ok)} outside delta(s) verified equivalent in every engine (accepted)" if auto_ok else ""
        add("S1", "FAIL" if outside else "PASS", (f"{len(outside)} delta(s) outside the touched areas ({scope}) need classification" if outside else f"touched areas: {scope}") + note, outside[: th["max_listed_cases"]])
    size = corpus.get("size", [])
    if size:
        tb = sum(s["base"] for s in size if s["mode"] == "minify")
        thd = sum(s["head"] for s in size if s["mode"] == "minify")
        ratio = (thd - tb) / tb if tb else 0
        grew = [f"{s['name']}/{s['mode']}: {s['base']} -> {s['head']} bytes" for s in size if s["head"] > s["base"]]
        add("S2", "FAIL" if ratio > th["size_growth_ratio"] else "PASS", f"minified total {tb} -> {thd} bytes ({ratio:+.3%})", grew[:8])
    else:
        add("S2", "SKIP", "real-world corpus not available")
    ov = prep.get("overlapping_prs", [])
    add("S3", "PARTIAL" if ov else "PASS", f"{len(ov)} open PR(s) touch the same files" if ov else "", [f"#{o['number']} {o['title']} ({', '.join(o['shared_files'])})" for o in ov][:8], severity="NOTE")

    # ---- perf (optional stage)
    perf = read_json(run_dir / "perf.json")
    if not perf:
        add("P1", "SKIP", "optional: run `lcr perf` for core/hot-path changes")
        add("P2", "SKIP", "optional: run `lcr perf`")
    else:
        slow = perf["total_ratio"] and perf["total_ratio"] > th["perf_total_ratio"] and perf["slower_share"] >= th["perf_slower_share"]
        add("P1", "FAIL" if slow else "PASS", f"real-world total {perf['total_ms']['base']}ms -> {perf['total_ms']['head']}ms (x{perf['total_ratio']}); {perf['slower_share']:.0%} of files >5% slower; median of {perf['repeats']}",
            [f"{r['name']}: x{r['ratio']}" for r in sorted(perf["files"], key=lambda r: -(r["ratio"] or 0))[:6]] if slow else [])
        grew = perf["binary_ratio"] > th["binary_growth_ratio"]
        add("P2", "FAIL" if grew else "PASS", f"release CLI {perf['binary_bytes']['base']} -> {perf['binary_bytes']['head']} bytes (x{perf['binary_ratio']})")

    # ---- analysis
    checklist = load_checklists(prep.get("areas", []))
    answers = {a.get("item"): a for a in analysis.get("checklist", [])}
    missing_items = [it["item"] for it in checklist if it["item"] not in answers or answers[it["item"]].get("answer") not in ("PASS", "FAIL", "N/A") or not answers[it["item"]].get("evidence")]
    failed_items = [it for it in checklist if answers.get(it["item"], {}).get("answer") == "FAIL"]
    if not analysis:
        add("A1", "SKIP", "analysis.json missing")
    elif failed_items:
        worst = min((it["severity"] for it in failed_items), key=lambda s: SEV_RANK[s])
        add("A1", "FAIL", f"{len(failed_items)} checklist item(s) failed", [f"{it['item']} ({it['severity']}): {it['text']}" for it in failed_items], severity=worst)
    else:
        add("A1", "PASS" if not missing_items else "PARTIAL", f"{len(checklist) - len(missing_items)}/{len(checklist)} items answered", severity="NOTE")
    linked = [i["number"] for i in prep.get("linked_issues", [])]
    probes = {p["id"]: p for p in corpus.get("probes", [])}
    if linked and not analysis:
        add("A2", "SKIP", "analysis.json missing (write an issue probe first)")
    elif linked:
        problems = []
        for n in linked:
            mine = [p for p in probes.values() if p["origin"] == "pr" and p["known"] == f"open-issue#{n}"]
            if not mine:
                problems.append(f"#{n}: no PR probe with `known: open-issue#{n}`")
                continue
            for p in mine:
                v = light(verdicts.get(p["id"]) or [])
                eq_head = v["summary"]["latest"]["head"] if v else None
                asserts_head = [x for x in p["assert"]["head"].values() if x is not None]
                asserts_base = [x for x in p["assert"]["base"].values() if x is not None]
                head_ok = all(asserts_head) and eq_head in (None, "equivalent", "near", "no-coverage")
                base_ok = all(asserts_base) and (v["summary"]["latest"]["base"] in (None, "equivalent", "near", "no-coverage") if v else True)
                if not head_ok:
                    problems.append(f"#{n}: {p['probe']} fails on head")
                elif base_ok and not p["changed"]:
                    problems.append(f"#{n}: {p['probe']} passes on base too (does it reproduce the issue?)")
        add("A2", "FAIL" if problems else "PASS", f"{len(linked)} linked issue(s)", problems)
    else:
        add("A2", "SKIP", "no linked issues")
    incomplete = []
    if not analysis:
        incomplete.append("analysis.json missing")
    else:
        intent = analysis.get("intent", {})
        if not intent.get("summary") or "|" in str(intent.get("kind", "|")):
            incomplete.append("intent.summary/kind")
        if missing_items:
            incomplete.append("checklist items unanswered or without evidence: " + ", ".join(missing_items[:10]) + ("…" if len(missing_items) > 10 else ""))
        for f in analysis.get("findings", []):
            if f.get("severity") not in SEV_RANK or not f.get("title") or not f.get("evidence"):
                incomplete.append(f"finding without severity/title/evidence: {snippet(f.get('title'), 60)}")
        must_cite = {t.split(" ")[0].split("~")[0].split("@")[0] for t in regressed + new_bad + divergent + wpt_reg}
        for d in analysis.get("deltas", []):
            if d.get("classification") not in CLASSIFICATIONS or not d.get("reason"):
                incomplete.append(f"delta classification invalid: {d.get('id')}")
            elif d.get("id") in must_cite and d["classification"] in ("INTENDED", "ACCEPTABLE_SIDE_EFFECT", "ORACLE_NOISE") and not SPEC_CITE.search(d.get("reason", "")):
                incomplete.append(f"{d['id']}: browsers disagree with head; an {d['classification']} classification must cite the spec (drafts.csswg.org/w3.org URL#anchor) or a WPT file")
    if not analysis:
        add("A3", "SKIP", "analysis.json missing: run `lcr worklist` and fill it")
    else:
        add("A3", "FAIL" if incomplete else "PASS", "; ".join(incomplete[:6]) if incomplete else "all slots filled")

    # Every catalog check appears exactly once, in catalog order (stable report shape).
    present = {c["id"] for c in checks}
    for meta in cfg["checks"]:
        if meta["id"] not in present:
            add(meta["id"], "SKIP", "not evaluated (stage missing)")
    order = {m["id"]: i for i, m in enumerate(cfg["checks"])}
    checks.sort(key=lambda c: order[c["id"]])

    # ---- findings
    findings = []
    for c in checks:
        if c["status"] in ("FAIL", "PARTIAL") and c["severity"]:
            findings.append({"source": "check", "check": c["id"], "severity": c["severity"], "title": c["title"], "detail": c["evidence"], "evidence": c["items"]})
    for it in failed_items:
        a = answers[it["item"]]
        findings.append({"source": "checklist", "check": it["item"], "severity": it["severity"], "title": it["text"], "detail": a.get("note", ""), "evidence": [a.get("evidence", "")]})
    for f in analysis.get("findings", []):
        if f.get("severity") in SEV_RANK:
            findings.append({"source": "analysis", "check": None, "severity": f["severity"], "title": f.get("title", ""), "detail": f.get("detail", ""), "evidence": f.get("evidence", []), "suggested_test": f.get("suggested_test")})
    for d in analysis.get("deltas", []):
        if d.get("classification") == "REGRESSION":
            findings.append({"source": "analysis", "check": None, "severity": "BLOCKER", "title": f"Regression: {d['id']}", "detail": d.get("reason", ""), "evidence": [d["id"]]})
        elif d.get("classification") == "NEEDS_MAINTAINER_DECISION":
            findings.append({"source": "analysis", "check": None, "severity": "NOTE", "title": f"Needs maintainer decision: {d['id']}", "detail": d.get("reason", ""), "evidence": [d["id"]]})
    findings.sort(key=lambda f: (SEV_RANK[f["severity"]], f["source"] != "check", f["check"] or "", f["title"]))
    for i, f in enumerate(findings, 1):
        f["n"] = i
    counts = {s: sum(1 for f in findings if f["severity"] == s) for s in SEV_RANK}
    if counts["BLOCKER"]:
        verdict = "UNSAFE"
    elif counts["MAJOR"]:
        verdict = "NEEDS_CHANGES"
    elif counts["MINOR"]:
        verdict = "SAFE_WITH_NITS"
    else:
        verdict = "SAFE"
    missing_stages = [s for s, ok in stages.items() if not ok]
    if (missing_stages or incomplete) and verdict in ("SAFE", "SAFE_WITH_NITS"):
        verdict = "INCONCLUSIVE"
    return {
        "prep": prep, "build": build, "corpus": corpus, "oracle": oracle, "analysis": analysis, "cases": cases, "deltas": deltas,
        "checks": checks, "findings": findings, "counts": counts, "verdict": verdict, "stages": stages, "missing_stages": missing_stages,
        "checklist": checklist, "answers": answers,
    }


# ---------------------------------------------------------------------------------------------
# rendering


def fence(text, lang="css"):
    text = "" if text is None else str(text)
    ticks = "```"
    while ticks in text:
        ticks += "`"
    return f"{ticks}{lang}\n{text.rstrip()}\n{ticks}"


def md_cell(text):
    return str(text).replace("|", "\\|").replace("\n", " ")


def outputs(run_dir: Path, side: str) -> dict:
    return {r["id"]: r for r in read_jsonl(run_dir / "corpus" / f"outputs-{side}.jsonl")}


def describe_case(case: dict) -> str:
    src = case.get("source")
    if src == "tuple":
        return f"test `{case['test'].split('::')[-1]}` (`{case['helper']}`, lib.rs:{case['line']}, {case['side']})"
    if src == "probe":
        return f"probe `{case['probe']['id']}` ({case['origin']}): {case['probe']['title']}"
    if src == "mutation":
        return f"mutation `{case['mutation']}` of `{case['parent']}`"
    if src == "wpt":
        return f"WPT `{case['wpt']['file']}` `{case['wpt']['property']}: {case['wpt']['value']}` ({case['wpt']['kind']}, mode {case['mode']})"
    return f"real-world `{case.get('name')}` (mode {case.get('mode')})"


def case_block(ev: dict, run_dir: Path, cid: str, base_out: dict, head_out: dict, limit: int) -> list[str]:
    case = ev["cases"].get(cid, {})
    req = case.get("request", {})
    lines = [f"- **{cid}** — {describe_case(case)}; targets: {format_targets(req.get('targets'))}; minify: {req.get('minify')}"]
    src_text = req.get("css") if req.get("kind") != "property" else f"{req.get('property')}: {req.get('value')}"
    b, h = base_out.get(cid, {}), head_out.get(cid, {})
    lines.append("")
    lines.append("  input:")
    lines.append("  " + fence(snippet(src_text, limit)).replace("\n", "\n  "))
    lines.append("  base → head:")
    lines.append("  " + fence(snippet(b.get("code") if b.get("ok") else f"/* {b.get('stage')} error: {b.get('error')} */", limit) + "\n/* ---- head ---- */\n" + snippet(h.get("code") if h.get("ok") else f"/* {h.get('stage')} error: {h.get('error')} */", limit)).replace("\n", "\n  "))
    for v in ev["oracle"].get("verdicts", {}).get(cid, []):
        s = v["summary"]["latest"]
        lines.append(f"  oracle ({v.get('scheme')}): base **{s['base']}**, head **{s['head']}** → `{s['transition']}`")
        for engine, e in sorted(v.get("latest", {}).items()):
            hv = e.get("variants", {}).get("head", {}) if "variants" in e else {}
            diffs = hv.get("diffs", [])[:3]
            rej = hv.get("rejected", {}) if isinstance(hv.get("rejected"), dict) else {}
            bits = []
            for d in diffs:
                bits.append(f"`{d['key']}` {d['prop']}: `{snippet(d['ref'], 80)}` vs `{snippet(d['val'], 80)}` ({d['level']})")
            for d in (rej.get("decls") or [])[:2]:
                if not d.get("fallbackSurvives"):
                    bits.append(f"rejected `{d['prop']}: {snippet(d['value'], 60)}`")
            if "detail" in hv and isinstance(hv["detail"], dict):
                bits.append(f"{hv['detail'].get('status')}")
            if bits:
                lines.append(f"    - {engine} {e.get('version', '')}: " + "; ".join(bits))
        for prof, ls in sorted(v["summary"].get("legacy", {}).items()):
            lines.append(f"    - {prof}: base {ls['base']}, head {ls['head']} → `{ls['transition']}`")
    return lines


def render(ev: dict, run_dir: Path) -> str:
    prep, build, corpus, oracle, analysis = ev["prep"], ev["build"], ev["corpus"], ev["oracle"], ev["analysis"]
    th = load_config("checks.json")["thresholds"]
    limit = th["snippet_chars"]
    pr = prep.get("pr", {})
    L = []
    title = f"#{pr.get('number')} {pr.get('title')}" if pr else prep.get("range", "")
    L.append(f"# LightningCSS review: {title}")
    L.append("")
    c = ev["counts"]
    L.append(f"**VERDICT: {ev['verdict']}** · {c['BLOCKER']} blocker · {c['MAJOR']} major · {c['MINOR']} minor · {c['NOTE']} note")
    L.append("")
    strategy = {"merged-into-master": "PR head merged into master (merge-tree, no commit)", "pr-head-vs-merge-base": "PR head vs merge-base (merge conflicts with master)", "local-range": "local range"}[prep["strategy"]]
    L.append(f"- Run `{prep['run_id']}` · skill {skill_version()} · {strategy}")
    L.append(f"- Base `{prep['base'][:12]}` · head tree `{prep['head_tree'][:12]}` · PR head `{prep.get('pr_head', '')[:12]}`")
    if pr:
        L.append(f"- Author @{pr.get('author')} · {pr.get('url')} · state {pr.get('state')}{' (draft)' if pr.get('draft') else ''}")
    profiles = oracle.get("profiles", {})
    if profiles:
        L.append("- Engines: " + " · ".join(f"{p}: " + ", ".join(f"{k} {v}" for k, v in sorted(vs.items()) if k in ("chromium", "firefox", "webkit")) for p, vs in sorted(profiles.items(), key=lambda x: x[0] != "latest")))
    if ev["missing_stages"]:
        L.append(f"- Stages not run: {', '.join(ev['missing_stages'])}")
    L.append("")

    L.append("## 1. Checks")
    L.append("")
    L.append("| ID | Check | Result | Severity | Evidence |")
    L.append("|---|---|---|---|---|")
    for ch in ev["checks"]:
        L.append(f"| {ch['id']} | {md_cell(ch['title'])} | {ch['status']} | {ch['severity'] or ''} | {md_cell(snippet(ch['evidence'], 160))} |")
    L.append("")

    L.append("## 2. Findings")
    L.append("")
    if not ev["findings"]:
        L.append("None.")
    for f in ev["findings"]:
        tag = f"[{f['check']}] " if f.get("check") else ""
        L.append(f"### F{f['n']} [{f['severity']}] {tag}{f['title']}")
        L.append("")
        if f.get("detail"):
            L.append(str(f["detail"]))
            L.append("")
        for item in f.get("evidence") or []:
            L.append(f"- {item}")
        if f.get("suggested_test"):
            L.append("")
            L.append("Suggested test:")
            L.append("")
            L.append(fence(f["suggested_test"], "rust"))
        L.append("")

    L.append("## 3. Change")
    L.append("")
    intent = analysis.get("intent", {})
    if intent:
        L.append(f"- Kind: {intent.get('kind')} · behind flag: {intent.get('behind_flag', 'n/a')}")
        L.append(f"- Intent: {intent.get('summary')}")
        for claim in intent.get("claims", []):
            L.append(f"  - claim: {claim}")
    L.append(f"- Areas: {', '.join(prep.get('areas', [])) or 'none'} · blast radius adds: {', '.join(prep.get('radius_areas', [])) or 'none'}")
    for path, info in sorted(prep.get("files", {}).items()):
        L.append(f"  - `{path}` {info['status']} +{info['added']}/-{info['removed']} → {', '.join(prep['file_areas'].get(path, []))}")
    if prep.get("changed_tests"):
        L.append(f"- Test functions touched: {', '.join(sorted(set(sum(prep['changed_tests'].values(), []))))}")
    items = sorted({(i['file'], (i.get('impl') or {}).get('type'), (i.get('item') or {}).get('name')) for i in prep.get("changed_items", [])}, key=lambda x: tuple(str(y) for y in x))
    if items:
        L.append("- Changed items: " + ", ".join(f"`{f}`:{t or '-'}::{n or '-'}" for f, t, n in items))
    for r in prep.get("blast_radius", []):
        L.append(f"  - `{r['name']}` referenced in {len(r['files'])} file(s): {', '.join(r['files'][:8])}")
    for flag in prep.get("risk_flags", []):
        L.append(f"- Risk flag `{flag['id']}`: {flag['detail']}")
    for i in prep.get("linked_issues", []):
        L.append(f"- Linked issue #{i['number']} ({i['state']}): {i['title']}")
    for o in prep.get("overlapping_prs", [])[:8]:
        L.append(f"- Overlaps open PR #{o['number']} {o['title']} — {', '.join(o['shared_files'])}")
    L.append("")

    L.append("## 4. Behavioral delta")
    L.append("")
    cases_n = corpus.get("cases", {})
    deltas_n = corpus.get("deltas", {})
    L.append("| Source | Cases | Deltas (base ≠ head) |")
    L.append("|---|---|---|")
    for src in ("tuple", "probe", "mutation", "wpt", "realworld"):
        L.append(f"| {src} | {cases_n.get(src, 0)} | {deltas_n.get(src, 0)} |")
    L.append("")
    trans = {}
    for vs in oracle.get("verdicts", {}).values():
        for v in vs:
            key = (ev["cases"].get(v["case"], {}).get("source", "?"), v["summary"]["latest"]["transition"])
            trans[key] = trans.get(key, 0) + 1
    if trans:
        L.append("Oracle transitions (current engines):")
        L.append("")
        L.append("| Source | Transition | Count |")
        L.append("|---|---|---|")
        for (src, t), n in sorted(trans.items()):
            L.append(f"| {src} | {t} | {n} |")
        L.append("")
    st = oracle.get("stats", {})
    if st:
        L.append(f"Oracle selection: {st.get('selected', 0)} of {st.get('candidates', 0)} candidate case(s); not run: {st.get('dropped', 0)}. By reason: " + ", ".join(f"{k}={v}" for k, v in sorted(st.get("by_reason", {}).items())))
        L.append("")
    base_out, head_out = outputs(run_dir, "base"), outputs(run_dir, "head")
    groups = [
        ("4.1 Regressions", lambda s, v: s["transition"] == "regressed"),
        ("4.2 Changed and still different from input", lambda s, v: s["transition"] == "still-different"),
        ("4.3 Fixed by this PR", lambda s, v: s["transition"] == "fixed"),
        ("4.4 Lowering regressions (legacy engines)", lambda s, v: any(ls["transition"] == "regressed" for ls in v["summary"].get("legacy", {}).values())),
    ]
    for heading, pred in groups:
        ids = sorted({cid for cid, vs in oracle.get("verdicts", {}).items() for v in vs if pred(v["summary"]["latest"], v)})
        L.append(f"### {heading} ({len(ids)})")
        L.append("")
        for cid in ids[: th["max_listed_cases"]]:
            L.extend(case_block(ev, run_dir, cid, base_out, head_out, limit))
            L.append("")
        if len(ids) > th["max_listed_cases"]:
            L.append(f"_{len(ids) - th['max_listed_cases']} more in oracle.json_")
            L.append("")
    unv = sorted(cid for cid in ev["deltas"] if cid not in oracle.get("verdicts", {}) or all(v["summary"]["latest"]["transition"] == "unverified" for v in oracle["verdicts"][cid]))
    L.append(f"### 4.5 Deltas the oracle could not verify ({len(unv)})")
    L.append("")
    for cid in unv[: th["max_listed_cases"]]:
        d = classified(analysis, cid, ev["cases"].get(cid, {}).get("source", ""))
        L.append(f"- `{cid}` {describe_case(ev['cases'].get(cid, {}))} — {('**' + d['classification'] + '**: ' + d['reason']) if d else 'unclassified'}")
    if len(unv) > th["max_listed_cases"]:
        L.append(f"- _{len(unv) - th['max_listed_cases']} more in corpus/deltas.jsonl_")
    L.append("")

    L.append("## 5. Test expectations")
    L.append("")
    tup = corpus.get("tuples", {})
    ts = corpus.get("tuple_stats", {})
    L.append(f"Recorded helper calls: base {ts.get('base_tuples', 0)}, head {ts.get('head_tuples', 0)} (unmappable: {ts.get('unmappable', 0)}).")
    L.append("")
    for key, label in (("new_failing_on_base", "New cases that fail on base (exercise the change)"), ("new_passing_on_base", "New cases that already pass on base"), ("modified", "Changed expectations"), ("removed_changed", "Removed cases whose behavior changed"), ("removed_same", "Removed cases, behavior unchanged"), ("head_mismatch", "Not reproduced by the adapter (excluded)")):
        rows = tup.get(key, [])
        L.append(f"- {label}: {len(rows)}")
        for r in rows[:6]:
            L.append(f"  - `{r['test'].split('::')[-1]}` lib.rs:{r['line']}{' → lib.rs:' + str(r['head_line']) if r.get('head_line') else ''}")
    L.append("")

    L.append("## 6. Spec checklist")
    L.append("")
    if ev["checklist"]:
        L.append("| Item | Severity | Check | Answer | Evidence |")
        L.append("|---|---|---|---|---|")
        for it in ev["checklist"]:
            a = ev["answers"].get(it["item"], {})
            L.append(f"| {it['item']} | {it['severity']} | {md_cell(snippet(it['text'], 140))} | {a.get('answer', '—')} | {md_cell(snippet(a.get('evidence', ''), 140))} |")
    else:
        L.append("No checklist applies.")
    L.append("")

    L.append("## 7. Robustness and stability")
    L.append("")
    rb = corpus.get("robustness", {})
    L.append(f"- Panics/crashes/timeouts: head {len(rb.get('head', []))}, base {len(rb.get('base', []))}")
    for r in rb.get("head", [])[:6]:
        L.append(f"  - `{r['id']}` {r['stage']}: {snippet(r['error'], 160)}")
    L.append(f"- Not idempotent (second minify pass changes output): {len(corpus.get('idempotency_failures', []))}")
    for i in corpus.get("idempotency_failures", [])[:6]:
        L.append(f"  - `{i}`")
    L.append("")

    L.append("## 8. Real-world corpus")
    L.append("")
    size = corpus.get("size", [])
    if size:
        L.append("| File | Mode | Base bytes | Head bytes | Δ |")
        L.append("|---|---|---|---|---|")
        for s in size:
            L.append(f"| {s['name']} | {s['mode']} | {s['base']} | {s['head']} | {s['head'] - s['base']:+d} |")
    else:
        L.append("Not available (`lcr realworld`).")
    L.append("")

    L.append("## 9. Known failures in the touched areas (master baseline)")
    L.append("")
    base_line = read_json(cache_dir() / "baseline.json")
    if not base_line:
        L.append("No baseline yet (`lcr baseline`). Pre-existing failures are not attributed to the PR either way: only base→head transitions are.")
    else:
        touched = set(prep.get("areas", []))
        rows = sorted((pid, p) for pid, p in base_line["probes"].items() if p["area"] in touched and p["fails_on_master"])
        L.append(f"Master `{base_line['master'][:12]}`: {len(rows)} curated probe(s) in the touched areas fail today. A PR that changes them shows up in §4; these are listed so they are not mistaken for the PR's doing.")
        L.append("")
        for pid, p in rows[: th["max_listed_cases"]]:
            L.append(f"- `{pid}` ({p['known']}): fails {', '.join(p['fails_on_master'])}")
        if len(rows) > th["max_listed_cases"]:
            L.append(f"- _{len(rows) - th['max_listed_cases']} more in {cache_dir() / 'baseline.json'}_")
    L.append("")

    L.append("## 10. Coverage and limits")
    L.append("")
    L.append(f"- Stages: " + ", ".join(f"{k} {'✓' if v else '✗'}" for k, v in ev["stages"].items()))
    meta = oracle.get("dom", {})
    if meta:
        generic = sum(1 for m in meta.values() if m.get("dom", {}).get("generic"))
        unsupported = sum(m.get("dom", {}).get("unsupported", 0) for m in meta.values())
        L.append(f"- DOM synthesis: {len(meta)} case(s), {generic} fell back to the generic DOM, {unsupported} selector component(s) not synthesizable (pseudo-states are rewritten to attributes)")
    L.append("- The oracle proves equivalence only for the synthesized DOM and the engines listed above; Playwright WebKit is not Safari.")
    L.append("- Legacy checks run only for engines inside a case's targets; older targets are covered by compat data, not execution.")
    L.append("")
    spec = read_json(run_dir / "spec-cards.json") or {}
    cards = spec.get("cards", spec) if isinstance(spec, dict) else {}
    order = spec.get("order") or sorted(cards)
    cards = {n: cards[n] for n in order if n in cards}
    if cards:
        L.append("## Appendix A: spec cards for the touched properties (W3C webref)")
        L.append("")
        L.append("| Property | Syntax | Initial | Inherited | Computed value | Animation | Longhands |")
        L.append("|---|---|---|---|---|---|---|")
        missing = sorted(n for n, c in cards.items() if c.get("missing"))
        for name, c in cards.items():
            if c.get("missing"):
                continue
            L.append(f"| [`{name}`]({c.get('href')}) | `{md_cell(snippet(c.get('syntax'), 160))}` | {md_cell(snippet(c.get('initial'), 60))} | {c.get('inherited')} | {md_cell(snippet(c.get('computedValue'), 90))} | {md_cell(snippet(c.get('animationType'), 40))} | {', '.join(c.get('longhands') or []) or ''} |")
        if missing:
            L.append("")
            L.append("Not in any spec (legacy or vendor names handled by the same code): " + ", ".join(f"`{n}`" for n in missing))
        L.append("")
    L.append("## Reproduce")
    L.append("")
    num = pr.get("number", "<pr>")
    rid = prep["run_id"]
    L.append(fence("\n".join([f"lcr prepare {num}"] + [f"lcr {step} {rid}" for step in ("build", "corpus", "probe", "oracle", "worklist", "report")]), "sh"))
    L.append("")
    return "\n".join(L)


def report(run_dir: Path, allow_incomplete: bool = False) -> dict:
    ev = evaluate(run_dir)
    md = render(ev, run_dir)
    (run_dir / "report.md").write_text(md)
    data = {
        "schema": 1,
        "run_id": ev["prep"]["run_id"],
        "pr": ev["prep"].get("pr", {}).get("number"),
        "verdict": ev["verdict"],
        "counts": ev["counts"],
        "checks": ev["checks"],
        "findings": ev["findings"],
        "stages": ev["stages"],
        "base": ev["prep"]["base"],
        "head_tree": ev["prep"]["head_tree"],
        "engines": ev["oracle"].get("profiles", {}),
        "skill_version": skill_version(),
    }
    write_json(run_dir / "report.json", data)
    print(f"VERDICT: {ev['verdict']} ({', '.join(f'{v} {k.lower()}' for k, v in ev['counts'].items())})")
    print(run_dir / "report.md")
    return data


def summary(run_dir: Path) -> str:
    """The fixed chat summary (templates/summary.md.tmpl), filled from report.json."""
    rep = read_json(run_dir / "report.json")
    if not rep:
        raise LcrError("run `lcr report` first")
    prep = read_json(run_dir / "prepare.json") or {}
    corpus = read_json(run_dir / "corpus.json") or {}
    oracle = read_json(run_dir / "oracle.json") or {}
    analysis = read_json(run_dir / "analysis.json") or {}
    findings = [f for f in rep["findings"] if f["severity"] != "NOTE"][:6] or rep["findings"][:3]
    lines = []
    for i, f in enumerate(findings, 1):
        ev = (f.get("evidence") or [""])[0]
        lines.append(f"{i}. [{f['severity']}] {f['title']}" + (f" — {snippet(ev, 140)}" if ev else ""))
    engines = "; ".join(f"{p}: " + ", ".join(f"{k} {v}" for k, v in sorted(vs.items()) if k in ("chromium", "firefox", "webkit")) for p, vs in sorted((oracle.get("profiles") or {}).items(), key=lambda x: x[0] != "latest")) or "no browser run"
    deltas_total = sum((corpus.get("deltas") or {}).values())
    verified = sum(1 for cid, vs in (oracle.get("verdicts") or {}).items() if any(v["summary"]["latest"]["transition"] != "unverified" for v in vs))
    tmpl = (SKILL_DIR / "templates" / "summary.md.tmpl").read_text()
    text = tmpl.format(
        pr=rep.get("pr") or prep.get("range", ""),
        verdict=rep["verdict"],
        blocker=rep["counts"]["BLOCKER"], major=rep["counts"]["MAJOR"], minor=rep["counts"]["MINOR"], note=rep["counts"]["NOTE"],
        intent_summary=(analysis.get("intent") or {}).get("summary") or prep.get("pr", {}).get("title", ""),
        findings_list="\n".join(lines) or "None.",
        engines=engines,
        deltas_total=deltas_total,
        deltas_verified=verified,
        probes_pr=sum(1 for p in corpus.get("probes", []) if p.get("origin") == "pr"),
        mutations=(corpus.get("cases") or {}).get("mutation", 0),
        wpt_cases=(corpus.get("cases") or {}).get("wpt", 0),
        realworld_files=len({s["name"] for s in corpus.get("size", [])}),
        report_path=str(run_dir / "report.md"),
    )
    print(text)
    return text
