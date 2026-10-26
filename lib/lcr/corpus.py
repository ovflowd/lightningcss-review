"""Stage 3: differential runs. Every case goes through the base and head adapters with identical
options; any normalized difference is a behavioral delta. Sources:

- tuples: every test-helper call recorded from base and head `cargo test` (the PR's own tests and
  every existing expectation),
- probes: curated edge cases (corpus/probes) plus PR-specific ones (<run>/probes),
- wpt: the WPT property-value corpus (lightningcss#1328 extraction), print/minify/lower-minify,
- realworld: pinned framework stylesheets (also used for minified-size deltas).
"""
from __future__ import annotations

import os
import re
from pathlib import Path

from .adapter import normalize_response, run_requests
from .common import LcrError, SKILL_DIR, load_config, log, preflight_disk, read_json, read_jsonl, sha256, stable_id, write_json, write_jsonl
from .probes import curated_dirs, load_probes
from .targets import feature_bits, format_targets, parse_targets
from .tuples import load_tuples, mapping_problem, matches_expectation, to_requests
from .wpt import load_fixtures
from .mutations import mutation_cases


def mode_request(mode_name: str) -> dict:
    modes = load_config("modes.json")["modes"]
    m = modes[mode_name]
    return {"minify": m["minify"], "compact": m["compact"], "targets": parse_targets(m["targets"])}


def in_ranges(line: int | None, ranges: list[list[int]]) -> bool:
    return line is not None and any(a <= line <= b for a, b in ranges)


def tuple_cases(run_dir: Path, prep: dict) -> tuple[list[dict], dict]:
    tb = load_tuples(run_dir / "build" / "base" / "tuples.jsonl")
    th = load_tuples(run_dir / "build" / "head" / "tuples.jsonl")
    bits = {"base": feature_bits(run_dir / "src" / "base"), "head": feature_bits(run_dir / "src" / "head")}
    lib_hunks = prep["files"].get("src/lib.rs", {"head": [], "base": []})
    cases, unmappable = [], []
    for ident in sorted(set(tb) | set(th)):
        side = "both" if ident in tb and ident in th else ("head" if ident in th else "base")
        t = th.get(ident) or tb.get(ident)
        reqs = to_requests(t, bits["head" if ident in th else "base"])
        line_side = "head" if ident in th else "base"
        if reqs is None:
            unmappable.append({"helper": t["helper"], "test": t["test"], "line": t["line"], "side": side, "in_diff": in_ranges(t["line"], lib_hunks[line_side]), "reason": mapping_problem(t)})
            continue
        for suffix, req, exp in reqs:
            cases.append({
                "id": f"t-{ident}" + (f"-{suffix}" if suffix else ""),
                "source": "tuple",
                "side": side,
                "helper": t["helper"],
                "test": t["test"],
                "line": t["line"],
                "line_side": line_side,
                "in_diff": in_ranges(t["line"], lib_hunks[line_side]),
                "request": req,
                "expectation": exp,
                "tuple": t,
                "suffix": suffix,
            })
    stats = {"base_tuples": len(tb), "head_tuples": len(th), "unmappable": len(unmappable), "unmappable_helpers": sorted({u["helper"] for u in unmappable}), "unmappable_cases": unmappable}
    return cases, stats


def rejected_tuples(cases: list[dict], head: dict) -> list[dict]:
    """Tuples the head adapter refused as a request (a flag or option it cannot express): they are
    unmappable too, with the adapter's reason."""
    out = []
    for c in cases:
        if c["source"] != "tuple" or c["side"] == "base":
            continue
        r = head.get(c["id"], {})
        if r.get("stage") == "request":
            out.append({"helper": c["helper"], "test": c["test"], "line": c["line"], "side": c["side"], "in_diff": c["in_diff"], "reason": f"adapter rejected the request: {(r.get('error') or '')[:200]}", "id": c["id"]})
    return out


def sort_unmappable(rows: list[dict]) -> list[dict]:
    """In-diff tuples first; repeated calls from one line collapse into one row with a count."""
    merged: dict[tuple, dict] = {}
    for u in rows:
        key = (not u["in_diff"], u["test"], u["line"] or 0, u["helper"], u.get("id", ""), u["reason"], u["side"])
        if key in merged:
            merged[key]["count"] += 1
        else:
            merged[key] = {**u, "count": 1}
    return [merged[k] for k in sorted(merged)]


