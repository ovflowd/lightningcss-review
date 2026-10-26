"""Stage 6: evaluate the check catalog over stage outputs, compute the verdict, render the report.

Everything here is a pure function of the run directory: the same inputs produce byte-identical
report.md / report.json. The agent's judgment enters only through analysis.json, whose slots are
validated (missing slots make the verdict INCONCLUSIVE).
"""
from __future__ import annotations

import difflib
import fnmatch
import re
from pathlib import Path

from .common import SKILL_DIR, LcrError, cache_dir, load_config, read_json, read_jsonl, skill_version, write_json
from .prepare import test_area_map
from .targets import format_targets
from .tuples import matches_expectation

SEV_RANK = {"BLOCKER": 0, "MAJOR": 1, "MINOR": 2, "NOTE": 3}
CHECKLIST_RE = re.compile(r"^- \[([A-Z0-9]+-\d+)\] \((BLOCKER|MAJOR|MINOR|NOTE)\) (.+)$")
CLASSIFICATIONS = {"INTENDED", "ACCEPTABLE_SIDE_EFFECT", "REGRESSION", "NEEDS_MAINTAINER_DECISION", "ORACLE_NOISE", "PRE_EXISTING"}
ANSWERS = ("PASS", "FAIL", "FAIL_PRE_EXISTING", "N/A")
SPEC_CITE = re.compile(r"https?://(drafts\.csswg\.org|www\.w3\.org|drafts\.fxtf\.org|html\.spec\.whatwg\.org|wpt\.fyi|github\.com/web-platform-tests/wpt)/\S+")
# An issue as evidence: a probe `known:` tag or a Lightning CSS issue/PR URL, never a bare `#N`.
ISSUE_REF = re.compile(r"(?<![\w-])(?:open-issue#\d+|fixed-by#(?:\d+|[0-9a-f]{7,40}))(?![\w-])|github\.com/parcel-bundler/lightningcss/(?:issues|pull)/\d+")
PRE_EVIDENCE = ("an issue (`open-issue#N`, `fixed-by#N` or a lightningcss issue/PR URL), a probe with an assertion that fails on base, "
                "a case the oracle finds wrong on base, a base tuple (`t-…`) whose base output matches its recorded expectation, or a case that crashes on base")
# Transitions where head is worse than base in the engines that can judge the case.
BAD_TRANSITIONS = ("regressed", "worsened")
NOT_VERIFIED = ("unverified", "errored", "input-rejected")
JUDGING = ("equivalent", "near", "different")
# Browser target families each engine stands for (lightningcss `Browsers` fields).
ENGINE_FAMILIES = {"chromium": ("chrome", "edge", "opera", "samsung", "android"), "firefox": ("firefox",), "webkit": ("safari", "ios_saf")}
# What is left of a glob without its wildcards when it names a whole source, not a family of cases.
CATCH_ALL_PREFIXES = {"", "t-", "p-", "m-", "m-p-", "m-t-", "w-", "r-"}
REF_SPLIT = re.compile(r"[\s,;()\[\]`'\"]+")
SOURCE_RANK = {"analysis": 0, "checklist": 1, "classification": 2, "check": 3}
# Check groups whose failures are about cases (and so can fold into the finding that cites them).
FOLDABLE_GROUPS = ("tests", "oracle", "robustness", "side-effects")


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
                current = {"item": m.group(1), "severity": m.group(2), "text": m.group(3), "list": name, "verify": "", "covers": []}
                items.append(current)
            elif current and line.strip().startswith("verify:"):
                current["verify"] = line.strip()[len("verify:"):].strip()
            elif current and line.strip().startswith("covers:"):
                current["covers"] = [g for g in re.split(r"[\s,`]+", line.strip()[len("covers:"):]) if g]
            elif current and line.strip().startswith("same-root-as:"):
                current["same_root_as"] = line.strip()[len("same-root-as:"):].strip()
    seen, out = set(), []
    for it in items:
        if it["item"] not in seen:
            seen.add(it["item"])
            out.append(it)
    return out


def untouched_covers(item: dict, files) -> bool:
    """True when the item names the files it is about and the diff touches none of them."""
    covers = item.get("covers") or []
    return bool(covers) and not any(fnmatch.fnmatchcase(f, g) for f in files for g in covers)


def resolve_answers(analysis: dict, checklist: list[dict]) -> dict:
    """Checklist answers by item. An entry `{"area": "<list>", "answer": "N/A", ...}` answers every
    item of that (non-general) list that has no answer of its own."""
    answers = {}
    for a in analysis.get("checklist", []):
        if a.get("item") and (a.get("answer") or a.get("item") not in answers):
            answers[a["item"]] = a
    areas = {a["area"]: a for a in analysis.get("checklist", []) if a.get("area") and not a.get("item") and a.get("answer") == "N/A" and a["area"] != "general"}
    for it in checklist:
        if it["list"] in areas and not (answers.get(it["item"]) or {}).get("answer"):
            answers[it["item"]] = {**areas[it["list"]], "item": it["item"], "area_level": True}
    return answers


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


def case_id(tag: str) -> str:
    """The case id inside a check item (`<id>~dark@<profile> [annotation]`)."""
    return str(tag).split(" ")[0].split("~")[0].split("@")[0]


def is_glob(pattern: str) -> bool:
    return "*" in pattern or "?" in pattern


def matches(pattern: str, cid: str, source: str) -> bool:
    if not pattern:
        return False
    if pattern.startswith("source:"):
        return pattern == f"source:{source}"
    return pattern == cid or (is_glob(pattern) and fnmatch.fnmatchcase(cid, pattern))


def classified(analysis: dict, cid: str, source: str) -> dict | None:
    """The first valid classification entry covering the case (entries match in file order)."""
    for d in analysis.get("deltas", []):
        if d.get("classification") in CLASSIFICATIONS and matches(d.get("id", ""), cid, source):
            return d
    return None


