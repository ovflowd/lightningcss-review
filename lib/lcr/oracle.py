"""Stage 5: browser oracles. Selects the cases worth running in engines, then:

1. analysis image: prepare-jobs.mjs (DOM synthesis, state rewrite, validity probes)
2. reference engines (latest Chromium/Firefox/WebKit): engine-runner.cjs
3. legacy engines (older Playwright images), only for cases with targets: lowering checks
4. analysis image: compare.mjs -> verdicts.jsonl (fixed / regressed / both-equivalent / ...)
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

from .common import SKILL_DIR, LcrError, cache_dir, docker_run, load_config, log, read_json, read_jsonl, require_docker, write_json, write_jsonl
from .setup import browsers_tag, default_profiles, ensure_browsers

ORACLE_MOUNT = "/opt/lcr/oracle"


def outputs(run_dir: Path, side: str) -> dict:
    return {r["id"]: r for r in read_jsonl(run_dir / "corpus" / f"outputs-{side}.jsonl")}


def focus_css(run_dir: Path, base_code: str, head_code: str, limit: int = 40) -> str | None:
    """CSS made of the top-level blocks that differ between base and head output (both sides).
    Used to synthesize the DOM for large sheets, so the oracle looks at the elements the change
    affects instead of the first N selectors of the file."""
    from .adapter import run_requests
    from .mutations import split_top, join

    # Each side is pretty-printed by its own build: re-serializing base output with the head
    # build would apply head's serialization and hide exactly the difference we look for.
    req = lambda rid, css: {"id": rid, "kind": "sheet", "css": css, "minify": False, "compact": False, "targets": None, "error_recovery": True}
    pretty = {
        **run_requests(run_dir / "bin" / "base-adapter", [req("b", base_code)], workers=1),
        **run_requests(run_dir / "bin" / "head-adapter", [req("h", head_code)], workers=1),
    }
    GROUPING = ("@layer", "@media", "@supports", "@container", "@scope", "@starting-style", "@document", "@-moz-document")

    def leaves(css: str, ctx: tuple = ()) -> list[tuple]:
        """(context preludes, item) for every leaf rule, descending into grouping at-rules."""
        out = []
        for it in split_top(css) or []:
            if it["kind"] == "at-block" and it["prelude"].lower().startswith(GROUPING):
                inner = leaves(it["body"], ctx + (it["prelude"],))
                out += inner if inner else [(ctx, it)]
            else:
                out.append((ctx, it))
        return out

    key = lambda leaf: (leaf[0], leaf[1]["kind"], leaf[1]["prelude"], " ".join((leaf[1]["body"] or "").split()))
    lb = leaves(pretty["b"].get("code") or "")
    lh = leaves(pretty["h"].get("code") or "")
    kb, kh = {key(l) for l in lb}, {key(l) for l in lh}
    changed = [l for l in lh if key(l) not in kb] + [l for l in lb if key(l) not in kh]
    if not changed:
        return None

    def wrap(leaf) -> str:
        text = join([leaf[1]])
        for prelude in reversed(leaf[0]):
            text = f"{prelude} {{\n{text}}}\n"
        return text

    return "".join(wrap(l) for l in changed[:limit])


def select_cases(run_dir: Path, max_cases: int) -> tuple[list[dict], dict]:
    cases = {c["id"]: c for c in read_jsonl(run_dir / "corpus" / "cases.jsonl")}
    deltas = {d["id"] for d in read_jsonl(run_dir / "corpus" / "deltas.jsonl")}
    summary = read_json(run_dir / "corpus.json") or {}
    areas_meta = load_config("areas.json")["areas"]
    prep = read_json(run_dir / "prepare.json") or {}
    visual_areas = {a for a in prep.get("areas", []) + prep.get("radius_areas", []) if areas_meta.get(a, {}).get("visual")}
    base, head = outputs(run_dir, "base"), outputs(run_dir, "head")
    from .prepare import test_area_map

    tmap = test_area_map()
    chosen, reasons = {}, {}

    def want(cid, reason):
        if cid in cases and cid not in chosen:
            chosen[cid] = cases[cid]
            reasons[cid] = reason

    # Priority order (deterministic): PR probes, new/changed test expectations, tuple deltas,
    # curated probe deltas, WPT deltas, real-world deltas.
    for c in sorted(cases.values(), key=lambda c: c["id"]):
        if c["source"] == "probe" and c.get("origin") == "pr":
            want(c["id"], "pr-probe")
    for c in sorted(cases.values(), key=lambda c: c["id"]):
        if c["source"] == "tuple" and c["side"] == "head":
            want(c["id"], "new-or-changed-test")
    for c in sorted(cases.values(), key=lambda c: c["id"]):
        if c["source"] == "mutation":
            want(c["id"], "mutation")
    for key in ("modified", "removed_changed"):
        for entry in summary.get("tuples", {}).get(key, []):
            want(entry["id"], f"tuple-{key}")
    for source in ("tuple", "probe", "wpt", "realworld"):
        for cid in sorted(deltas):
            if cases.get(cid, {}).get("source") == source:
                want(cid, f"{source}-delta")
    selected = list(chosen.values())
    dropped = max(0, len(selected) - max_cases)
    if dropped:
        log(f"oracle: {len(selected)} candidate cases, keeping the first {max_cases} by priority; {dropped} not run (raise --max-cases to include them)")
        selected = selected[:max_cases]

    oracle_cases = []
    for c in selected:
        b, h = base.get(c["id"], {}), head.get(c["id"], {})
        req = c["request"]
        if req.get("kind") == "value":
            # property_range_test cases: judge the declaration with the CSSOM property check.
            exp = c.get("expectation") or {}
            out = lambda r: f"{req['property']}: {r['code']}" if r.get("ok") and r.get("recognition") == "typed" else (f"{req['property']}: {req['value']}" if r.get("ok") else None)
            oracle_cases.append({
                "id": c["id"], "kind": "property", "property": req["property"], "value": req["value"],
                "wptKind": "invalid" if exp.get("type") == "value-unparsed" else "valid", "expected": None,
                "outputs": {"base": out(b), "head": out(h)}, "targets": None,
            })
            continue
        if req.get("kind") == "property":
            w = c.get("wpt", {})
            oracle_cases.append({
                "id": c["id"], "kind": "property", "property": req["property"], "value": req["value"],
                "wptKind": w.get("kind", "valid"), "expected": w.get("expected"),
                "outputs": {"base": b.get("code") if b.get("ok") else None, "head": h.get("code") if h.get("ok") else None},
                "targets": req.get("targets"),
            })
            continue
        if req.get("kind") == "attr":
            wrap = lambda css: f"#lcr-attr{{{css}}}" if css is not None else None
            sheets = {"input": wrap(req["css"]), "base": wrap(b.get("code") if b.get("ok") else None), "head": wrap(h.get("code") if h.get("ok") else None)}
            dom = '<div id="lcr-attr">x</div>'
        else:
            if req.get("css_modules"):
                continue  # renamed identifiers: computed-style comparison would be meaningless
            sheets = {"input": req["css"], "base": b.get("code") if b.get("ok") else None, "head": h.get("code") if h.get("ok") else None}
            dom = (c.get("probe") or {}).get("dom") or (cases.get(c.get("parent"), {}).get("probe") or {}).get("dom")
            if c["source"] == "wpt":
                dom = '<div class="t">x</div>'
            dom_from = None
            if not dom and sheets["base"] and sheets["head"] and len(req["css"]) > 20000:
                dom_from = focus_css(run_dir, sheets["base"], sheets["head"])

        if sheets["base"] is None and sheets["head"] is None:
            continue
        area = c.get("area") or (c.get("probe") or {}).get("area")
        test_name = c.get("test") or (cases.get(c.get("parent"), {}) or {}).get("test")
        test_areas = set(tmap.get(test_name.split("::")[-1], [])) if test_name else set()
        if test_areas & {a for a, m in areas_meta.items() if m.get("visual")}:
            area = area or sorted(test_areas)[0]
            c = {**c, "_visual_test": True}
        oracle_cases.append({
            "id": c["id"], "kind": "sheet", "sheets": sheets, "targets": req.get("targets"), "dom": dom, "domFrom": dom_from,
            "visual": bool(c.get("_visual_test") or area in visual_areas or (area and areas_meta.get(area, {}).get("visual"))) and c["source"] != "realworld",
        })
    stats = {"candidates": len(chosen), "selected": len(selected), "dropped": dropped, "by_reason": {}}
    for cid in [c["id"] for c in selected]:
        stats["by_reason"][reasons[cid]] = stats["by_reason"].get(reasons[cid], 0) + 1
    return oracle_cases, stats


def run_oracle(out: Path, cases: list[dict], wanted: list[str], env: dict, env_path: Path) -> dict:
    """Run the engine pipeline for prepared oracle cases in `out`; returns {verdicts, profiles, dom}."""
    write_jsonl(out / "cases.jsonl", cases)
    shutil.copyfile(env_path, out / "env.json")
    analysis = ensure_browsers("latest")
    mounts = [(SKILL_DIR / "oracle", ORACLE_MOUNT, "ro"), (out, "/run", "rw")]

    def node(image, script_args, timeout=7200):
        proc = docker_run(image, ["node", *script_args], mounts=mounts, check=False, timeout=timeout)
        if proc.returncode != 0:
            raise LcrError(f"{script_args[0]} failed in {image}:\n{(proc.stdout + proc.stderr)[-3000:]}")
        return proc

    log(f"oracle: preparing {len(cases)} cases")
    node(analysis, [f"{ORACLE_MOUNT}/prepare-jobs.mjs", "--cases", "/run/cases.jsonl", "--out", "/run/jobs.jsonl", "--meta", "/run/jobs.meta.jsonl"])
    jobs_count = sum(1 for _ in (out / "jobs.jsonl").open())
    log(f"oracle: {jobs_count} jobs in reference engines ({', '.join(env['profiles']['latest']['versions'].get(k, '?') for k in ('chromium', 'firefox', 'webkit'))})")
    node(analysis, [f"{ORACLE_MOUNT}/engine-runner.cjs", "--jobs", "/run/jobs.jsonl", "--out", "/run/results-latest.jsonl", "--screenshots", "/run/shots"])
    results_args = ["--results", "latest=/run/results-latest.jsonl"]
    targeted = sorted(c["id"] for c in cases if c["kind"] == "sheet" and c.get("targets"))
    ran_profiles = {"latest": env["profiles"]["latest"]["versions"]}
    if targeted:
        node(analysis, [f"{ORACLE_MOUNT}/prepare-jobs.mjs", "--legacy", "--jobs", "/run/jobs.jsonl", "--results", "/run/results-latest.jsonl", "--out", "/run/legacy-jobs.jsonl", "--ids", ",".join(targeted)])
        for profile in wanted:
            if profile == "latest":
                continue
            if profile not in env["profiles"]:
                log(f"oracle: profile {profile} not set up; skipping (run `lcr setup --profiles {profile}`)")
                continue
            tag = browsers_tag(profile)
            log(f"oracle: {len(targeted)} lowering cases in {profile} ({', '.join(env['profiles'][profile]['versions'].get(k, '?') for k in ('chromium', 'firefox', 'webkit'))})")
            node(tag, [f"{ORACLE_MOUNT}/engine-runner.cjs", "--jobs", "/run/legacy-jobs.jsonl", "--out", f"/run/results-{profile}.jsonl"])
            results_args += ["--results", f"{profile}=/run/results-{profile}.jsonl"]
            ran_profiles[profile] = env["profiles"][profile]["versions"]
    node(analysis, [f"{ORACLE_MOUNT}/compare.mjs", "--cases", "/run/cases.jsonl", "--jobs", "/run/jobs.jsonl", "--env", "/run/env.json", "--out", "/run/verdicts.jsonl", "--shots", "/run/shots", *results_args])
    verdicts = {}
    for v in read_jsonl(out / "verdicts.jsonl"):
        verdicts.setdefault(v["case"], []).append(v)
    meta = {m["id"]: m for m in read_jsonl(out / "jobs.meta.jsonl")}
    return {"verdicts": verdicts, "profiles": ran_profiles, "dom": meta}


def _env(profiles: str | None):
    require_docker()
    env_path = cache_dir() / "env.json"
    env = read_json(env_path)
    if not env or "latest" not in env.get("profiles", {}):
        raise LcrError("engines not set up; run `lcr setup`")
    wanted = profiles.split(",") if profiles else default_profiles()
    return env, env_path, wanted


def oracle(run_dir: Path, profiles: str | None = None, max_cases: int = 4000) -> dict:
    env, env_path, wanted = _env(profiles)
    out = run_dir / "oracle"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    cases, stats = select_cases(run_dir, max_cases)
    if not cases:
        write_json(run_dir / "oracle.json", {"stats": stats, "verdicts": {}, "profiles": {}})
        log("oracle: nothing to verify")
        return {}
    result = run_oracle(out, cases, wanted, env, env_path)
    summary = {"stats": stats, **result}
    write_json(run_dir / "oracle.json", summary)
    from .spec import spec_cards

    spec_cards(run_dir)
    counts = {}
    for vs in result["verdicts"].values():
        for v in vs:
            t = v["summary"]["latest"]["transition"]
            counts[t] = counts.get(t, 0) + 1
    log(f"oracle: transitions {counts}")
    return summary


def selftest(profiles: str | None = None) -> int:
    """Known-answer cases (oracle/test/selftest.jsonl) through every engine profile."""
    env, env_path, wanted = _env(profiles)
    cases = read_jsonl(SKILL_DIR / "oracle" / "test" / "selftest.jsonl")
    expect = {c["id"]: c.pop("expect") for c in cases}
    out = cache_dir() / "selftest"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    result = run_oracle(out, cases, wanted, env, env_path)
    failures = 0
    for cid, exp in expect.items():
        got = {}
        for v in result["verdicts"].get(cid, []):
            suffix = "~dark" if v.get("scheme") == "dark" else ""
            got["latest" + suffix] = v["summary"]["latest"]["transition"]
            got["rejectedHead" + suffix] = v["summary"]["latest"]["rejectedHead"] > v["summary"]["latest"]["rejectedBase"]
            for prof, ls in v["summary"].get("legacy", {}).items():
                got[prof + suffix] = ls["transition"]
        bad = {k: (want, got.get(k)) for k, want in exp.items() if got.get(k) != want}
        status = "ok  " if not bad else "FAIL"
        failures += bool(bad)
        print(f"{status} {cid:32} " + ", ".join(f"{k}={got.get(k)}" for k in exp) + (f"   expected {bad}" if bad else ""))
    print(f"{len(expect) - failures}/{len(expect)} self-test cases pass ({', '.join(result['profiles'])})")
    return 1 if failures else 0


def baseline(profiles: str | None = None) -> Path:
    """Run every curated probe on current master through the oracle: which probes fail on master
    today (context for reports, ground truth for probe triage). Writes <cache>/baseline.json."""
    from .build import build
    from .corpus import corpus
    from .prepare import prepare

    env, env_path, wanted = _env(profiles)
    run_dir = prepare(local_range="refs/lcr/master..refs/lcr/master")
    if not (run_dir / "bin" / "head-adapter").exists():
        build(run_dir)
    summary = corpus(run_dir, wpt="none", realworld="none")
    cases = {c["id"]: c for c in read_jsonl(run_dir / "corpus" / "cases.jsonl")}
    head = outputs(run_dir, "head")
    oracle_cases = []
    for cid, c in sorted(cases.items()):
        if c["source"] != "probe" or c["request"].get("kind") != "sheet" or c["request"].get("css_modules"):
            continue
        h = head.get(cid, {})
        if not h.get("ok"):
            continue
        dom = (c.get("probe") or {}).get("dom")
        oracle_cases.append({"id": cid, "kind": "sheet", "sheets": {"input": c["request"]["css"], "base": h["code"], "head": h["code"]}, "targets": c["request"].get("targets"), "dom": dom, "visual": False})
    out = run_dir / "oracle"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    result = run_oracle(out, oracle_cases, wanted, env, env_path)
    write_json(run_dir / "oracle.json", {"stats": {"candidates": len(oracle_cases), "selected": len(oracle_cases), "dropped": 0, "by_reason": {"baseline": len(oracle_cases)}}, **result})
    probes = {}
    asserts = {p["id"]: p for p in summary.get("probes", [])}
    for cid, c in sorted(cases.items()):
        if c["source"] != "probe":
            continue
        a = asserts.get(cid, {}).get("assert", {}).get("head", {})
        vs = result["verdicts"].get(cid, [])
        entry = {
            "probe": c["probe"]["id"], "area": c["probe"]["area"], "known": c["probe"]["known"], "path": c["probe"]["path"],
            "expect": c["probe"]["expect"], "asserts": a, "stage": None if head.get(cid, {}).get("ok") else head.get(cid, {}).get("stage"),
            "latest": {v.get("scheme"): v["summary"]["latest"]["head"] for v in vs},
            "legacy": {f"{p}{'~dark' if v.get('scheme') == 'dark' else ''}": ls["head"] for v in vs for p, ls in v["summary"].get("legacy", {}).items()},
        }
        failed = [k for k, ok in a.items() if ok is False]
        expect = c["probe"]["expect"]
        if "idempotent" in expect and not summary.get("idempotency", {}).get(cid, {}).get("stable", True):
            failed.append("idempotent")
        if "equivalent" in expect and entry["stage"] and "parse-error" not in expect:
            failed.append("equivalent")  # master rejects the input, so it cannot be equivalent
        if "equivalent" in c["probe"]["expect"] and any(s == "different" for s in entry["latest"].values()):
            failed.append("equivalent")
        if "equivalent" in c["probe"]["expect"] and any(s == "different" for s in entry["legacy"].values()):
            failed.append("equivalent-legacy")
        entry["fails_on_master"] = sorted(set(failed))
        probes[c["probe"]["id"]] = entry
    data = {"master": read_json(run_dir / "prepare.json")["base"], "profiles": result["profiles"], "probes": probes}
    path = cache_dir() / "baseline.json"
    write_json(path, data)
    failing = sum(1 for p in probes.values() if p["fails_on_master"])
    log(f"baseline: {len(probes)} probes, {failing} fail on master {data['master'][:12]} -> {path}")
    return path
