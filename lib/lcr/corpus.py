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
from pathlib import Path

from .adapter import normalize_response, run_requests
from .common import LcrError, SKILL_DIR, load_config, log, read_json, read_jsonl, stable_id, write_json, write_jsonl
from .probes import curated_dirs, load_probes
from .targets import feature_bits, format_targets, parse_targets
from .tuples import load_tuples, matches_expectation, to_requests
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
        if reqs is None:
            unmappable.append({"helper": t["helper"], "test": t["test"]})
            continue
        line_side = "head" if ident in th else "base"
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
    stats = {"base_tuples": len(tb), "head_tuples": len(th), "unmappable": len(unmappable), "unmappable_helpers": sorted({u["helper"] for u in unmappable})}
    return cases, stats


def probe_cases(run_dir: Path) -> tuple[list[dict], list[str]]:
    dirs = curated_dirs() + [(run_dir / "probes", "pr")]
    probes, problems = load_probes(dirs)
    cases = []
    for p in probes:
        cases.append({
            "id": f"p-{p.id}",
            "source": "probe",
            "origin": p.origin,
            "probe": {"id": p.id, "area": p.area, "title": p.title, "mode": p.mode, "targets": p.targets_text, "expect": p.expect, "known": p.known, "refs": p.refs, "path": str(p.path), "dom": p.dom, "note": p.note},
            "area": p.area,
            "request": p.request(),
        })
    return cases, problems


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


def assess_probe(case: dict, base: dict, head: dict) -> dict:
    """Non-browser assertions of a probe (equivalence is decided by the oracle)."""
    out = {}
    for side, resp in (("base", base), ("head", head)):
        checks = {}
        for exp in case["probe"]["expect"]:
            if exp == "no-panic":
                checks[exp] = resp.get("stage") not in ("panic", "crash", "timeout")
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
                checks[exp] = None  # decided by the oracle / idempotency pass
        out[side] = checks
    return out


def run_all(run_dir: Path, cases: list[dict], label: str) -> tuple[dict, dict]:
    base_bin = run_dir / "bin" / "base-adapter"
    head_bin = run_dir / "bin" / "head-adapter"
    if not base_bin.exists() or not head_bin.exists():
        raise LcrError("adapters missing; `lcr build` must succeed for both sides first")
    reqs = [{"id": c["id"], **c["request"]} for c in cases]
    workers = max(2, (os.cpu_count() or 4) // 2)
    log(f"{label}: {len(reqs)} requests x 2 builds")
    base = run_requests(base_bin, reqs, workers=workers, label=f"{label}/base")
    head = run_requests(head_bin, reqs, workers=workers, label=f"{label}/head")
    return base, head


def idempotency(run_dir: Path, cases: list[dict], head: dict) -> dict:
    """Second pass on head output with the same options: a stable minifier changes nothing."""
    reqs = []
    for c in cases:
        r = head.get(c["id"])
        if not r or not r.get("ok") or c["request"].get("kind") not in ("sheet",) or c["request"].get("css_modules"):
            continue
        if not c["request"].get("minify"):
            continue
        reqs.append({"id": c["id"], **{**c["request"], "css": r["code"]}})
    if not reqs:
        return {}
    second = run_requests(run_dir / "bin" / "head-adapter", reqs, label="idempotency")
    out = {}
    for req in reqs:
        first = head[req["id"]]["code"]
        again = second.get(req["id"], {})
        out[req["id"]] = {"stable": bool(again.get("ok")) and again.get("code") == first, "second": again.get("code") if again.get("ok") else again.get("error")}
    return out


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
            if resp.get("stage") in ("panic", "crash", "timeout"):
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
            probes_out.append({"id": c["id"], "probe": c["probe"]["id"], "origin": c["origin"], "known": c["probe"]["known"], "changed": changed, "assert": assess_probe(c, b, h)})
        elif c["source"] == "realworld" and b.get("ok") and h.get("ok"):
            size.append({"name": c["name"], "mode": c["mode"], "base": len(b["code"].encode()), "head": len(h["code"].encode())})

    delta_ids = {d["id"] for d in deltas}
    idem_targets = [c for c in cases if c["source"] in ("probe", "tuple", "mutation") and (c["id"] in delta_ids or c["source"] in ("probe", "mutation"))]
    idem = idempotency(run_dir, idem_targets, head)

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
        "idempotency_failures": sorted([k for k, v in idem.items() if not v["stable"]]),
        "idempotency": idem,
        "probes": probes_out,
        "probe_problems": problems,
        "size": sorted(size, key=lambda s: (s["name"], s["mode"])),
    }
    write_json(run_dir / "corpus.json", summary)
    log(f"deltas: {delta_counts or 'none'}; robustness head={len(robustness['head'])} base={len(robustness['base'])}; tuple changes: "
        + ", ".join(f"{k}={len(v)}" for k, v in tuple_report.items() if v))
    return summary


def run_probes(run_dir: Path) -> dict:
    """Re-run only probes (after the agent wrote <run>/probes), merging into corpus.json."""
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
    base, head = run_all(run_dir, pr_cases, "probes")
    existing = {c["id"]: c for c in read_jsonl(run_dir / "corpus" / "cases.jsonl")}
    for c in pr_cases:
        existing[c["id"]] = c
    write_jsonl(run_dir / "corpus" / "cases.jsonl", existing.values())
    for name, out in (("base", base), ("head", head)):
        rows = {r["id"]: r for r in read_jsonl(run_dir / "corpus" / f"outputs-{name}.jsonl")}
        rows.update({k: {"id": k, **v} for k, v in out.items()})
        write_jsonl(run_dir / "corpus" / f"outputs-{name}.jsonl", rows.values())
    deltas = {d["id"]: d for d in read_jsonl(run_dir / "corpus" / "deltas.jsonl")}
    probes_out = {p["id"]: p for p in summary["probes"]}
    for c in pr_cases:
        b, h = base.get(c["id"], {}), head.get(c["id"], {})
        nb, nh = normalize_response(b), normalize_response(h)
        if nb != nh:
            deltas[c["id"]] = {"id": c["id"], "source": c["source"], "base": nb, "head": nh}
        if c["source"] == "probe":
            probes_out[c["id"]] = {"id": c["id"], "probe": c["probe"]["id"], "origin": "pr", "known": c["probe"]["known"], "changed": nb != nh, "assert": assess_probe(c, b, h)}
        for side, resp in (("base", b), ("head", h)):
            if resp.get("stage") in ("panic", "crash", "timeout"):
                summary["robustness"][side].append({"id": c["id"], "source": "probe", "stage": resp.get("stage"), "error": (resp.get("error") or "")[:300]})
    idem = idempotency(run_dir, pr_cases, head)
    summary["idempotency"].update(idem)
    summary["idempotency_failures"] = sorted([k for k, v in summary["idempotency"].items() if not v["stable"]])
    write_jsonl(run_dir / "corpus" / "deltas.jsonl", deltas.values())
    summary["probes"] = sorted(probes_out.values(), key=lambda p: p["id"])
    summary["probe_problems"] = problems
    for src in ("probe", "mutation"):
        summary["cases"][src] = sum(1 for c in existing.values() if c["source"] == src)
    summary["deltas"] = {}
    for d in deltas.values():
        summary["deltas"][d["source"]] = summary["deltas"].get(d["source"], 0) + 1
    write_json(run_dir / "corpus.json", summary)
    log(f"PR probes: {len(pr_cases)}; changed: {sum(1 for c in pr_cases if c['id'] in deltas)}")
    return summary