def probe_cases(run_dir: Path) -> tuple[list[dict], list[str]]:
    dirs = curated_dirs() + [(run_dir / "probes", "pr")]
    probes, problems = load_probes(dirs)
    cases = []
    for p in probes:
        cases.append({
            "id": f"p-{p.id}",
            "source": "probe",
            "origin": p.origin,
            "probe": {"id": p.id, "area": p.area, "title": p.title, "mode": p.mode, "targets": p.targets_text, "expect": p.expect, "known": p.known, "refs": p.refs, "path": str(p.path), "dom": p.dom, "note": p.note, "repro": p.repro},
            "area": p.area,
            "request": p.request(),
            **({"timeout": p.timeout} if p.timeout else {}),
        })
    return cases, problems


def probe_files_hash(run_dir: Path) -> str:
    """Fingerprint of <run>/probes, so a stale probe or oracle stage can be detected."""
    root = run_dir / "probes"
    files = sorted(root.rglob("*.css")) if root.exists() else []
    return sha256("\n".join(f"{f.relative_to(root)}\0{sha256(f.read_bytes())}" for f in files))


def wpt_cases(prep: dict, selection: str) -> list[dict]:
    if selection == "none":
        return []
    fixtures = load_fixtures()
    if not fixtures:
        log("WPT fixtures missing; run `lcr wpt` once to enable the WPT lane")
        return []
    matrix = load_config("modes.json")["matrix"]["wpt"]
    cases = []
    for case in fixtures["cases"]:
        for mode in matrix:
            mreq = mode_request(mode)
            if mreq["targets"]:
                # StyleAttribute skips logical lowering, @supports fallbacks and dark-mode rules
                # (context.rs: should_compile_logical / add_conditional_property), so lowering
                # modes go through a real style rule.
                if any(ch in case["value"] for ch in "{};"):
                    continue
                req = {"kind": "sheet", "css": f".t{{{case['property']}:{case['value']}}}", **mreq}
            else:
                req = {"kind": "property", "property": case["property"], "value": case["value"], **mreq}
            cases.append({
                "id": f"w-{stable_id(case['id'], mode)}",
                "source": "wpt",
                "wpt": {"id": case["id"], "file": case["file"], "kind": case["kind"], "property": case["property"], "value": case["value"], "expected": case.get("expected")},
                "mode": mode,
                "request": req,
            })
    return cases


def realworld_cases(selection: str) -> list[dict]:
    if selection == "none":
        return []
    from .realworld import available_files

    matrix = load_config("modes.json")["matrix"]["realworld"]
    cases = []
    for name, path in available_files():
        css = path.read_text(errors="replace")
        for mode in matrix:
            cases.append({
                "id": f"r-{name}-{mode}",
                "source": "realworld",
                "name": name,
                "mode": mode,
                "request": {"kind": "sheet", "css": css, "error_recovery": True, **mode_request(mode)},
            })
    return cases


CRASH_STAGES = ("panic", "crash", "timeout")
UNKNOWN_FLAG_RE = re.compile(r"unknown parser flag (\S+)")


def assess_probe(case: dict, base: dict, head: dict) -> dict:
    """Non-browser assertions of a probe (equivalence is decided by the oracle)."""
    out = {}
    for side, resp in (("base", base), ("head", head)):
        checks = {}
        for exp in case["probe"]["expect"]:
            if exp == "no-panic":
                checks[exp] = resp.get("stage") not in CRASH_STAGES
            elif exp == "parse-error":
                checks[exp] = (not resp.get("ok")) and resp.get("stage") == "parse"
            elif exp.startswith("output-"):
                kind, _, text = exp.partition(":")
                text = text[1:-1] if text.startswith('"') and text.endswith('"') else text
                text = text.encode().decode("unicode_escape") if "\\" in text else text
                code = resp.get("code") if resp.get("ok") else None
                if code is None:
                    checks[exp] = False
                elif kind == "output-contains":
                    checks[exp] = text in code
                elif kind == "output-not-contains":
                    checks[exp] = text not in code
                elif kind == "output-equals":
                    checks[exp] = code.strip() == text.strip()
            elif exp in ("equivalent", "idempotent"):
                checks[exp] = None  # idempotent: filled after the idempotency pass; equivalent: by the report from the oracle
        out[side] = checks
    return out