def snippet(text, limit):
    if text is None:
        return "∅"
    text = str(text)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def snippet_words(text, limit):
    """Like snippet, but cuts at a word boundary."""
    text = "" if text is None else str(text)
    if len(text) <= limit:
        return text
    cut = text[: limit - 1]
    space = cut.rfind(" ")
    return (cut[:space] if space > limit // 2 else cut).rstrip(" ,;:—-") + "…"


def light(v):
    return next((x for x in v if x.get("scheme") == "light"), v[0]) if v else None


def in_targets(engine: str, targets) -> bool:
    return not targets or any(f in targets for f in ENGINE_FAMILIES.get(engine, (engine,)))


def engine_statuses(v: dict) -> dict:
    """{engine: {base, head}} for the engines that can judge the case (the input does something
    there and the job did not error)."""
    s = (v.get("summary") or {}).get("latest") or {}
    skip = set(s.get("inert") or []) | set(s.get("errored") or [])
    eng = v.get("engines") or s.get("engines")
    out = {}
    if isinstance(eng, dict) and eng:
        for e, x in eng.items():
            if e not in skip:
                out[e] = {"base": (x or {}).get("base", "unknown"), "head": (x or {}).get("head", "unknown")}
        return dict(sorted(out.items()))
    for e, entry in (v.get("latest") or {}).items():
        var = entry.get("variants") if isinstance(entry, dict) else None
        if not var or e in skip or entry.get("error") or entry.get("touched") == 0:
            continue
        out[e] = {side: (var.get(side) or {}).get("status", "unknown") for side in ("base", "head")}
    return dict(sorted(out.items()))


def judged(v: dict, case: dict) -> dict:
    targets = (case.get("request") or {}).get("targets")
    return {e: s for e, s in engine_statuses(v).items() if in_targets(e, targets)}


def wrong_in(v: dict, case: dict, side: str) -> list[str]:
    return [e for e, s in judged(v, case).items() if s[side] == "different"]


def side_equivalent(v: dict, case: dict, side: str):
    """True/False when an in-target engine could judge that side; None when none could."""
    st = [s[side] for s in judged(v, case).values() if s[side] in JUDGING]
    if not st:
        return None
    return "different" not in st


def rejected_counts(v: dict, case: dict) -> tuple[int, int]:
    """Hard rejections (no surviving fallback) by engines inside the case's targets."""
    latest = v.get("latest") or {}
    if not latest:
        s = v["summary"]["latest"]
        return s.get("rejectedBase", 0), s.get("rejectedHead", 0)
    targets = (case.get("request") or {}).get("targets")
    b = h = 0
    for e, entry in sorted(latest.items()):
        if not isinstance(entry, dict) or not in_targets(e, targets):
            continue
        var = entry.get("variants") or {}
        for side in ("base", "head"):
            x = var.get(side) or {}
            # A value the input already carried inside a rejected declaration was rejected before the PR.
            carried = sum(1 for d in (x.get("rejected") or {}).get("decls") or [] if d.get("carrierRejected") and not d.get("fallbackSurvives"))
            n = max(0, (x.get("hardRejected", 0) or 0) - carried)
            if side == "base":
                b += n
            else:
                h += n
    return b, h


def case_refs(text, known) -> list[str]:
    """Case ids mentioned in free text (evidence, notes), in order of appearance."""
    out = []
    for tok in REF_SPLIT.split(str(text or "")):
        tok = tok.strip(".:")
        for cand in (tok, case_id(tok), f"p-{tok}"):
            if cand in known:
                if cand not in out:
                    out.append(cand)
                break
    return out


def diff_excerpt(a: str, b: str, limit: int) -> str:
    """The part of two outputs that differs: a unified diff for multi-line text, otherwise a window
    around the first and last differing character."""
    a, b = a or "", b or ""
    if a.count("\n") > 3 and b.count("\n") > 3:
        lines = list(difflib.unified_diff(a.splitlines(), b.splitlines(), "base", "head", n=1, lineterm=""))
        return snippet("\n".join(lines), 2 * limit)
    p = 0
    while p < min(len(a), len(b)) and a[p] == b[p]:
        p += 1
    s = 0
    while s < min(len(a), len(b)) - p and a[-1 - s] == b[-1 - s]:
        s += 1
    ctx = max(40, limit // 6)

    def cut(t):
        start, end = max(0, p - ctx), min(len(t), len(t) - s + ctx)
        return ("…" if start else "") + t[start:end] + ("…" if end < len(t) else "")

    return f"base: {snippet(cut(a), limit)}\nhead: {snippet(cut(b), limit)}"


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
    cap = th["max_listed_cases"]
    cases = {c["id"]: c for c in read_jsonl(run_dir / "corpus" / "cases.jsonl")}
    deltas = {d["id"]: d for d in read_jsonl(run_dir / "corpus" / "deltas.jsonl")}
    verdicts = oracle.get("verdicts", {})
    known = set(cases) | set(deltas) | set(verdicts)
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
    declared = set(prep.get("areas", [])) | set(prep.get("test_areas", [])) | {"tests"}
    checks, full_items, no_finding = [], {}, set()
    open_by_check: dict[str, list[str]] = {}

    def rank(item):
        """Headline order for evidence: PR tests and PR probes before curated probes and mutations."""
        refs = case_refs(item, known)
        c = cases.get(refs[0]) if refs else None
        if not c:
            return 6
        src = c.get("source")
        if src == "tuple":
            return 0
        if src == "probe":
            return 1 if c.get("origin") == "pr" else 2
        return {"mutation": 3, "wpt": 4, "realworld": 5}.get(src, 6)

    def add(cid, status, evidence="", items=None, severity=None, finding=True):
        meta = next(c for c in cfg["checks"] if c["id"] == cid)
        sev = None
        if status == "FAIL":
            sev = severity or (meta["fail"] if meta["fail"] in SEV_RANK else "MAJOR")
        elif status == "PARTIAL":
            sev = severity or meta.get("partial", "NOTE")
        ordered = sorted(items or [], key=rank)
        shown = ordered[:cap] + ([f"… {len(ordered) - cap} more"] if len(ordered) > cap else [])
        full_items[cid] = ordered
        if not finding:
            no_finding.add(cid)
        checks.append({"id": cid, "group": meta["group"], "title": meta["title"], "status": status, "severity": sev, "evidence": evidence, "items": shown})

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
            add("B1", "FAIL", f"{len(new_failed)} test(s) fail on head but not on base", new_failed)
        elif failed:
            add("B1", "PARTIAL", f"{len(failed)} test(s) fail on both base and head (pre-existing)", failed, severity="NOTE")
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
            drift = js.get("drift") or {}
            base_drift = js.get("base_drift")
            # Diff of diffs: a file that drifts the same way on base is not the PR's doing.
            new_drift = sorted(f for f in drift if base_drift is None or f not in base_drift or base_drift[f] != drift[f])
            pre_drift = sorted(f for f in drift if f not in new_drift)
            pre_note = f"; drifts identically on base (pre-existing): {', '.join(pre_drift)}" if pre_drift else ""
            if new_drift:
                add("B11", "FAIL", "regenerate and commit: " + ", ".join(new_drift) + pre_note)
            elif pre_drift:
                add("B11", "PARTIAL", "generated files drift identically on base (pre-existing): " + ", ".join(pre_drift), severity="NOTE")
            elif js.get("failed_step"):
                add("B11", "SKIP", f"regeneration failed at `{js['failed_step']}`")
            else:
                add("B11", "PASS", "regenerated output matches the PR")
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
    stats = corpus.get("tuple_stats", {})
    modified = tup.get("modified", [])
    # A changed expectation is also a head-only tuple; it belongs to T3, not to the new tests.
    changed_heads = {m.get("head_id") for m in modified}
    nf = [e for e in tup.get("new_failing_on_base", []) if e["id"] not in changed_heads]
    np_ = [e for e in tup.get("new_passing_on_base", []) if e["id"] not in changed_heads]
    unmapped = [u for u in stats.get("unmappable_cases", []) if u.get("in_diff") and u.get("side") != "base"]
    src_changed = any(p.startswith(("src/", "selectors/")) and p != "src/lib.rs" for p in prep.get("files", {}))
    mod_note = f"; {len(modified)} changed expectation(s) (T3)" if modified else ""
    if not corpus:
        add("T2", "SKIP", "corpus stage did not run")
    elif not nf and not np_:
        add("T2", "SKIP", "no new test cases" + mod_note)
    elif not nf and src_changed and unmapped:
        add("T2", "PARTIAL", f"the {len(np_)} mappable new case(s) pass on base, but {len(unmapped)} in-diff case(s) could not be run (T5): no conclusion" + mod_note, [f"{e['test']} (lib.rs:{e['line']})" for e in np_], severity="NOTE")
    elif not nf and src_changed:
        add("T2", "FAIL", f"all {len(np_)} new test case(s) already pass on base: none demonstrates the change" + mod_note, [f"{e['test']} (lib.rs:{e['line']})" for e in np_])
    elif np_:
        add("T2", "PARTIAL", f"{len(nf)} new case(s) fail on base (exercise the change); {len(np_)} pass on base too" + mod_note, [f"{e['test']} (lib.rs:{e['line']})" for e in np_])
    else:
        add("T2", "PASS", f"{len(nf)} new case(s), all fail on base" + mod_note)
    if modified:
        bad, unver, inert_mod = [], [], []
        for m in modified:
            v = light(verdicts.get(m["head_id"]) or verdicts.get(m["id"]) or [])
            s = v["summary"]["latest"] if v else {}
            t = s.get("transition", "unverified")
            if t == "input-rejected":
                inert_mod.append(m)
            elif t in ("unverified", "errored") or s.get("head") in (None, "unknown", "no-coverage", "error"):
                unver.append(m)
            elif s["head"] == "different":
                bad.append(m)
        inert_note = f"; {len(inert_mod)} with input rejected in every engine (decision bucket, O10)" if inert_mod else ""
        if bad:
            add("T3", "FAIL", f"{len(bad)} changed expectation(s) are not equivalent to their input in browsers" + inert_note, [f"{m['test']} lib.rs:{m.get('head_line')} ({m['head_id']})" for m in bad])
        elif unver:
            add("T3", "PARTIAL", f"{len(unver)} changed expectation(s) could not be verified in browsers" + inert_note, [f"{m['test']} lib.rs:{m.get('head_line')} ({m['head_id']})" for m in unver])
        else:
            add("T3", "PASS", f"{len(modified) - len(inert_mod)} changed expectation(s) verified" + inert_note)
    else:
        add("T3", "SKIP", "no existing expectation changed")
    rc = tup.get("removed_changed", [])
    add("T4", "FAIL" if rc else "PASS", f"{len(rc)} expectation(s) removed and the behavior changed" if rc else (f"{len(tup.get('removed_same', []))} removed, behavior unchanged" if tup.get("removed_same") else ""), [f"{e['test']} lib.rs:{e['line']}" for e in rc])
    hm = tup.get("head_mismatch", [])
    helpers = f"; unmappable helpers: {', '.join(stats.get('unmappable_helpers', []))}" if stats.get("unmappable_helpers") else ""
    if unmapped:
        add("T5", "PARTIAL", f"{len(unmapped)} test case(s) in the diff could not be run through the adapter; conclusions about the PR's tests are partial" + (f"; {len(hm)} recorded expectation(s) not reproduced" if hm else "") + helpers,
            [f"{u['test']} lib.rs:{u.get('line')}: {u.get('reason') or u.get('helper')}" for u in unmapped] + [f"{e['test']} lib.rs:{e['line']}" for e in hm], severity="MAJOR")
    else:
        add("T5", "PARTIAL" if hm else "PASS", (f"{len(hm)} recorded expectation(s) not reproduced by the adapter; excluded from conclusions" if hm else f"{stats.get('head_tuples', 0)} head tuples reproduced") + helpers, [f"{e['test']} lib.rs:{e['line']}" for e in hm], severity="NOTE")

    # ---- probe assertions (non-browser ones from the corpus; `equivalent` from the oracle)
    idem_head = corpus.get("idempotency", {}) or {}
    idem_base = corpus.get("idempotency_base", {}) or {}
    probe_asserts = {}
    for p in corpus.get("probes", []):
        a = {side: dict((p.get("assert") or {}).get(side) or {}) for side in ("base", "head")}
        for side, data in (("head", idem_head), ("base", idem_base)):
            if "idempotent" in a[side] and a[side]["idempotent"] is None and p["id"] in data:
                a[side]["idempotent"] = data[p["id"]]["stable"]
        v = light(verdicts.get(p["id"]) or [])
        if v:
            for side in ("base", "head"):
                if "equivalent" in a[side] and a[side]["equivalent"] is None:
                    a[side]["equivalent"] = side_equivalent(v, cases.get(p["id"], {}), side)
        probe_asserts[p["id"]] = a

    # ---- oracle
    regressed, new_bad, rejected, legacy_reg, near, visual, wpt_reg, unverified, divergent = [], [], [], [], [], [], [], [], []
    errored, input_rejected, bad_candidates, outside_targets, shot_errors = [], [], [], [], []
    errored_total = 0
    for cid, vs in sorted(verdicts.items()):
        case = cases.get(cid, {})
        src = case.get("source", "?")
        head_tuple = src == "tuple" and case.get("side") == "head"
        for v in vs:
            s = v["summary"]["latest"]
            t = s["transition"]
            tag = f"{cid}{'~dark' if v.get('scheme') == 'dark' else ''}"
            woke = f" [input inert, output live in {', '.join(s['inertLive'])}]" if s.get("inertLive") else ""
            if s.get("visualErrors"):
                shot_errors.append(tag)
            if t == "errored":
                errored_total += 1
                if cid in deltas or head_tuple:
                    errored.append(tag)
                continue
            if t == "input-rejected":
                # Nothing to compare against: the input does nothing in any engine that ran.
                if cid in deltas or head_tuple:
                    input_rejected.append(tag)
                continue
            is_divergent = bool(s.get("divergent")) and s["head"] == "different" and not s.get("neutral")
            # Output for explicit targets is judged only by the engines of those targets.
            judged_bad = t in BAD_TRANSITIONS or t == "introduced" or head_tuple
            if judged_bad and s["head"] == "different" and (case.get("request") or {}).get("targets") and engine_statuses(v) and not wrong_in(v, case, "head"):
                outside_targets.append(tag)
            elif t in BAD_TRANSITIONS:
                bad_candidates.append((tag + woke, cid, src))
            elif is_divergent and (t == "still-different" or head_tuple):
                bb = wrong_in(v, case, "base")
                eh = s.get("enginesHead", {})
                divergent.append(f"{tag} [head equivalent in {', '.join(eh.get('ok', [])) or 'none'}; different in {', '.join(eh.get('bad', [])) or 'none'}; base different in {', '.join(bb) or 'none'}]{woke}")
            elif t == "introduced" and s["head"] == "different":
                new_bad.append(tag)
            elif head_tuple and s["head"] == "different" and t != "introduced":
                new_bad.append(tag)
            if t == "near-introduced":
                near.append(tag)
            rb, rh = rejected_counts(v, case)
            if rh > rb:
                rejected.append(tag)
            if s.get("visualHead") and not s.get("visualBase"):
                visual.append(tag)
            for prof, ls in sorted(v["summary"].get("legacy", {}).items()):
                if ls["transition"] in BAD_TRANSITIONS:
                    legacy_reg.append(f"{tag}@{prof}")
            if t == "unverified" and cid in deltas:
                unverified.append(tag)

    # Pre-existing behavior extended to new targets: head's output for a regressed request equals
    # what base already produces (and pins in a test) for the same input under other targets.
    extended = {}
    if bad_candidates:
        base_out_all, head_out_all = outputs(run_dir, "base"), outputs(run_dir, "head")
        by_input = {}
        for c in sorted(cases.values(), key=lambda c: c["id"]):
            r = c.get("request") or {}
            if c.get("source") == "tuple" and c.get("side") in ("base", "both") and r.get("kind") == "sheet":
                b = base_out_all.get(c["id"], {})
                if b.get("ok"):
                    by_input.setdefault((r.get("css"), bool(r.get("minify")), bool(r.get("compact"))), []).append((repr(sorted((r.get("targets") or {}).items())), b.get("code"), c["id"]))
        for tag, cid, src in bad_candidates:
            r = cases.get(cid, {}).get("request") or {}
            h = head_out_all.get(cid, {})
            key = (r.get("css"), bool(r.get("minify")), bool(r.get("compact")))
            mine = repr(sorted((r.get("targets") or {}).items()))
            hit = next((tid for tg, code, tid in by_input.get(key, []) if tg != mine and h.get("ok") and code == h.get("code")), None)
            if hit:
                extended[cid] = hit
    extended_tags = []
    for tag, cid, src in bad_candidates:
        if cid in extended:
            extended_tags.append(f"{tag} [base test {extended[cid]} already gives this output for other targets]")
        else:
            (wpt_reg if src == "wpt" else regressed).append(tag)
    oracle_bad = {case_id(t) for t in regressed + wpt_reg + new_bad + legacy_reg}

    cls_cache: dict[str, dict | None] = {}

    def cls_of(tag):
        cid = case_id(tag)
        if cid not in cls_cache:
            cls_cache[cid] = classified(analysis, cid, cases.get(cid, {}).get("source", ""))
        return cls_cache[cid]

    def unexplained(tags):
        return [t for t in tags if not cls_of(t)]

    def as_regression(tags):
        return [t for t in tags if (cls_of(t) or {}).get("classification") == "REGRESSION"]

    def oracle_check(check, tags, fail_text, pass_text):
        """Any classification closes a slot; cases classified REGRESSION are reported once, by
        their finding, so the check row keeps FAIL without a finding of its own."""
        open_ = unexplained(tags)
        open_by_check[check] = open_
        if open_:
            add(check, "FAIL", fail_text(len(open_)), open_)
        elif as_regression(tags):
            reg = as_regression(tags)
            add(check, "FAIL", f"{len(reg)} case(s) classified REGRESSION (reported as findings)", reg, finding=False)
        else:
            add(check, "PASS", pass_text)

    if not oracle:
        for cid in ("O1", "O2", "O3", "O4", "O5", "O6", "O7", "O8", "O9", "O10"):
            add(cid, "SKIP", "oracle stage did not run")
    else:
        outside_note = f"; {len(outside_targets)} case(s) differ only in engines outside their targets (ignored)" if outside_targets else ""
        oracle_check("O1", regressed, lambda n: f"{n} case(s) where head is worse than base in current engines (base equivalent, or head adds differences)" + outside_note,
                     (f"{len(regressed)} regression(s) cleared in analysis" if regressed else "") + outside_note)
        oracle_check("O2", new_bad, lambda n: f"{n} new/changed test or flag-only output(s) render differently from their input", f"{len(new_bad)} cleared in analysis" if new_bad else "")
        oracle_check("O3", rejected, lambda n: f"{n} case(s) emit CSS an in-target engine rejects with no surviving fallback", "")
        if oracle.get("profiles") and len(oracle["profiles"]) > 1:
            oracle_check("O4", legacy_reg, lambda n: f"{n} lowering regression(s) in legacy engines", ", ".join(p for p in oracle["profiles"] if p != "latest"))
        else:
            add("O4", "SKIP", "no legacy engine profile ran")
        oracle_check("O5", near, lambda n: f"{n} case(s) drift within tolerance (color/number)", "")
        shot_note = f"; {len(shot_errors)} case(s) had no screenshot comparison (screenshot failed in {', '.join(sorted({e for vs in verdicts.values() for v in vs for e in v['summary']['latest'].get('visualErrors') or []}))})" if shot_errors else ""
        oracle_check("O6", visual, lambda n: f"{n} case(s) render different pixels" + shot_note, shot_note.lstrip("; "))
        if any(c.get("source") == "wpt" for c in cases.values()) or wpt_reg:
            oracle_check("O7", wpt_reg, lambda n: f"{n} WPT case(s) regressed", "")
        else:
            add("O7", "SKIP", "")
        not_run = [cid for cid in sorted(deltas) if cid not in verdicts]
        open8 = unexplained(unverified + not_run)
        err_open = unexplained(errored)
        open_by_check["O8"] = open8 + err_open
        err_note = f"; {len(err_open)} errored in an engine (re-run with `lcr oracle --rerun`)" if err_open else ""
        if open8:
            add("O8", "FAIL", f"{len(open8)} delta(s) unverified and not cleared in analysis.json" + err_note, open8 + err_open)
        elif err_open:
            add("O8", "INCONCLUSIVE", f"{len(err_open)} delta(s) errored in an engine: the oracle could not run them (re-run with `lcr oracle --rerun`, or classify)", err_open)
        else:
            add("O8", "PASS", f"{len(deltas)} delta(s) verified or cleared" + (f"; {errored_total} errored engine job(s) outside the deltas" if errored_total else ""))
        oracle_check("O9", divergent, lambda n: f"{n} case(s) where engines read the input differently; decide against the spec", f"{len(divergent)} engine-divergent case(s) classified" if divergent else "")
        decision = input_rejected + extended_tags
        dec_open = unexplained(decision)
        open_by_check["O10"] = dec_open
        if dec_open:
            n_rej = sum(1 for t in dec_open if t in input_rejected)
            add("O10", "PARTIAL", f"{len(dec_open)} case(s) the browsers cannot judge against base: {n_rej} with input rejected in every engine, {len(dec_open) - n_rej} extending base behavior to new targets", dec_open, severity="NOTE")
        else:
            add("O10", "PASS", f"{len(decision)} decision case(s) classified" if decision else "")

    # ---- robustness
    rb = corpus.get("robustness", {"head": [], "base": []})
    base_ids = {r["id"] for r in rb.get("base", [])}
    new_crash = [r for r in rb.get("head", []) if r["id"] not in base_ids]
    idem = []
    if not corpus:
        add("R1", "SKIP", "corpus stage did not run")
        add("R2", "SKIP", "corpus stage did not run")
    else:
        add("R1", "FAIL" if new_crash else ("PARTIAL" if rb.get("head") else "PASS"), f"{len(new_crash)} new panic/crash/timeout" if new_crash else (f"{len(rb['head'])} pre-existing (also on base)" if rb.get("head") else ""), [f"{r['id']} {r['stage']}: {snippet(r['error'], 120)}" for r in (new_crash or rb.get("head", []))], severity=None if new_crash else "NOTE")
        relevant = lambda i: i in deltas or cases.get(i, {}).get("origin") == "pr" or str(cases.get(i, {}).get("parent", "")).startswith("p-")
        idem = [i for i in corpus.get("idempotency_failures", []) if relevant(i)]
        pre_idem = [i for i in corpus.get("idempotency_preexisting", []) if relevant(i)]
        pre_note = f"; {len(pre_idem)} unstable on base too (pre-existing)" if pre_idem else ""
        if idem:
            add("R2", "FAIL", f"{len(idem)} changed case(s) are not stable under a second minify pass, while base is" + pre_note, idem)
        elif pre_idem:
            add("R2", "PARTIAL", f"{len(pre_idem)} case(s) are unstable under a second minify pass on base and head alike (pre-existing)", pre_idem, severity="NOTE")
        else:
            add("R2", "PASS", "")

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
            and not any(ls["transition"] in BAD_TRANSITIONS or (ls["transition"] == "still-different" and not ls.get("neutral")) for ls in v["summary"].get("legacy", {}).values())
            for v in vs
        )
        if verified_ok:
            auto_ok.append(cid)
        elif not classified(analysis, cid, case["source"]):
            outside.append(f"{cid} [{', '.join(areas)}]")
    open_by_check["S1"] = outside
    if not corpus:
        add("S1", "SKIP", "corpus stage did not run")
    else:
        scope = ", ".join(sorted(declared - {"tests"})) or "none"
        note = f"; {len(auto_ok)} outside delta(s) verified equivalent in every engine (accepted)" if auto_ok else ""
        add("S1", "FAIL" if outside else "PASS", (f"{len(outside)} delta(s) outside the touched areas ({scope}) need classification" if outside else f"touched areas: {scope}") + note, outside)
    size = corpus.get("size", [])
    if size:
        parts, grew_any = [], False
        for mode, label in (("minify", "minified"), ("lower-minify", "lower-minify")):
            rows = [s for s in size if s["mode"] == mode]
            if not rows:
                continue
            tb, thd = sum(s["base"] for s in rows), sum(s["head"] for s in rows)
            ratio = (thd - tb) / tb if tb else 0
            grew_any |= ratio > th["size_growth_ratio"]
            parts.append(f"{label} total {tb} -> {thd} bytes ({ratio:+.3%})")
        grew = [f"{s['name']}/{s['mode']}: {s['base']} -> {s['head']} bytes" for s in size if s["head"] > s["base"]]
        add("S2", "FAIL" if grew_any else "PASS", "; ".join(parts), grew)
    else:
        add("S2", "SKIP", "real-world corpus not available")
    ov = prep.get("overlapping_prs", [])
    author = (prep.get("pr") or {}).get("author")
    mine = {i["number"] for i in prep.get("linked_issues", [])}

    def dup_reason(o):
        why = []
        if author and o.get("author") == author:
            why.append("same author")
        if mine & set(o.get("linked_issues") or []):
            why.append("same linked issue")
        return ", ".join(why)

    dups = [o for o in ov if dup_reason(o)]
    ov_items = [f"#{o['number']} {o['title']}: possible duplicate ({dup_reason(o)}; {', '.join(o['shared_files'])})" for o in dups] + [f"#{o['number']} {o['title']} ({', '.join(o['shared_files'])})" for o in ov if o not in dups]
    add("S3", "PARTIAL" if ov else "PASS", (f"{len(ov)} open PR(s) touch the same files" + (f"; possible duplicate of {', '.join('#' + str(o['number']) for o in dups)}" if dups else "")) if ov else "", ov_items, severity="NOTE")

    # ---- perf (optional stage)
    perf = read_json(run_dir / "perf.json")
    if not perf:
        add("P1", "SKIP", "optional: run `lcr perf` for core/hot-path changes")
        add("P2", "SKIP", "optional: run `lcr perf`")
    elif perf.get("skip_reason"):
        add("P1", "SKIP", perf["skip_reason"])
        add("P2", "SKIP", perf["skip_reason"])
    else:
        slow = perf["total_ratio"] and perf["total_ratio"] > th["perf_total_ratio"] and perf["slower_share"] >= th["perf_slower_share"]
        add("P1", "FAIL" if slow else "PASS", f"real-world total {perf['total_ms']['base']}ms -> {perf['total_ms']['head']}ms (x{perf['total_ratio']}); {perf['slower_share']:.0%} of files >5% slower; median of {perf['repeats']}",
            [f"{r['name']}: x{r['ratio']}" for r in sorted(perf["files"], key=lambda r: -(r["ratio"] or 0))[:6]] if slow else [])
        grew = perf["binary_ratio"] > th["binary_growth_ratio"]
        add("P2", "FAIL" if grew else "PASS", f"release CLI {perf['binary_bytes']['base']} -> {perf['binary_bytes']['head']} bytes (x{perf['binary_ratio']})")

    # ---- probe assertions (T6)
    afinding_refs = {str(f.get("id") or f"F{i}"): set(case_refs(" ".join(map(str, f.get("evidence") or [])), known)) for i, f in enumerate(analysis.get("findings", []), 1)}
    pre_marks = [(f"PRE_EXISTING {d.get('id', '')}", d, f"{d.get('reason', '')} {d.get('evidence', '')}") for d in analysis.get("deltas", []) if d.get("classification") == "PRE_EXISTING"]
    # Only answers to this run's checklist items: their evidence is what A3 validates.
    checklist = load_checklists(prep.get("areas", []))
    answers = resolve_answers(analysis, checklist)
    pre_answers = [(it["item"], answers[it["item"]]) for it in checklist if (answers.get(it["item"]) or {}).get("answer") == "FAIL_PRE_EXISTING"]
    pre_marks += [(f"FAIL_PRE_EXISTING {item}", {"finding": a.get("finding")}, f"{a.get('evidence', '')} {a.get('note', '')}") for item, a in pre_answers]

    def pre_existing_mark(pid):
        """The PRE_EXISTING classification or FAIL_PRE_EXISTING answer that names a probe, or links a
        finding that cites it."""
        for label, entry, text in pre_marks:
            if entry.get("id") == pid or pid in case_refs(text, known) or pid in afinding_refs.get(str(entry.get("finding")), ()):
                return label
        return None

    broke, broke_pre, failing, probe_fixed = [], [], [], []
    if corpus.get("probes"):
        r2 = set(idem)
        for p in sorted(corpus["probes"], key=lambda p: p["id"]):
            if p.get("origin") not in ("pr", "curated"):
                continue
            a = probe_asserts[p["id"]]
            for name in sorted(a["head"]):
                hb, hh = a["base"].get(name), a["head"].get(name)
                if hb is False and hh is True:
                    probe_fixed.append(f"{p['id']}: {name}")
                # `equivalent` is decided by the oracle checks and `idempotent` by R2 when R2 lists the case.
                if name == "equivalent" or (name == "idempotent" and p["id"] in r2):
                    continue
                if hb is True and hh is False:
                    mark = pre_existing_mark(p["id"])
                    if mark:
                        broke_pre.append(f"{p['id']}: {name} (holds on base, fails on head; base is wrong another way per {mark})")
                    else:
                        broke.append(f"{p['id']}: {name} (holds on base, fails on head)")
                elif hh is False and (p["origin"] == "pr" or p.get("changed")):
                    failing.append(f"{p['id']}: {name}" + (" (fails on base too)" if hb is False else ""))
    fixed_note = f"; {len(probe_fixed)} assertion(s) now pass (fixed by this PR)" if probe_fixed else ""
    if not corpus:
        add("T6", "SKIP", "corpus stage did not run")
    elif broke:
        add("T6", "FAIL", f"{len(broke)} probe assertion(s) hold on base and fail on head" + (f"; {len(broke_pre) + len(failing)} more fail on head" if broke_pre or failing else "") + fixed_note, broke + broke_pre + failing)
    elif broke_pre or failing:
        parts = ([f"{len(broke_pre)} probe assertion(s) hold on base only because base is wrong another way (pre-existing)"] if broke_pre else []) + ([f"{len(failing)} probe assertion(s) fail on head"] if failing else [])
        add("T6", "PARTIAL", "; ".join(parts) + fixed_note, broke_pre + failing, severity="NOTE")
    else:
        add("T6", "PASS", f"{sum(len(a['head']) for a in probe_asserts.values())} assertion(s) checked" + fixed_note)

    # ---- analysis
    problems, warnings = [], []
    missing_items = [it["item"] for it in checklist if (answers.get(it["item"]) or {}).get("answer") not in ANSWERS or not answers[it["item"]].get("evidence")]

    def item_severity(it, a):
        eff = a.get("effective_severity")
        if not eff:
            return it["severity"]
        if eff not in SEV_RANK:
            problems.append(f"{it['item']}: effective_severity {eff} is not a severity")
        elif SEV_RANK[eff] < SEV_RANK[it["severity"]]:
            problems.append(f"{it['item']}: effective_severity cannot raise {it['severity']} to {eff}")
        elif not a.get("severity_reason"):
            problems.append(f"{it['item']}: effective_severity {eff} needs a severity_reason")
        else:
            return eff
        return it["severity"]

    base_out = {}

    def base_wrong(cid):
        """Evidence that base itself fails on a case, or (a base tuple) that base's own tests record its behavior."""
        pa = probe_asserts.get(cid)
        if pa and any(x is False for x in pa["base"].values()):
            return True
        v = light(verdicts.get(cid) or [])
        if v and (v["summary"]["latest"]["base"] == "different" or v["summary"]["latest"]["transition"] in ("still-different", "fixed", "worsened")):
            return True
        c = cases.get(cid) or {}
        if c.get("source") == "tuple" and c.get("side") in ("base", "both") and c.get("expectation"):
            if not base_out:
                base_out.update(outputs(run_dir, "base"))
            return bool(base_out.get(cid)) and matches_expectation(c["expectation"], base_out[cid]) is True
        return cid in base_ids

    failed_items, pre_items = [], []
    for it in checklist:
        a = answers.get(it["item"]) or {}
        if a.get("answer") == "FAIL":
            failed_items.append((it, a, item_severity(it, a)))
        elif a.get("answer") == "FAIL_PRE_EXISTING":
            pre_items.append((it, a))
        elif a.get("effective_severity"):
            item_severity(it, a)
    for it, a, _ in failed_items:
        verify = it.get("verify", "")
        for ref in case_refs(f"{a.get('evidence', '')} {a.get('note', '')}", known):
            mode = ((cases.get(ref) or {}).get("probe") or {}).get("mode")
            if not mode or not re.search(rf"(?<![\w-]){re.escape(mode)}(?![\w-])", verify):
                continue
            v = light(verdicts.get(ref) or [])
            t = v["summary"]["latest"]["transition"] if v else None
            if t in ("fixed", "both-equivalent"):
                problems.append(f"{it['item']}: FAIL cites {ref} ({mode}, {t}), which its verify line accepts")
        if re.search(r"\bor\b", verify) and not a.get("note"):
            problems.append(f"{it['item']}: a FAIL must say in `note` why each verify alternative does not hold")
    for it, a in pre_items:
        text = f"{a.get('evidence', '')} {a.get('note', '')}"
        if not ISSUE_REF.search(text) and not any(base_wrong(r) for r in case_refs(text, known)):
            problems.append(f"{it['item']}: FAIL_PRE_EXISTING needs evidence that base fails the same way: {PRE_EVIDENCE}")
    if not analysis:
        add("A1", "SKIP", "analysis.json missing")
    elif failed_items:
        ordered = sorted(failed_items, key=lambda x: (SEV_RANK[x[2]], x[0]["item"]))
        worst = ordered[0][2]
        pre_note = f"; {len(pre_items)} fail on base too (notes)" if pre_items else ""
        add("A1", "FAIL", f"{len(failed_items)} checklist item(s) failed: " + ", ".join(f"{it['item']} ({sev})" for it, _, sev in ordered) + pre_note,
            [f"{it['item']} ({sev}): {it['text']}" for it, _, sev in ordered], severity=worst, finding=False)
    else:
        pre_note = f"; {len(pre_items)} fail on base too (notes)" if pre_items else ""
        add("A1", "PASS" if not missing_items else "PARTIAL", f"{len(checklist) - len(missing_items)}/{len(checklist)} items answered" + pre_note, severity="NOTE")

    linked = prep.get("linked_issues", [])
    probes = {p["id"]: p for p in corpus.get("probes", [])}

    def repro_of(p):
        r = p.get("repro") or ((cases.get(p["id"]) or {}).get("probe") or {}).get("repro")
        m = re.search(r"\d+", str(r or ""))
        return int(m.group(0)) if m else None

    if linked and not analysis:
        add("A2", "SKIP", "analysis.json missing (write an issue probe first)")
    elif linked:
        hard, soft, unknown = [], [], []
        for issue in linked:
            n = issue["number"]
            # Closed or merely related issues are context, not a promise of this PR.
            lenient = str(issue.get("state", "")).upper() == "CLOSED" or issue.get("closing") is False
            sink = soft if lenient else hard
            mine_p = [p for p in probes.values() if p.get("origin") == "pr" and repro_of(p) == n]
            if not mine_p:
                mine_p = [p for p in probes.values() if p.get("origin") == "pr" and p.get("known") == f"open-issue#{n}"]
            if not mine_p:
                sink.append(f"#{n}: no PR probe with `repro: #{n}`")
                continue
            for p in sorted(mine_p, key=lambda p: p["id"]):
                a = probe_asserts[p["id"]]
                uses_eq = "equivalent" in a["head"]
                plain_h = [x for k, x in a["head"].items() if k != "equivalent" and x is not None]
                plain_b = [x for k, x in a["base"].items() if k != "equivalent" and x is not None]
                if uses_eq and a["head"]["equivalent"] is None:
                    v = light(verdicts.get(p["id"]) or [])
                    unknown.append(f"#{n}: {p['probe']}: the oracle could not judge it ({v['summary']['latest']['transition'] if v else 'not run'})")
                    if not plain_h:
                        continue
                head_ok = all(plain_h) and (a["head"]["equivalent"] is not False if uses_eq else True)
                base_ok = all(plain_b) and (a["base"].get("equivalent") is not False if uses_eq else True)
                if not head_ok:
                    sink.append(f"#{n}: {p['probe']} fails on head")
                elif base_ok and not p.get("changed"):
                    sink.append(f"#{n}: {p['probe']} passes on base too (does it reproduce the issue?)")
        credit = [f"fixed by this PR: {x}" for x in probe_fixed]
        # The problems lead the evidence; probe credit is context and only summarized.
        credit_note = f"; {len(probe_fixed)} probe assertion(s) fixed by this PR (T6)" if probe_fixed else ""
        if hard:
            add("A2", "FAIL", f"{len(linked)} linked issue(s)" + credit_note, hard + soft + unknown)
        elif unknown:
            add("A2", "INCONCLUSIVE", f"{len(linked)} linked issue(s); the oracle could not run on the repro" + credit_note, unknown + soft)
        elif soft:
            add("A2", "PARTIAL", f"{len(linked)} linked issue(s); closed or related ones need no repro" + credit_note, soft, severity="NOTE")
        else:
            add("A2", "PASS", f"{len(linked)} linked issue(s)" + (f"; {len(probe_fixed)} probe assertion(s) fixed by this PR" if probe_fixed else ""), credit)
    else:
        add("A2", "SKIP", "no linked issues")

    # ---- analysis completeness (A3)
    universe = sorted(known)
    entries = analysis.get("deltas", [])
    coverage = {i: [] for i in range(len(entries))}
    entry_index = {id(d): i for i, d in enumerate(entries)}
    for cid in universe:
        d = cls_of(cid)
        if d is not None:
            coverage[entry_index[id(d)]].append(cid)
    open_now = set()
    for tags in open_by_check.values():
        open_now.update(case_id(t) for t in tags)

    def transition_of(cid):
        v = light(verdicts.get(cid) or [])
        return v["summary"]["latest"]["transition"] if v else "none"

    afind_ids = []
    for i, f in enumerate(analysis.get("findings", []), 1):
        afind_ids.append(str(f.get("id") or f"F{i}"))
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
        if len(set(afind_ids)) != len(afind_ids):
            incomplete.append("analysis finding ids are not unique")
        for a in list(answers.values()) + entries:
            if a.get("finding") and str(a["finding"]) not in afind_ids:
                incomplete.append(f"{a.get('item') or a.get('id')}: links unknown finding {a['finding']}")
        must_cite = {case_id(t) for t in regressed + new_bad + divergent + wpt_reg}
        cite_flagged = set()
        for cid in sorted(must_cite):
            d = cls_of(cid)
            if d and d["classification"] in ("INTENDED", "ACCEPTABLE_SIDE_EFFECT", "ORACLE_NOISE") and not SPEC_CITE.search(d.get("reason", "")) and id(d) not in cite_flagged:
                cite_flagged.add(id(d))
                incomplete.append(f"{d['id']}: browsers disagree with head on {cid}; an {d['classification']} classification must cite the spec (drafts.csswg.org/w3.org URL#anchor) or a WPT file")
        bad_now = {case_id(t) for t in regressed + wpt_reg + legacy_reg}
        unfilled = []
        for i, d in enumerate(entries):
            pattern, cl = d.get("id", ""), d.get("classification")
            cov = coverage[i]
            if not cl:
                # An empty slot that no longer matches an open case is stale and ignored.
                if any(matches(pattern, cid, cases.get(cid, {}).get("source", "")) for cid in open_now):
                    unfilled.append(pattern)
                continue
            if cl not in CLASSIFICATIONS or not d.get("reason"):
                incomplete.append(f"delta classification invalid: {pattern}")
                continue
            group = is_glob(pattern) or pattern.startswith("source:")
            hits = sorted(c for c in cov if c in bad_now)
            if group and hits and cl != "REGRESSION":
                incomplete.append(f"{pattern}: a glob may not clear regressed case(s) ({', '.join(hits[:3])}{'…' if len(hits) > 3 else ''}); classify them by exact id")
            catch_all = pattern.startswith("source:") or (is_glob(pattern) and re.sub(r"[*?]", "", pattern) in CATCH_ALL_PREFIXES)
            if catch_all and len({transition_of(c) for c in cov}) > 1:
                incomplete.append(f"{pattern}: a catch-all classification must cover cases of one transition (found {', '.join(sorted({transition_of(c) for c in cov}))})")
            if cl == "REGRESSION":
                eq = [c for c in cov if transition_of(c) == "both-equivalent"]
                if eq:
                    warnings.append(f"{pattern}: REGRESSION covers {len(eq)} case(s) the browsers call both-equivalent (e.g. {eq[0]})")
                for c in cov:
                    v = light(verdicts.get(c) or [])
                    if v and transition_of(c) == "still-different":
                        # REGRESSION needs an engine where base is right and head is wrong.
                        hw = set(wrong_in(v, cases.get(c, {}), "head"))
                        if hw and hw <= set(wrong_in(v, cases.get(c, {}), "base")):
                            incomplete.append(f"{pattern}: REGRESSION on {c}, but base is wrong in every engine where head is ({', '.join(sorted(hw))}); use PRE_EXISTING or NEEDS_MAINTAINER_DECISION")
                            break
            if cl == "PRE_EXISTING":
                text = f"{d.get('reason', '')} {d.get('evidence', '')}"
                if not ISSUE_REF.search(text) and not any(base_wrong(r) for r in case_refs(text, known)):
                    incomplete.append(f"{pattern}: PRE_EXISTING needs evidence that base is wrong the same way: {PRE_EVIDENCE}")
                ok_base = [c for c in cov if transition_of(c) == "regressed"]
                if ok_base:
                    incomplete.append(f"{pattern}: PRE_EXISTING on {ok_base[0]}, which base renders equivalent in every engine")
        if unfilled:
            incomplete.append(f"{len(unfilled)} open delta slot(s) not classified: " + ", ".join(unfilled[:5]) + ("…" if len(unfilled) > 5 else ""))
        incomplete.extend(problems)
    if not analysis:
        add("A3", "SKIP", "analysis.json missing: run `lcr worklist` and fill it")
    elif incomplete:
        add("A3", "FAIL", "; ".join(incomplete[:6]) + (f"; {len(incomplete) - 6} more" if len(incomplete) > 6 else ""), incomplete + warnings)
    elif warnings:
        add("A3", "PARTIAL", "all slots filled; " + "; ".join(warnings[:3]), warnings, severity="NOTE")
    else:
        add("A3", "PASS", "all slots filled")

    # Every catalog check appears exactly once, in catalog order (stable report shape).
    present = {c["id"] for c in checks}
    for meta in cfg["checks"]:
        if meta["id"] not in present:
            add(meta["id"], "SKIP", "not evaluated (stage missing)")
    order = {m["id"]: i for i, m in enumerate(cfg["checks"])}
    checks.sort(key=lambda c: order[c["id"]])
    fail_titles = {m["id"]: m.get("fail_title") or m["title"] for m in cfg["checks"]}

    # ---- findings: one per defect. Analysis findings lead; checklist failures, classifications and
    # check failures that cite the same cases (or link a finding id) fold into them as evidence.
    afindings = []
    for i, f in enumerate(analysis.get("findings", []), 1):
        if f.get("severity") in SEV_RANK:
            afindings.append({"source": "analysis", "id": str(f.get("id") or f"F{i}"), "check": None, "severity": f["severity"], "title": f.get("title", ""), "detail": f.get("detail", ""),
                              "evidence": list(f.get("evidence") or []), "suggested_test": f.get("suggested_test"), "folded": []})
    by_fid = {f["id"]: f for f in afindings}
    cited = {}
    for f in afindings:
        for e in f["evidence"]:
            for ref in case_refs(e, known):
                cited.setdefault(ref, f["id"])

    def fold_into(link, refs, require_all):
        if link and str(link) in by_fid:
            return by_fid[str(link)]
        hits = [r for r in refs if r in cited]
        if refs and hits and (len(hits) == len(refs) or not require_all):
            return by_fid[cited[hits[0]]]
        return None

    def fold(target, entry):
        target["folded"].append({"source": entry["source"], "check": entry.get("check"), "severity": entry["severity"], "title": entry["title"]})
        if SEV_RANK[entry["severity"]] < SEV_RANK[target["severity"]]:
            target["severity"] = entry["severity"]
        extra = [e for e in entry.get("evidence") or [] if e and e not in target["evidence"]]
        target["evidence"].extend(extra[:cap])

    standalone = []

    def place(entry, link, refs, require_all):
        target = fold_into(link, refs, require_all)
        if target:
            fold(target, entry)
        else:
            standalone.append(entry)
        return target or entry

    # An item marked `same-root-as: <ID>` restates that item's defect: when both fail it folds
    # into wherever the root item's failure landed.
    failed_ids = {it["item"] for it, _, _ in failed_items}
    landed = {}
    for it, a, sev in sorted(failed_items, key=lambda x: x[0].get("same_root_as") in failed_ids):
        entry = {"source": "checklist", "check": it["item"], "severity": sev, "title": it["text"], "detail": a.get("note", "") + (f" (severity {it['severity']} → {sev}: {a.get('severity_reason')})" if sev != it["severity"] else ""), "evidence": [a.get("evidence", "")], "folded": []}
        root = landed.get(it.get("same_root_as"))
        if root is not None and not a.get("finding"):
            fold(root, entry)
            landed[it["item"]] = root
        else:
            landed[it["item"]] = place(entry, a.get("finding"), case_refs(f"{a.get('evidence', '')} {a.get('note', '')}", known), False)
    for it, a in pre_items:
        entry = {"source": "checklist", "check": it["item"], "severity": "NOTE", "title": f"Pre-existing (base fails too): {it['text']}", "detail": a.get("note", ""), "evidence": [a.get("evidence", "")]}
        place(entry, a.get("finding"), case_refs(f"{a.get('evidence', '')} {a.get('note', '')}", known), False)
    groups = {}
    for i, d in enumerate(entries):
        cl = d.get("classification")
        if cl in ("REGRESSION", "NEEDS_MAINTAINER_DECISION") and d.get("reason"):
            g = groups.setdefault((cl, d["reason"].strip()), {"patterns": [], "cases": [], "finding": None})
            g["patterns"].append(d.get("id", ""))
            g["cases"].extend(c for c in coverage[i] if c not in g["cases"])
            g["finding"] = g["finding"] or d.get("finding")
    decision_lines = []
    for (cl, reason), g in sorted(groups.items(), key=lambda x: (x[0][0] != "REGRESSION", x[0][1])):
        cases_g = sorted(g["cases"], key=lambda c: (rank(c), c))
        ev_items = cases_g[:cap] + ([f"… {len(cases_g) - cap} more"] if len(cases_g) > cap else []) or [p for p in g["patterns"] if p]
        n = len(cases_g) or len(g["patterns"])
        if cl == "REGRESSION":
            entry = {"source": "classification", "check": None, "severity": "BLOCKER", "title": f"Regression: {snippet_words(reason, 120)}", "detail": f"{reason} ({n} case(s))", "evidence": ev_items}
        else:
            # A policy question never makes the verdict UNSAFE: MAJOR when the browsers show head worse
            # than base, otherwise a note.
            sev = "MAJOR" if any(c in oracle_bad for c in cases_g) else "NOTE"
            entry = {"source": "classification", "check": None, "severity": sev, "title": f"Decision needed: {snippet_words(reason, 120)}", "detail": f"{reason} ({n} case(s))", "evidence": ev_items}
            decision_lines.append(f"{snippet_words(reason, 160)} ({n} case(s))")
        refs = [c for c in cases_g] or [p for p in g["patterns"] if p in known]
        place(entry, g["finding"], refs, True)
    for c in checks:
        if c["status"] in ("FAIL", "PARTIAL") and c["severity"] and c["id"] not in no_finding:
            refs = []
            for item in full_items.get(c["id"], []):
                refs.extend(r for r in case_refs(item, known) if r not in refs)
            entry = {"source": "check", "check": c["id"], "severity": c["severity"], "title": fail_titles[c["id"]] if c["status"] == "FAIL" else c["title"], "detail": c["evidence"], "evidence": c["items"]}
            target = fold_into(None, refs, True) if c["group"] in FOLDABLE_GROUPS else None
            if target:
                fold(target, entry)
            else:
                related = sorted({cited[r] for r in refs if r in cited})
                if related:
                    entry["related"] = [f"{fid}: {by_fid[fid]['title']}" for fid in related]
                standalone.append(entry)
    if open_by_check.get("O10"):
        decision_lines.append(f"{len(open_by_check['O10'])} case(s) the browsers cannot judge against base are unclassified (O10)")
    findings = afindings + standalone
    findings.sort(key=lambda f: (SEV_RANK[f["severity"]], SOURCE_RANK[f["source"]], f.get("check") or "", f["title"]))
    for i, f in enumerate(findings, 1):
        f["n"] = i
        if not f.get("folded"):
            f.pop("folded", None)
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
    inconclusive = [c["id"] for c in checks if c["status"] == "INCONCLUSIVE"]
    if (missing_stages or inconclusive) and verdict in ("SAFE", "SAFE_WITH_NITS"):
        verdict = "INCONCLUSIVE"
    if incomplete and verdict != "UNSAFE":
        verdict = "INCONCLUSIVE"  # A3's own MAJOR says nothing about the PR; only proven blockers survive

    # Opt-in PRs: when every delta needs a flag the PR adds, the default path is untouched.
    scope = None
    flag_only = corpus.get("flag_only") or {}
    if flag_only and deltas:
        flag_names = set(flag_only)
        flag_cases = {c for ids in flag_only.values() for c in ids}

        def flag_on(cid, depth=0):
            c = cases.get(cid) or {}
            if cid in flag_cases or set((c.get("request") or {}).get("flags") or []) & flag_names:
                return True
            return bool(c.get("parent")) and depth < 3 and flag_on(c["parent"], depth + 1)

        if all(flag_on(cid) for cid in deltas):
            scope = {"flags": sorted(flag_names), "default_requests": sum(1 for cid in cases if not flag_on(cid)), "text": f"flag {', '.join(sorted(flag_names))} only"}
    return {
        "prep": prep, "build": build, "corpus": corpus, "oracle": oracle, "analysis": analysis, "cases": cases, "deltas": deltas,
        "checks": checks, "findings": findings, "counts": counts, "verdict": verdict, "stages": stages, "missing_stages": missing_stages,
        "checklist": checklist, "answers": answers, "open": open_by_check, "oracle_bad": sorted(oracle_bad), "decision": decision_lines,
        "scope": scope, "probe_fixed": probe_fixed, "probe_asserts": probe_asserts, "extended": extended, "incomplete": incomplete,
    }


def open_slots(ev: dict) -> list[dict]:
    """Cases the report still needs a classification for, uncapped, with the checks that list them."""
    slots = {}
    for check, tags in sorted(ev["open"].items()):
        for t in tags:
            cid = case_id(t)
            s = slots.setdefault(cid, {"id": cid, "checks": []})
            if check not in s["checks"]:
                s["checks"].append(check)
    return [slots[k] for k in sorted(slots)]


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
    b, h = base_out.get(cid, {}), head_out.get(cid, {})
    show = lambda r: r.get("code") if r.get("ok") else f"/* {r.get('stage')} error: {r.get('error')} */"
    lines.append("")
    if case.get("source") == "realworld":
        lines.append("  base → head (changed part):")
        lines.append("  " + fence(diff_excerpt(show(b), show(h), limit), "diff").replace("\n", "\n  "))
    else:
        src_text = req.get("css") if req.get("kind") != "property" else f"{req.get('property')}: {req.get('value')}"
        lines.append("  input:")
        lines.append("  " + fence(snippet(src_text, limit)).replace("\n", "\n  "))
        lines.append("  base → head:")
        lines.append("  " + fence(snippet(show(b), limit) + "\n/* ---- head ---- */\n" + snippet(show(h), limit)).replace("\n", "\n  "))
    for v in ev["oracle"].get("verdicts", {}).get(cid, []):
        s = v["summary"]["latest"]
        bw, hw = wrong_in(v, case, "base"), wrong_in(v, case, "head")
        lines.append(f"  oracle ({v.get('scheme')}): base **{s['base']}**, head **{s['head']}** → `{s['transition']}` · base wrong in: {', '.join(bw) or 'none'} · head wrong in: {', '.join(hw) or 'none'}" + (f" · input inert, output live in: {', '.join(s['inertLive'])}" if s.get("inertLive") else ""))
        for engine, e in sorted(v.get("latest", {}).items()):
            hv = e.get("variants", {}).get("head", {}) if "variants" in e else {}
            diffs = hv.get("diffs", [])[:3]
            rej = hv.get("rejected", {}) if isinstance(hv.get("rejected"), dict) else {}
            bits = []
            if e.get("error"):
                bits.append(f"error: {snippet(e['error'], 120)}")
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


def verdict_line(verdict: str, scope: dict | None) -> str:
    return verdict + (f" ({scope['text']})" if scope else "")


def render(ev: dict, run_dir: Path) -> str:
    prep, build, corpus, oracle, analysis = ev["prep"], ev["build"], ev["corpus"], ev["oracle"], ev["analysis"]
    th = load_config("checks.json")["thresholds"]
    limit = th["snippet_chars"]
    cap = th["max_listed_cases"]
    pr = prep.get("pr", {})
    L = []
    title = f"#{pr.get('number')} {pr.get('title')}" if pr else prep.get("range", "")
    L.append(f"# LightningCSS review: {title}")
    L.append("")
    c = ev["counts"]
    L.append(f"**VERDICT: {verdict_line(ev['verdict'], ev.get('scope'))}** · {c['BLOCKER']} blocker · {c['MAJOR']} major · {c['MINOR']} minor · {c['NOTE']} note")
    L.append("")
    if ev.get("scope"):
        L.append(f"- Every delta needs {ev['scope']['text'].replace(' only', '')}: the default path is byte-identical ({ev['scope']['default_requests']} requests)")
    for line in ev.get("decision", []):
        L.append(f"- Decision needed: {line}")
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
        origin = f" (analysis {f['id']})" if f.get("source") == "analysis" else ""
        L.append(f"### F{f['n']} [{f['severity']}] {tag}{f['title']}{origin}")
        L.append("")
        if f.get("detail"):
            L.append(str(f["detail"]))
            L.append("")
        for item in f.get("evidence") or []:
            L.append(f"- {item}")
        if f.get("folded"):
            L.append("")
            L.append("Also reported by:")
            L.append("")
            for x in f["folded"]:
                L.append(f"- [{x['check'] or x['source']}] ({x['severity']}) {snippet(x['title'], 200)}")
        if f.get("related"):
            L.append("")
            L.append("See also: " + "; ".join(f["related"]))
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
    L.append(f"- Areas: {', '.join(prep.get('areas', [])) or 'none'} · from tests: {', '.join(prep.get('test_areas', [])) or 'none'} · blast radius adds: {', '.join(prep.get('radius_areas', [])) or 'none'}")
    file_areas = prep.get("file_areas", {})
    for path, info in sorted(prep.get("files", {}).items()):
        L.append(f"  - `{path}` {info['status']} +{info['added']}/-{info['removed']} → {', '.join(file_areas.get(path, []) if isinstance(file_areas, dict) else [])}")
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
    extended = ev.get("extended", {})
    groups = [
        ("4.1 Regressions", lambda cid, s, v: (s["transition"] in BAD_TRANSITIONS and cid not in extended) or (s["transition"] == "introduced" and s["head"] == "different")),
        ("4.2 Changed and still different from input", lambda cid, s, v: s["transition"] == "still-different" and not s.get("neutral")),
        ("4.3 Fixed by this PR", lambda cid, s, v: s["transition"] == "fixed"),
        ("4.4 Lowering regressions (legacy engines)", lambda cid, s, v: any(ls["transition"] in BAD_TRANSITIONS for ls in v["summary"].get("legacy", {}).values())),
    ]
    for heading, pred in groups:
        ids = sorted({cid for cid, vs in oracle.get("verdicts", {}).items() for v in vs if pred(cid, v["summary"]["latest"], v)})
        L.append(f"### {heading} ({len(ids)})")
        L.append("")
        if heading.startswith("4.3") and ev.get("probe_fixed"):
            L.append("Probe assertions that fail on base and pass on head: " + ", ".join(f"`{x}`" for x in ev["probe_fixed"][:cap]) + (f" (+{len(ev['probe_fixed']) - cap} more)" if len(ev["probe_fixed"]) > cap else ""))
            L.append("")
        for cid in ids[:cap]:
            L.extend(case_block(ev, run_dir, cid, base_out, head_out, limit))
            L.append("")
        if len(ids) > cap:
            L.append(f"_{len(ids) - cap} more in oracle.json_")
            L.append("")
    verdicts = oracle.get("verdicts", {})
    unv = sorted(cid for cid in ev["deltas"] if cid not in verdicts or all(v["summary"]["latest"]["transition"] in ("unverified", "errored") for v in verdicts[cid]))
    L.append(f"### 4.5 Deltas the oracle could not verify ({len(unv)})")
    L.append("")
    for cid in unv[:cap]:
        d = classified(analysis, cid, ev["cases"].get(cid, {}).get("source", ""))
        why = "not run" if cid not in verdicts else ("errored" if any(v["summary"]["latest"]["transition"] == "errored" for v in verdicts[cid]) else "unverified")
        L.append(f"- `{cid}` ({why}) {describe_case(ev['cases'].get(cid, {}))} — {('**' + d['classification'] + '**: ' + d['reason']) if d else 'unclassified'}")
    if len(unv) > cap:
        L.append(f"- _{len(unv) - cap} more in corpus/deltas.jsonl_")
    L.append("")
    dec = sorted({cid for cid, vs in verdicts.items() for v in vs if v["summary"]["latest"]["transition"] == "input-rejected" and cid in ev["deltas"]} | set(extended)
                 | {cid for cid in ev["deltas"] if (classified(analysis, cid, ev["cases"].get(cid, {}).get("source", "")) or {}).get("classification") == "NEEDS_MAINTAINER_DECISION"})
    L.append(f"### 4.6 Decision needed ({len(dec)})")
    L.append("")
    L.append("Cases the browsers cannot judge against base (input rejected in every engine), outputs base already produces for other targets, and cases classified NEEDS_MAINTAINER_DECISION.")
    L.append("")
    for cid in dec[:cap]:
        d = classified(analysis, cid, ev["cases"].get(cid, {}).get("source", ""))
        why = f"base test `{extended[cid]}` gives this output for other targets" if cid in extended else ("input rejected in every engine" if cid in verdicts and any(v["summary"]["latest"]["transition"] == "input-rejected" for v in verdicts[cid]) else "classified")
        L.append(f"- `{cid}` ({why}) — {('**' + d['classification'] + '**: ' + d['reason']) if d else 'unclassified'}")
    if len(dec) > cap:
        L.append(f"- _{len(dec) - cap} more_")
    L.append("")
    pre = sorted(cid for cid in ev["deltas"] if (classified(analysis, cid, ev["cases"].get(cid, {}).get("source", "")) or {}).get("classification") == "PRE_EXISTING")
    L.append(f"### 4.7 Pre-existing (base wrong the same way) ({len(pre)})")
    L.append("")
    for cid in pre[:cap]:
        d = classified(analysis, cid, ev["cases"].get(cid, {}).get("source", ""))
        L.append(f"- `{cid}` — {d['reason']}")
    if len(pre) > cap:
        L.append(f"- _{len(pre) - cap} more_")
    L.append("")

    L.append("## 5. Test expectations")
    L.append("")
    tup = corpus.get("tuples", {})
    ts = corpus.get("tuple_stats", {})
    changed_heads = {m.get("head_id") for m in tup.get("modified", [])}
    L.append(f"Recorded helper calls: base {ts.get('base_tuples', 0)}, head {ts.get('head_tuples', 0)} (unmappable: {ts.get('unmappable', 0)}).")
    L.append("")
    for key, label in (("new_failing_on_base", "New cases that fail on base (exercise the change)"), ("new_passing_on_base", "New cases that already pass on base"), ("modified", "Changed expectations"), ("removed_changed", "Removed cases whose behavior changed"), ("removed_same", "Removed cases, behavior unchanged"), ("head_mismatch", "Not reproduced by the adapter (excluded)")):
        rows = [r for r in tup.get(key, []) if key == "modified" or r.get("id") not in changed_heads]
        L.append(f"- {label}: {len(rows)}")
        for r in rows[:6]:
            L.append(f"  - `{r['test'].split('::')[-1]}` lib.rs:{r['line']}{' → lib.rs:' + str(r['head_line']) if r.get('head_line') else ''}")
    unm = [u for u in ts.get("unmappable_cases", []) if u.get("in_diff")]
    if unm:
        L.append(f"- In the diff but not runnable through the adapter: {len(unm)}")
        for u in unm[:6]:
            L.append(f"  - `{u['test'].split('::')[-1]}` lib.rs:{u.get('line')}: {u.get('reason') or u.get('helper')}")
    L.append("")

    L.append("## 6. Spec checklist")
    L.append("")
    if ev["checklist"]:
        L.append("| Item | Severity | Check | Answer | Evidence |")
        L.append("|---|---|---|---|---|")
        for it in ev["checklist"]:
            a = ev["answers"].get(it["item"], {})
            sev = it["severity"] + (f" → {a['effective_severity']}" if a.get("effective_severity") and a.get("severity_reason") and a["effective_severity"] in SEV_RANK and SEV_RANK[a["effective_severity"]] > SEV_RANK[it["severity"]] else "")
            L.append(f"| {it['item']} | {sev} | {md_cell(snippet(it['text'], 140))} | {a.get('answer') or '—'}{' (area)' if a.get('area_level') else ''} | {md_cell(snippet(a.get('evidence', ''), 140))} |")
    else:
        L.append("No checklist applies.")
    L.append("")

    L.append("## 7. Robustness and stability")
    L.append("")
    rb = corpus.get("robustness", {})
    L.append(f"- Panics/crashes/timeouts: head {len(rb.get('head', []))}, base {len(rb.get('base', []))}")
    for r in rb.get("head", [])[:6]:
        L.append(f"  - `{r['id']}` {r['stage']}: {snippet(r['error'], 160)}")
    L.append(f"- Not idempotent on head only (second minify pass changes output): {len(corpus.get('idempotency_failures', []))}")
    for i in corpus.get("idempotency_failures", [])[:6]:
        L.append(f"  - `{i}`")
    if "idempotency_preexisting" in corpus:
        L.append(f"- Not idempotent on base and head alike (pre-existing): {len(corpus['idempotency_preexisting'])}")
        for i in corpus["idempotency_preexisting"][:6]:
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
        for pid, p in rows[:cap]:
            L.append(f"- `{pid}` ({p['known']}): fails {', '.join(p['fails_on_master'])}")
        if len(rows) > cap:
            L.append(f"- _{len(rows) - cap} more in {cache_dir() / 'baseline.json'}_")
    L.append("")

    L.append("## 10. Coverage and limits")
    L.append("")
    L.append("- Stages: " + ", ".join(f"{k} {'✓' if v else '✗'}" for k, v in ev["stages"].items()))
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
        "verdict_scope": ev["scope"]["text"] if ev.get("scope") else None,
        "default_requests": ev["scope"]["default_requests"] if ev.get("scope") else None,
        "decision_needed": ev["decision"],
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
    print(f"VERDICT: {verdict_line(ev['verdict'], ev.get('scope'))} ({', '.join(f'{v} {k.lower()}' for k, v in ev['counts'].items())})")
    print(run_dir / "report.md")
    return data


def delta_coverage(corpus: dict, oracle: dict, deltas: set | None = None) -> tuple[int, int, int]:
    """(deltas, verified in a browser, errored) counted over behavioral deltas only."""
    verdicts = oracle.get("verdicts") or {}
    total = sum((corpus.get("deltas") or {}).values())
    ids = deltas if deltas is not None else set(verdicts)
    verified = sum(1 for cid in ids if cid in verdicts and any(v["summary"]["latest"]["transition"] not in NOT_VERIFIED for v in verdicts[cid]))
    errored = sum(1 for cid in ids if cid in verdicts and any(v["summary"]["latest"]["transition"] == "errored" for v in verdicts[cid]))
    return total, verified, errored


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
        tag = f"[{f['check']}] " if f.get("check") and f.get("source") == "checklist" else ""
        line = f"{i}. [{f['severity']}] {tag}{snippet_words(f['title'], 160)}" + (f" — {snippet_words(ev, 140)}" if ev else "")
        if f.get("folded"):
            line += f" (also: {', '.join(sorted({x['check'] or x['source'] for x in f['folded']}))})"
        if f.get("related"):
            line += f" (see {'; '.join(snippet_words(r, 100) for r in f['related'])})"
        lines.append(line)
    engines = "; ".join(f"{p}: " + ", ".join(f"{k} {v}" for k, v in sorted(vs.items()) if k in ("chromium", "firefox", "webkit")) for p, vs in sorted((oracle.get("profiles") or {}).items(), key=lambda x: x[0] != "latest")) or "no browser run"
    delta_ids = {d["id"] for d in read_jsonl(run_dir / "corpus" / "deltas.jsonl")}
    deltas_total, verified, errored = delta_coverage(corpus, oracle, delta_ids)
    decision = rep.get("decision_needed") or []
    tmpl = (SKILL_DIR / "templates" / "summary.md.tmpl").read_text()
    text = tmpl.format(
        pr=rep.get("pr") or prep.get("range", ""),
        verdict=rep["verdict"],
        scope=f" ({rep['verdict_scope']})" if rep.get("verdict_scope") else "",
        blocker=rep["counts"]["BLOCKER"], major=rep["counts"]["MAJOR"], minor=rep["counts"]["MINOR"], note=rep["counts"]["NOTE"],
        intent_summary=(analysis.get("intent") or {}).get("summary") or prep.get("pr", {}).get("title", ""),
        findings_list="\n".join(lines) or "None.",
        decision_block=("\nDecision needed:\n" + "\n".join(f"- {snippet_words(d, 200)}" for d in decision) + "\n") if decision else "",
        engines=engines,
        deltas_total=deltas_total,
        deltas_verified=verified,
        deltas_errored=f", {errored} errored" if errored else "",
        default_path=f"; default path byte-identical ({rep['default_requests']} requests)" if rep.get("verdict_scope") else "",
        probes_pr=sum(1 for p in corpus.get("probes", []) if p.get("origin") == "pr"),
        mutations=(corpus.get("cases") or {}).get("mutation", 0),
        wpt_cases=(corpus.get("cases") or {}).get("wpt", 0),
        realworld_files=len({s["name"] for s in corpus.get("size", [])}),
        report_path=str(run_dir / "report.md"),
    )
    print(text)
    return text