def probe_entry(case: dict, base: dict, head: dict, changed: bool) -> dict:
    entry = {"id": case["id"], "probe": case["probe"]["id"], "origin": case["origin"], "known": case["probe"]["known"], "repro": case["probe"].get("repro"), "changed": changed, "assert": assess_probe(case, base, head)}
    crash = {side: resp.get("stage") for side, resp in (("base", base), ("head", head)) if resp.get("stage") in CRASH_STAGES}
    if crash:
        entry["crash"] = crash
    return entry


def fill_idempotent(probes_out, idem: dict, idem_base: dict) -> None:
    for p in probes_out:
        for side, data in (("head", idem), ("base", idem_base)):
            checks = p["assert"].get(side, {})
            if "idempotent" in checks:
                entry = data.get(p["id"])
                checks["idempotent"] = entry["stable"] if entry else None


def flag_only(cases: list[dict], base: dict, head: dict) -> dict[str, list[str]]:
    """Requests base refuses (a flag or option it does not know) and head accepts: the PR adds
    that flag, so these cases exist only on head. flag -> [case id]."""
    out: dict[str, list[str]] = {}
    for c in cases:
        b, h = base.get(c["id"], {}), head.get(c["id"], {})
        if b.get("stage") != "request" or not h or h.get("stage") == "request":
            continue
        m = UNKNOWN_FLAG_RE.search(b.get("error") or "")
        out.setdefault(m.group(1) if m else (b.get("error") or "request error")[:80], []).append(c["id"])
    return {k: sorted(v) for k, v in sorted(out.items())}


def merge_flag_only(old: dict, new: dict, drop: set) -> dict:
    merged: dict[str, set] = {}
    for src in (old, new):
        for flag, ids in src.items():
            merged.setdefault(flag, set()).update(i for i in ids if src is new or i not in drop)
    return {k: sorted(v) for k, v in sorted(merged.items()) if v}


def run_all(run_dir: Path, cases: list[dict], label: str) -> tuple[dict, dict]:
    base_bin = run_dir / "bin" / "base-adapter"
    head_bin = run_dir / "bin" / "head-adapter"
    if not base_bin.exists() or not head_bin.exists():
        raise LcrError("adapters missing; `lcr build` must succeed for both sides first")
    reqs = [{"id": c["id"], **c["request"], **({"_timeout": c["timeout"]} if c.get("timeout") else {})} for c in cases]
    workers = max(2, (os.cpu_count() or 4) // 2)
    log(f"{label}: {len(reqs)} requests x 2 builds")
    base = run_requests(base_bin, reqs, workers=workers, label=f"{label}/base")
    head = run_requests(head_bin, reqs, workers=workers, label=f"{label}/head")
    return base, head


def idempotency_requests(cases: list[dict], outputs: dict) -> list[dict]:
    reqs = []
    for c in cases:
        r = outputs.get(c["id"])
        req = c["request"]
        if not r or not r.get("ok") or req.get("kind") != "sheet" or req.get("css_modules") is not None:
            continue
        if not req.get("minify") and "idempotent" not in (c.get("probe") or {}).get("expect", []):
            continue
        reqs.append({"id": c["id"], **req, "css": r["code"], **({"_timeout": c["timeout"]} if c.get("timeout") else {})})
    return reqs


def idempotency(run_dir: Path, cases: list[dict], outputs: dict, side: str = "head") -> dict:
    """Second pass on one side's output with that side's build and the same options: a stable
    minifier changes nothing."""
    reqs = idempotency_requests(cases, outputs)
    if not reqs:
        return {}
    second = run_requests(run_dir / "bin" / f"{side}-adapter", reqs, label=f"idempotency/{side}")
    out = {}
    for req in reqs:
        first = outputs[req["id"]]["code"]
        again = second.get(req["id"], {})
        out[req["id"]] = {"stable": bool(again.get("ok")) and again.get("code") == first, "second": again.get("code") if again.get("ok") else again.get("error")}
    return out


def idempotency_split(idem: dict, idem_base: dict) -> tuple[list[str], list[str]]:
    """(failures, preexisting): head unstable while base is stable or has no output to re-run, vs
    unstable on both sides."""
    failures, preexisting = [], []
    for cid, v in idem.items():
        if v["stable"]:
            continue
        b = idem_base.get(cid)
        (preexisting if b is not None and not b["stable"] else failures).append(cid)
    return sorted(failures), sorted(preexisting)


def disk_need(cases: list[dict]) -> int:
    """Bytes a corpus pass writes: inputs, both outputs and deltas, plus headroom."""
    return (100 << 20) + 4 * sum(len(c["request"].get("css") or "") + 200 for c in cases)


def corpus(run_dir: Path, wpt: str = "auto", realworld: str = "auto") -> dict:
    prep = read_json(run_dir / "prepare.json")
    build = read_json(run_dir / "build.json")
    if not prep or not build:
        raise LcrError("run `lcr prepare` and `lcr build` first")
    tcases, tstats = tuple_cases(run_dir, prep)
    pcases, problems = probe_cases(run_dir)
    wcases = wpt_cases(prep, wpt)
    rcases = realworld_cases(realworld)
    # Metamorphic variants of what the PR itself tests (new/changed test inputs, PR probes).
    parents = [c for c in tcases if c["side"] == "head"] + [c for c in pcases if c.get("origin") == "pr"]
    mcases = mutation_cases(parents)
    cases = tcases + pcases + mcases + wcases + rcases
    preflight_disk(run_dir, disk_need(cases), "corpus")
    base, head = run_all(run_dir, cases, "corpus")

    deltas, robustness = [], {"base": [], "head": []}
    tuple_report = {"head_mismatch": [], "new_failing_on_base": [], "new_passing_on_base": [], "modified": [], "removed_changed": [], "removed_same": [], "base_mismatch": []}
    probes_out = []
    size = []
    # A changed expectation shows up as a base-only tuple and a head-only tuple with the same helper,
    # input and options; pair them so the report can show old -> new.
    def pair_key(c):
        f = dict(c["tuple"]["fields"])
        f.pop("expected", None)
        f.pop("error", None)
        if c["helper"] == "property_range_test":
            return (c["helper"], c["request"].get("property"), c["request"].get("value"))
        return (c["helper"], stable_id(f), c.get("suffix", ""))

    by_key = {}
    for c in tcases:
        if c["side"] == "head":
            by_key[pair_key(c)] = c
    for c in cases:
        b, h = base.get(c["id"], {}), head.get(c["id"], {})
        nb, nh = normalize_response(b), normalize_response(h)
        for side, resp in (("base", b), ("head", h)):
            if resp.get("stage") in CRASH_STAGES:
                robustness[side].append({"id": c["id"], "source": c["source"], "stage": resp.get("stage"), "error": (resp.get("error") or "")[:300]})
        changed = nb != nh
        if changed:
            deltas.append({"id": c["id"], "source": c["source"], "base": nb, "head": nh})
        if c["source"] == "tuple":
            hb, hh = matches_expectation(c["expectation"], b), matches_expectation(c["expectation"], h)
            entry = {"id": c["id"], "helper": c["helper"], "test": c["test"], "line": c["line"], "in_diff": c["in_diff"]}
            if c["side"] in ("both", "head") and hh is False:
                tuple_report["head_mismatch"].append({**entry, "got": h.get("code") or h.get("error")})
            if c["side"] == "both" and hb is False:
                tuple_report["base_mismatch"].append(entry)
            if c["side"] == "head" and hh:
                (tuple_report["new_failing_on_base"] if hb is False else tuple_report["new_passing_on_base"]).append(entry)
            if c["side"] == "base":
                partner = by_key.get(pair_key(c))
                if partner:
                    tuple_report["modified"].append({**entry, "head_id": partner["id"], "head_line": partner["line"]})
                elif hh is False:
                    tuple_report["removed_changed"].append(entry)
                else:
                    tuple_report["removed_same"].append(entry)
        elif c["source"] == "probe":
            probes_out.append(probe_entry(c, b, h, changed))
        elif c["source"] == "realworld" and b.get("ok") and h.get("ok"):
            size.append({"name": c["name"], "mode": c["mode"], "base": len(b["code"].encode()), "head": len(h["code"].encode())})

    delta_ids = {d["id"] for d in deltas}
    idem_targets = [c for c in cases if c["source"] in ("probe", "tuple", "mutation") and (c["id"] in delta_ids or c["source"] in ("probe", "mutation"))]
    idem = idempotency(run_dir, idem_targets, head, "head")
    idem_base = idempotency(run_dir, idem_targets, base, "base")
    idem_failures, idem_preexisting = idempotency_split(idem, idem_base)
    fill_idempotent(probes_out, idem, idem_base)
    unmappable = sort_unmappable(tstats["unmappable_cases"] + rejected_tuples(tcases, head))
    tstats.update({"unmappable": sum(u["count"] for u in unmappable), "unmappable_helpers": sorted({u["helper"] for u in unmappable}), "unmappable_cases": unmappable})

    write_jsonl(run_dir / "corpus" / "cases.jsonl", ({k: v for k, v in c.items() if k != "tuple"} for c in cases))
    write_jsonl(run_dir / "corpus" / "outputs-base.jsonl", ({"id": k, **v} for k, v in base.items()))
    write_jsonl(run_dir / "corpus" / "outputs-head.jsonl", ({"id": k, **v} for k, v in head.items()))
    write_jsonl(run_dir / "corpus" / "deltas.jsonl", deltas)
    counts = {}
    for c in cases:
        counts[c["source"]] = counts.get(c["source"], 0) + 1
    delta_counts = {}
    for d in deltas:
        delta_counts[d["source"]] = delta_counts.get(d["source"], 0) + 1
    summary = {
        "cases": counts,
        "deltas": delta_counts,
        "tuple_stats": tstats,
        "tuples": {k: v for k, v in tuple_report.items()},
        "robustness": robustness,
        "idempotency_failures": idem_failures,
        "idempotency_preexisting": idem_preexisting,
        "idempotency": idem,
        "idempotency_base": idem_base,
        "flag_only": flag_only(cases, base, head),
        "probes": probes_out,
        "probe_problems": problems,
        "probe_files": probe_files_hash(run_dir),
        "size": sorted(size, key=lambda s: (s["name"], s["mode"])),
    }
    write_json(run_dir / "corpus.json", summary)
    log(f"deltas: {delta_counts or 'none'}; robustness head={len(robustness['head'])} base={len(robustness['base'])}; tuple changes: "
        + ", ".join(f"{k}={len(v)}" for k, v in tuple_report.items() if v))
    return summary


def pr_probe_case_ids(cases: dict) -> set[str]:
    """PR probe cases and their mutations (mutation parents are head tuples or PR probes)."""
    return {
        cid for cid, c in cases.items()
        if (c["source"] == "probe" and c.get("origin") == "pr") or (c["source"] == "mutation" and str(c.get("parent", "")).startswith("p-"))
    }


def run_probes(run_dir: Path) -> dict:
    """Re-run only probes (after the agent wrote <run>/probes), merging into corpus.json. The PR
    probe set is rebuilt from the files: cases of deleted probes leave the corpus and the oracle."""
    summary = read_json(run_dir / "corpus.json")
    if not summary:
        raise LcrError("run `lcr corpus` first")
    pcases, problems = probe_cases(run_dir)
    pr_cases = [c for c in pcases if c["origin"] == "pr"]
    pr_cases += mutation_cases(pr_cases)
    if problems:
        for p in problems:
            log(f"probe problem: {p}")
    if not pr_cases:
        log("no PR probes found in <run>/probes")
    preflight_disk(run_dir, disk_need(pr_cases), "probe")
    base, head = run_all(run_dir, pr_cases, "probes") if pr_cases else ({}, {})
    existing = {c["id"]: c for c in read_jsonl(run_dir / "corpus" / "cases.jsonl")}
    new_ids = {c["id"] for c in pr_cases}
    old_ids = pr_probe_case_ids(existing)
    stale = sorted(old_ids - new_ids)
    replaced = old_ids | new_ids
    for cid in replaced:
        existing.pop(cid, None)
    for c in pr_cases:
        existing[c["id"]] = c
    write_jsonl(run_dir / "corpus" / "cases.jsonl", existing.values())
    for name, out in (("base", base), ("head", head)):
        rows = {r["id"]: r for r in read_jsonl(run_dir / "corpus" / f"outputs-{name}.jsonl") if r["id"] not in replaced}
        rows.update({k: {"id": k, **v} for k, v in out.items()})
        write_jsonl(run_dir / "corpus" / f"outputs-{name}.jsonl", rows.values())
    deltas = {d["id"]: d for d in read_jsonl(run_dir / "corpus" / "deltas.jsonl") if d["id"] not in replaced}
    probes_out = {p["id"]: p for p in summary["probes"] if p["id"] not in replaced}
    robustness = {side: [r for r in summary["robustness"].get(side, []) if r["id"] not in replaced] for side in ("base", "head")}
    fresh = []
    for c in pr_cases:
        b, h = base.get(c["id"], {}), head.get(c["id"], {})
        nb, nh = normalize_response(b), normalize_response(h)
        if nb != nh:
            deltas[c["id"]] = {"id": c["id"], "source": c["source"], "base": nb, "head": nh}
        if c["source"] == "probe":
            entry = probe_entry(c, b, h, nb != nh)
            probes_out[c["id"]] = entry
            fresh.append(entry)
        for side, resp in (("base", b), ("head", h)):
            if resp.get("stage") in CRASH_STAGES:
                robustness[side].append({"id": c["id"], "source": c["source"], "stage": resp.get("stage"), "error": (resp.get("error") or "")[:300]})
    summary["robustness"] = robustness
    idem = {k: v for k, v in summary.get("idempotency", {}).items() if k not in replaced}
    idem_base = {k: v for k, v in summary.get("idempotency_base", {}).items() if k not in replaced}
    new_idem, new_idem_base = idempotency(run_dir, pr_cases, head, "head"), idempotency(run_dir, pr_cases, base, "base")
    idem.update(new_idem)
    idem_base.update(new_idem_base)
    fill_idempotent(fresh, new_idem, new_idem_base)
    summary["idempotency"] = dict(sorted(idem.items()))
    summary["idempotency_base"] = dict(sorted(idem_base.items()))
    summary["idempotency_failures"], summary["idempotency_preexisting"] = idempotency_split(idem, idem_base)
    summary["flag_only"] = merge_flag_only(summary.get("flag_only", {}), flag_only(pr_cases, base, head), replaced)
    write_jsonl(run_dir / "corpus" / "deltas.jsonl", deltas.values())
    summary["probes"] = sorted(probes_out.values(), key=lambda p: p["id"])
    summary["probe_problems"] = problems
    summary["probe_files"] = probe_files_hash(run_dir)
    for src in ("probe", "mutation"):
        summary["cases"][src] = sum(1 for c in existing.values() if c["source"] == src)
    summary["deltas"] = {}
    for d in deltas.values():
        summary["deltas"][d["source"]] = summary["deltas"].get(d["source"], 0) + 1
    write_json(run_dir / "corpus.json", summary)
    if stale:
        from .oracle import drop_cases

        drop_cases(run_dir, set(stale))
        log(f"dropped {len(stale)} case(s) of deleted or changed PR probes")
    log(f"PR probes: {len(pr_cases)}; changed: {sum(1 for c in pr_cases if c['id'] in deltas)}")
    print(probe_table(sorted(fresh, key=lambda p: p["probe"]), new_idem, new_idem_base))
    return summary


def probe_table(entries: list[dict], idem: dict | None = None, idem_base: dict | None = None) -> str:
    """One block per PR probe: every assertion on base and head, the re-minification result and any
    crash. `-` means decided elsewhere (equivalent: the oracle) or not applicable."""
    mark = {True: "pass", False: "FAIL", None: "-"}
    stable = lambda data, cid: mark[(data or {}).get(cid, {}).get("stable")]
    rows = []
    for p in entries:
        label = p["probe"] + ("  [changed]" if p.get("changed") else "")
        names = list(p["assert"].get("head", {}))
        for name in names:
            rows.append((label, name, mark[p["assert"].get("base", {}).get(name)], mark[p["assert"]["head"][name]]))
            label = ""
        if "idempotent" not in names:
            rows.append((label, "(re-minify stable)", stable(idem_base, p["id"]), stable(idem, p["id"])))
            label = ""
        crash = p.get("crash") or {}
        if crash:
            rows.append((label, "crash", crash.get("base", "-"), crash.get("head", "-")))
            label = ""
    head = ("probe", "assertion", "base", "head")
    if not rows:
        return "PR probes: none"
    w = [max(len(r[i]) for r in rows + [head]) for i in range(3)]
    lines = [f"PR probes: {len(entries)} (changed on head: {sum(1 for p in entries if p.get('changed'))})"]
    for r in [head] + rows:
        lines.append(f"{r[0]:<{w[0]}}  {r[1]:<{w[1]}}  {r[2]:<{w[2]}}  {r[3]}".rstrip())
    return "\n".join(lines)
