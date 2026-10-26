"""Unit tests for the check catalog, verdict rules, findings and worklist. Run: python3 -I -m unittest discover -s tests"""
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "lib"))

from lcr import report, status  # noqa: E402

ENGINES = ("chromium", "firefox", "webkit")
SPEC = "https://drafts.csswg.org/css-color-4/#x"


def verdict(cid, base="equivalent", head="equivalent", transition="both-equivalent", per_engine=None, legacy=None, **extra):
    """One light-scheme oracle verdict. per_engine: {engine: (base, head)} overrides."""
    per = {e: (base, head) for e in ENGINES}
    per.update(per_engine or {})
    latest = {e: {"touched": 1, "version": "1", "variants": {"base": {"status": b, "hardRejected": 0, "diffs": []}, "head": {"status": h, "hardRejected": 0, "diffs": []}}} for e, (b, h) in per.items()}
    ok = lambda side: sorted(e for e, s in per.items() if s[side] in ("equivalent", "near"))
    bad = lambda side: sorted(e for e, s in per.items() if s[side] == "different")
    summary = {
        "base": base, "head": head, "transition": transition, "rejectedBase": 0, "rejectedHead": 0, "visualBase": False, "visualHead": False,
        "enginesBase": {"ok": ok(0), "bad": bad(0), "divergent": bool(ok(0) and bad(0))},
        "enginesHead": {"ok": ok(1), "bad": bad(1), "divergent": bool(ok(1) and bad(1))},
        "engines": {e: {"base": b, "head": h} for e, (b, h) in per.items()}, "inert": [], "errored": [], "divergent": False, "neutral": False,
    }
    summary.update(extra)
    return [{"id": cid, "case": cid, "kind": "sheet", "scheme": "light", "latest": latest, "legacy": {}, "summary": {"latest": summary, "legacy": legacy or {}}}]


def probe_case(cid, area="color", origin="pr", mode="minify", targets=None, repro=None, known="none", flags=None):
    req = {"kind": "sheet", "css": ".t{color:red}", "minify": True, "compact": mode in ("minify", "lower-minify"), "targets": targets}
    if flags:
        req["flags"] = flags
    return {"id": cid, "source": "probe", "origin": origin, "area": area, "request": req,
            "probe": {"id": cid[2:], "area": area, "title": "t", "mode": mode, "expect": [], "known": known, "repro": repro}}


def mutation_case(parent, name, area="color"):
    return {"id": f"m-{parent}-{name}", "source": "mutation", "mutation": name, "parent": parent, "area": area, "request": {"kind": "sheet", "css": ".t{color:red}", "minify": True}}


class Run:
    """A synthetic run directory with every stage file the report reads."""

    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name) / "run"
        self.prep = {"run_id": "run", "strategy": "local-range", "base": "b" * 40, "head_tree": "h" * 40, "areas": ["color"], "files": {"src/values/color.rs": {"status": "M", "added": 1, "removed": 1}},
                     "file_areas": {"src/values/color.rs": ["color"]}, "linked_issues": [], "overlapping_prs": [], "risk_flags": []}
        self.build = {"head": {"summary": {"passed": 1, "ignored": 0}}, "base": {}, "js": {}}
        self.corpus = {"cases": {}, "deltas": {}, "tuples": {}, "tuple_stats": {}, "robustness": {"head": [], "base": []}, "idempotency": {}, "idempotency_failures": [], "probes": [], "size": []}
        self.oracle = {"profiles": {"latest": {"chromium": "1"}}, "verdicts": {}}
        self.analysis = {"intent": {"kind": "bugfix", "summary": "s"}, "checklist": [], "deltas": [], "findings": []}
        self.cases, self.delta_ids, self.out = {}, set(), {"base": {}, "head": {}}

    def case(self, c, delta=False, base_code="a", head_code=None):
        self.cases[c["id"]] = c
        if delta:
            self.delta_ids.add(c["id"])
        self.out["base"][c["id"]] = {"ok": True, "code": base_code}
        self.out["head"][c["id"]] = {"ok": True, "code": head_code if head_code is not None else (base_code + "x" if delta else base_code)}
        return c["id"]

    def write(self):
        d = self.dir
        (d / "corpus").mkdir(parents=True, exist_ok=True)
        for c in self.cases.values():
            self.corpus["cases"][c["source"]] = self.corpus["cases"].get(c["source"], 0)
        counts = {}
        for c in self.cases.values():
            counts[c["source"]] = counts.get(c["source"], 0) + 1
        self.corpus["cases"] = counts
        dcounts = {}
        for cid in self.delta_ids:
            src = self.cases[cid]["source"]
            dcounts[src] = dcounts.get(src, 0) + 1
        self.corpus["deltas"] = dcounts
        for name, value in (("prepare", self.prep), ("build", self.build), ("corpus", self.corpus), ("oracle", self.oracle), ("analysis", self.analysis)):
            if value is not None:
                (d / f"{name}.json").write_text(json.dumps(value, sort_keys=True))
            elif (d / f"{name}.json").exists():
                (d / f"{name}.json").unlink()
        (d / "corpus" / "cases.jsonl").write_text("".join(json.dumps(c, sort_keys=True) + "\n" for _, c in sorted(self.cases.items())))
        (d / "corpus" / "deltas.jsonl").write_text("".join(json.dumps({"id": cid, "source": self.cases[cid]["source"]}) + "\n" for cid in sorted(self.delta_ids)))
        for side in ("base", "head"):
            (d / "corpus" / f"outputs-{side}.jsonl").write_text("".join(json.dumps({"id": k, **v}, sort_keys=True) + "\n" for k, v in sorted(self.out[side].items())))
        return d

    def evaluate(self, checklist=()):
        self.write()
        with mock.patch.object(report, "load_checklists", lambda areas: [dict(it) for it in checklist]):
            return report.evaluate(self.dir)

    def close(self):
        self.tmp.cleanup()


def check(ev, cid):
    return next(c for c in ev["checks"] if c["id"] == cid)


ITEM = {"item": "COLOR-01", "severity": "MAJOR", "text": "Colors stay equivalent", "list": "color", "verify": "a `lower-minify` probe or a minify test", "covers": []}


class ReportTestCase(unittest.TestCase):
    def setUp(self):
        self.run = Run()

    def tearDown(self):
        self.run.close()


class ClassificationTest(ReportTestCase):
    def test_divergent_case_cleared_by_exact_id(self):
        r = self.run
        cid = r.case(probe_case("p-color/x"), delta=True)
        r.oracle["verdicts"][cid] = verdict(cid, "different", "different", "still-different", per_engine={"chromium": ("different", "equivalent"), "webkit": ("different", "equivalent")}, divergent=True)
        ev = r.evaluate()
        self.assertEqual(check(ev, "O9")["status"], "FAIL")
        self.assertIn("p-color/x [head equivalent in chromium, webkit; different in firefox; base different in", check(ev, "O9")["items"][0])
        r.analysis["deltas"] = [{"id": cid, "classification": "ORACLE_NOISE", "reason": f"firefox lags the spec {SPEC}"}]
        ev = r.evaluate()
        self.assertEqual(check(ev, "O9")["status"], "PASS")
        self.assertEqual(check(ev, "A3")["status"], "PASS")

    def test_glob_clearing_needs_spec_citation_too(self):
        r = self.run
        cid = r.case(probe_case("p-color/x"), delta=True)
        r.oracle["verdicts"][cid] = verdict(cid, "equivalent", "different", "regressed")
        r.analysis["deltas"] = [{"id": "p-color/*", "classification": "INTENDED", "reason": "on purpose"}]
        joined = check(r.evaluate(), "A3")["evidence"]
        self.assertIn("must cite the spec", joined)
        self.assertIn("a glob may not clear regressed case(s)", joined)

    def test_catch_all_glob_needs_one_transition(self):
        r = self.run
        for i, t in enumerate(("both-equivalent", "fixed")):
            cid = r.case({"id": f"w-{i:08x}", "source": "wpt", "wpt": {"property": "color", "file": "f", "value": "v", "kind": "valid"}, "mode": "minify", "request": {"kind": "property"}}, delta=True)
            r.oracle["verdicts"][cid] = verdict(cid, "different" if t == "fixed" else "equivalent", "equivalent", t)
        r.analysis["deltas"] = [{"id": "w-*", "classification": "INTENDED", "reason": "fine"}]
        self.assertIn("catch-all", check(r.evaluate(), "A3")["evidence"])

    def test_regression_is_one_finding_and_closes_the_check(self):
        r = self.run
        ids = [r.case(probe_case(f"p-color/r{i}"), delta=True) for i in range(2)]
        for cid in ids:
            r.oracle["verdicts"][cid] = verdict(cid, "equivalent", "different", "regressed")
        r.analysis["deltas"] = [{"id": cid, "classification": "REGRESSION", "reason": "drops the fallback"} for cid in ids]
        ev = r.evaluate()
        self.assertEqual(check(ev, "O1")["status"], "FAIL")
        regs = [f for f in ev["findings"] if f["title"].startswith("Regression")]
        self.assertEqual(len(regs), 1)
        self.assertEqual(regs[0]["evidence"], ids)
        self.assertFalse(any(f.get("check") == "O1" for f in ev["findings"]))
        self.assertEqual(ev["counts"]["BLOCKER"], 1)
        self.assertEqual(ev["verdict"], "UNSAFE")

    def test_regression_rejected_when_base_wrong_in_same_engines(self):
        r = self.run
        cid = r.case(probe_case("p-color/s"), delta=True)
        r.oracle["verdicts"][cid] = verdict(cid, "different", "different", "still-different", per_engine={"chromium": ("equivalent", "equivalent"), "firefox": ("different", "different"), "webkit": ("equivalent", "equivalent")})
        r.analysis["deltas"] = [{"id": cid, "classification": "REGRESSION", "reason": "worse"}]
        self.assertIn("base is wrong in the same engines (firefox)", check(r.evaluate(), "A3")["evidence"])

    def test_regression_on_both_equivalent_warns(self):
        r = self.run
        cid = r.case(probe_case("p-color/e"), delta=True)
        r.oracle["verdicts"][cid] = verdict(cid)
        r.analysis["deltas"] = [{"id": "p-color/*", "classification": "REGRESSION", "reason": "x"}]
        a3 = check(r.evaluate(), "A3")
        self.assertEqual(a3["status"], "PARTIAL")
        self.assertIn("both-equivalent", a3["evidence"])

    def test_maintainer_decision_closes_the_slot_and_never_blocks(self):
        r = self.run
        cid = r.case(probe_case("p-color/d"), delta=True)
        r.oracle["verdicts"][cid] = verdict(cid, "equivalent", "different", "regressed")
        r.analysis["deltas"] = [{"id": cid, "classification": "NEEDS_MAINTAINER_DECISION", "reason": "policy: keep the prefix?"}]
        ev = r.evaluate()
        self.assertEqual(check(ev, "O1")["status"], "PASS")
        self.assertEqual(ev["verdict"], "NEEDS_CHANGES")
        self.assertEqual(ev["decision"], ["policy: keep the prefix? (1 case(s))"])

    def test_pre_existing_needs_citation_and_base_wrong(self):
        r = self.run
        cid = r.case(probe_case("p-color/p"), delta=True)
        cur = r.case(probe_case("p-color/curated", origin="curated"))
        r.oracle["verdicts"][cid] = verdict(cid, "equivalent", "different", "regressed")
        r.analysis["deltas"] = [{"id": cid, "classification": "PRE_EXISTING", "reason": "same as before"}]
        joined = check(r.evaluate(), "A3")["evidence"]
        self.assertIn("PRE_EXISTING must cite", joined)
        self.assertIn("base renders equivalent in every engine", joined)
        r.oracle["verdicts"][cid] = verdict(cid, "different", "different", "still-different")
        r.corpus["probes"] = [{"id": cur, "probe": cur[2:], "origin": "curated", "known": "open-bug", "changed": False, "assert": {"base": {"output-contains:\"a\"": False}, "head": {"output-contains:\"a\"": False}}}]
        r.analysis["deltas"] = [{"id": cid, "classification": "PRE_EXISTING", "reason": f"base fails too, see {cur}"}]
        ev = r.evaluate()
        self.assertEqual(check(ev, "A3")["status"], "PASS")
        self.assertFalse([f for f in ev["findings"] if cid in f.get("evidence", [])])


class IncompleteAnalysisTest(ReportTestCase):
    def test_empty_analysis_is_inconclusive(self):
        self.run.analysis = {"intent": {"kind": "", "summary": ""}, "checklist": [], "deltas": [], "findings": []}
        ev = self.run.evaluate()
        self.assertEqual(check(ev, "A3")["status"], "FAIL")
        self.assertEqual(ev["verdict"], "INCONCLUSIVE")

    def test_proven_blocker_survives_an_incomplete_analysis(self):
        r = self.run
        cid = r.case(probe_case("p-color/reg"), delta=True)
        r.oracle["verdicts"][cid] = verdict(cid, "equivalent", "different", "regressed")
        r.analysis = {"intent": {"kind": "", "summary": ""}, "checklist": [], "deltas": [], "findings": []}
        self.assertEqual(r.evaluate()["verdict"], "UNSAFE")


class TransitionTest(ReportTestCase):
    def test_errored_delta_is_inconclusive_not_different(self):
        r = self.run
        cid = r.case(probe_case("p-color/err"), delta=True)
        r.oracle["verdicts"][cid] = verdict(cid, "error", "error", "errored")
        ev = r.evaluate()
        self.assertEqual(check(ev, "O1")["status"], "PASS")
        self.assertEqual(check(ev, "O8")["status"], "INCONCLUSIVE")
        self.assertEqual(ev["verdict"], "INCONCLUSIVE")
        self.assertEqual(report.delta_coverage(r.corpus, r.oracle, {cid}), (1, 0, 1))

    def test_input_rejected_goes_to_the_decision_bucket(self):
        r = self.run
        cid = r.case({"id": "t-1", "source": "tuple", "side": "head", "test": "tests::test_color", "helper": "minify_test", "line": 1, "request": {"kind": "sheet", "css": "x"}}, delta=True)
        r.corpus["tuples"] = {"modified": [{"id": "t-0", "head_id": cid, "test": "tests::test_color", "line": 1, "head_line": 2}]}
        r.oracle["verdicts"][cid] = verdict(cid, "no-coverage", "different", "input-rejected")
        ev = r.evaluate()
        for cid_ in ("O1", "O2"):
            self.assertEqual(check(ev, cid_)["status"], "PASS")
        self.assertEqual(check(ev, "T3")["status"], "PASS")
        self.assertEqual((check(ev, "O10")["status"], check(ev, "O10")["severity"]), ("PARTIAL", "NOTE"))
        self.assertNotEqual(ev["verdict"], "UNSAFE")

    def test_worsened_and_divergent_regressions_feed_o1(self):
        r = self.run
        w = r.case(probe_case("p-color/w"), delta=True)
        d = r.case(probe_case("p-color/d"), delta=True)
        r.oracle["verdicts"][w] = verdict(w, "different", "different", "worsened")
        r.oracle["verdicts"][d] = verdict(d, "equivalent", "different", "regressed", per_engine={"chromium": ("equivalent", "equivalent")}, divergent=True)
        ev = r.evaluate()
        self.assertEqual(check(ev, "O1")["items"], [d, w])
        self.assertEqual(check(ev, "O9")["status"], "PASS")

    def test_o3_counts_only_engines_in_targets(self):
        r = self.run
        cid = r.case(probe_case("p-color/rej", targets={"chrome": 120 << 16}), delta=True)
        v = verdict(cid)
        v[0]["latest"]["firefox"]["variants"]["head"]["hardRejected"] = 1
        r.oracle["verdicts"][cid] = v
        self.assertEqual(check(r.evaluate(), "O3")["status"], "PASS")
        v[0]["latest"]["chromium"]["variants"]["head"]["hardRejected"] = 1
        self.assertEqual(check(r.evaluate(), "O3")["status"], "FAIL")
        v[0]["latest"]["chromium"]["variants"]["head"]["rejected"] = {"decls": [{"prop": "animation-timeline", "value": "scroll()", "fallbackSurvives": False, "carrierRejected": True}]}
        self.assertEqual(check(r.evaluate(), "O3")["status"], "PASS")

    def test_differences_outside_the_targets_are_ignored(self):
        r = self.run
        cid = r.case(probe_case("p-color/lang", mode="lower", targets={"safari": 12 << 16}), delta=True)
        r.oracle["verdicts"][cid] = verdict(cid, "equivalent", "different", "regressed", per_engine={"webkit": ("equivalent", "equivalent")})
        o1 = check(r.evaluate(), "O1")
        self.assertEqual(o1["status"], "PASS")
        self.assertIn("1 case(s) differ only in engines outside their targets", o1["evidence"])

    def test_pre_existing_behavior_extended_to_new_targets(self):
        r = self.run
        css = ".a{animation:x 1s scroll()}"
        r.case({"id": "t-base", "source": "tuple", "side": "base", "test": "tests::test_animation", "helper": "prefix_test", "line": 1, "request": {"kind": "sheet", "css": css, "minify": True, "targets": {"safari": 16 << 16}}}, base_code="split")
        cid = r.case({"id": "t-head", "source": "tuple", "side": "head", "test": "tests::test_animation", "helper": "prefix_test", "line": 2, "request": {"kind": "sheet", "css": css, "minify": True, "targets": None}}, delta=True, base_code="kept", head_code="split")
        r.oracle["verdicts"][cid] = verdict(cid, "equivalent", "different", "regressed")
        ev = r.evaluate()
        self.assertEqual(check(ev, "O1")["status"], "PASS")
        self.assertIn("base test t-base already gives this output", check(ev, "O10")["items"][0])

    def test_flag_only_pr_introduced_cases_and_scope(self):
        r = self.run
        cid = r.case(probe_case("p-color/f", flags=["custom-functions"]), delta=True)
        r.case(probe_case("p-color/plain"))
        r.corpus["flag_only"] = {"custom-functions": [cid]}
        r.oracle["verdicts"][cid] = verdict(cid, "unknown", "different", "introduced")
        ev = r.evaluate()
        self.assertEqual(check(ev, "O2")["items"], [cid])
        self.assertEqual(ev["scope"], {"flags": ["custom-functions"], "default_requests": 1, "text": "flag custom-functions only"})


class StabilityAndBuildTest(ReportTestCase):
    def test_r2_charges_only_new_instability(self):
        r = self.run
        a = r.case(probe_case("p-color/a"), delta=True)
        b = r.case(probe_case("p-color/b"), delta=True)
        r.corpus.update({"idempotency_failures": [a], "idempotency_preexisting": [b]})
        self.assertEqual(check(r.evaluate(), "R2")["items"], [a])
        r.corpus.update({"idempotency_failures": []})
        r2 = check(r.evaluate(), "R2")
        self.assertEqual((r2["status"], r2["severity"]), ("PARTIAL", "NOTE"))

    def test_b11_diff_of_diffs(self):
        r = self.run
        r.build["js"] = {"ran": True, "regen_ast": True, "drift": {"node/ast.d.ts": "h1"}, "base_drift": {"node/ast.d.ts": "h1"}}
        self.assertEqual(check(r.evaluate(), "B11")["status"], "PARTIAL")
        r.build["js"]["drift"] = {"node/ast.d.ts": "h2"}
        self.assertEqual(check(r.evaluate(), "B11")["status"], "FAIL")


class ChecklistTest(ReportTestCase):
    def answer(self, **kw):
        self.run.analysis["checklist"] = [{"item": "COLOR-01", "evidence": "x", **kw}]

    def test_a1_is_a_row_and_failures_fold_into_linked_findings(self):
        r = self.run
        cid = r.case(probe_case("p-color/x"), delta=True)
        r.analysis["findings"] = [{"id": "F1", "severity": "MINOR", "title": "Gradient loses a stop", "evidence": [cid]}]
        self.answer(answer="FAIL", note="no alternative holds", finding="F1")
        ev = r.evaluate([ITEM])
        self.assertEqual(check(ev, "A1")["status"], "FAIL")
        self.assertFalse(any(f.get("check") == "A1" for f in ev["findings"]))
        self.assertEqual(len(ev["findings"]), 1)
        f = ev["findings"][0]
        self.assertEqual((f["severity"], f["folded"][0]["check"]), ("MAJOR", "COLOR-01"))

    def test_check_failure_folds_into_the_finding_citing_its_cases(self):
        r = self.run
        cid = r.case(probe_case("p-color/x"), delta=True)
        r.oracle["verdicts"][cid] = verdict(cid, "equivalent", "different", "regressed")
        r.analysis["findings"] = [{"severity": "MAJOR", "title": "Drops the fallback", "evidence": [f"{cid} renders red"]}]
        ev = r.evaluate()
        self.assertEqual([(f["severity"], f["title"]) for f in ev["findings"]], [("BLOCKER", "Drops the fallback")])

    def test_same_root_failure_folds_into_its_root(self):
        r = self.run
        r.case(probe_case("p-color/x"))
        root = {**ITEM, "item": "GEN-06", "severity": "BLOCKER", "list": "general", "verify": "mutations"}
        dep = {**ITEM, "item": "TESTS-03", "list": "tests", "verify": "mutations", "same_root_as": "GEN-06"}
        r.analysis["checklist"] = [{"item": "GEN-06", "answer": "FAIL", "evidence": "m-x"}, {"item": "TESTS-03", "answer": "FAIL", "evidence": "m-x"}]
        ev = r.evaluate([root, dep])
        self.assertEqual([(f["check"], f["severity"]) for f in ev["findings"]], [("GEN-06", "BLOCKER")])
        self.assertEqual([x["check"] for x in ev["findings"][0]["folded"]], ["TESTS-03"])
        # Alone, the dependent item is a finding of its own.
        r.analysis["checklist"] = [{"item": "GEN-06", "answer": "PASS", "evidence": "m-x"}, {"item": "TESTS-03", "answer": "FAIL", "evidence": "m-x"}]
        self.assertEqual([f["check"] for f in r.evaluate([root, dep])["findings"]], ["TESTS-03"])

    def test_load_checklists_reads_same_root_and_covers(self):
        items = {it["item"]: it for it in report.load_checklists(["tests", "build-release"])}
        self.assertEqual(items["TESTS-03"].get("same_root_as"), "GEN-06")
        self.assertIn(".github/workflows/*", items["BUILD-05"]["covers"])

    def test_fail_contradicting_its_verify_line(self):
        r = self.run
        cid = r.case(probe_case("p-color/lm", mode="lower-minify", targets={"chrome": 80 << 16}), delta=True)
        r.oracle["verdicts"][cid] = verdict(cid, "different", "equivalent", "fixed")
        self.answer(answer="FAIL", evidence=f"only {cid}")
        joined = check(r.evaluate([ITEM]), "A3")["evidence"]
        self.assertIn(f"FAIL cites {cid} (lower-minify, fixed), which its verify line accepts", joined)
        self.assertIn("why each verify alternative does not hold", joined)

    def test_effective_severity_downgrades_only(self):
        self.answer(answer="FAIL", note="n", effective_severity="MINOR", severity_reason="cosmetic `.0` only")
        ev = self.run.evaluate([ITEM])
        self.assertEqual(ev["verdict"], "SAFE_WITH_NITS")
        self.answer(answer="FAIL", note="n", effective_severity="BLOCKER", severity_reason="r")
        ev = self.run.evaluate([ITEM])
        self.assertEqual(ev["counts"]["BLOCKER"], 0)
        self.assertIn("cannot raise", check(ev, "A3")["evidence"])

    def test_fail_pre_existing_is_a_note(self):
        self.answer(answer="FAIL_PRE_EXISTING", evidence="base too, #710")
        ev = self.run.evaluate([ITEM])
        self.assertEqual(check(ev, "A1")["status"], "PASS")
        self.assertEqual([f["severity"] for f in ev["findings"]], ["NOTE"])
        self.answer(answer="FAIL_PRE_EXISTING", evidence="trust me")
        self.assertIn("FAIL_PRE_EXISTING needs", check(self.run.evaluate([ITEM]), "A3")["evidence"])

    def test_area_level_na(self):
        self.run.analysis["checklist"] = [{"area": "color", "answer": "N/A", "evidence": "diff touches no color code"}]
        ev = self.run.evaluate([ITEM])
        self.assertEqual(ev["answers"]["COLOR-01"]["answer"], "N/A")
        self.assertEqual(check(ev, "A3")["status"], "PASS")


class LinkedIssueTest(ReportTestCase):
    def setUp(self):
        super().setUp()
        self.run.prep["linked_issues"] = [{"number": 7, "state": "OPEN", "title": "t"}]

    def repro(self, transition, head="equivalent", per_engine=None, targets=None):
        r = self.run
        cid = r.case(probe_case("p-color/repro", repro="#7", known="open-bug", targets=targets), delta=True)
        r.case(probe_case("p-color/other", known="open-issue#7"))
        r.corpus["probes"] = [{"id": cid, "probe": cid[2:], "origin": "pr", "known": "open-bug", "repro": "#7", "changed": True, "assert": {"base": {"equivalent": None}, "head": {"equivalent": None}}}]
        r.oracle["verdicts"][cid] = verdict(cid, "different", head, transition, per_engine=per_engine)
        return check(r.evaluate(), "A2")

    def test_repro_fixed(self):
        self.assertEqual(self.repro("fixed")["status"], "PASS")

    def test_errored_oracle_is_inconclusive(self):
        r = self.run
        a2 = self.repro("errored", head="error", per_engine={e: ("error", "error") for e in ENGINES})
        self.assertEqual(a2["status"], "INCONCLUSIVE")

    def test_engines_outside_targets_do_not_count(self):
        a2 = self.repro("fixed", per_engine={"firefox": ("different", "different")}, targets={"chrome": 100 << 16})
        self.assertEqual(a2["status"], "PASS")

    def test_missing_repro_leads_the_evidence_before_probe_credit(self):
        r = self.run
        r.prep["linked_issues"] = [{"number": 7, "title": "x", "state": "OPEN", "closing": True}]
        cid = r.case(probe_case("p-color/curated", origin="curated", known="open-issue#7"), delta=True)
        r.oracle["verdicts"][cid] = verdict(cid, "different", "equivalent", "fixed")
        r.corpus["probes"] = [{"id": cid, "probe": cid[2:], "origin": "curated", "known": "open-issue#7", "assert": {"base": {"equivalent": None}, "head": {"equivalent": None}}}]
        r.analysis["deltas"] = [{"id": cid, "classification": "INTENDED", "reason": "fix"}]
        a2 = check(r.evaluate(), "A2")
        self.assertEqual((a2["status"], a2["items"]), ("FAIL", ["#7: no PR probe with `repro: #7`"]))
        self.assertIn("1 probe assertion(s) fixed by this PR", a2["evidence"])

    def test_closed_issue_without_repro_is_a_note(self):
        self.run.prep["linked_issues"] = [{"number": 9, "state": "CLOSED", "title": "t"}]
        a2 = check(self.run.evaluate(), "A2")
        self.assertEqual((a2["status"], a2["severity"]), ("PARTIAL", "NOTE"))


class ProbeAssertionTest(ReportTestCase):
    def test_assertion_broken_by_head_and_fixed_credit(self):
        r = self.run
        a = r.case(probe_case("p-color/a"), delta=True)
        b = r.case(probe_case("p-color/b", origin="curated", known="open-bug"), delta=True)
        r.corpus["probes"] = [
            {"id": a, "probe": a[2:], "origin": "pr", "known": "none", "changed": True, "assert": {"base": {'output-not-contains:"x"': True}, "head": {'output-not-contains:"x"': False}}},
            {"id": b, "probe": b[2:], "origin": "curated", "known": "open-bug", "changed": True, "assert": {"base": {"idempotent": None}, "head": {"idempotent": None}}},
        ]
        r.corpus["idempotency"] = {b: {"stable": True}}
        r.corpus["idempotency_base"] = {b: {"stable": False}}
        ev = r.evaluate()
        t6 = check(ev, "T6")
        self.assertEqual((t6["status"], t6["severity"]), ("FAIL", "MAJOR"))
        self.assertEqual(t6["items"], [f'{a}: output-not-contains:"x" (holds on base, fails on head)'])
        self.assertEqual(ev["probe_fixed"], [f"{b}: idempotent"])


class TestsChecksTest(ReportTestCase):
    def test_t2_splits_new_from_modified_and_t5_unmappable(self):
        r = self.run
        r.corpus["tuples"] = {
            "new_failing_on_base": [{"id": "t-mod", "test": "tests::test_color", "line": 3}],
            "new_passing_on_base": [{"id": "t-new", "test": "tests::test_color", "line": 4}],
            "modified": [{"id": "t-old", "head_id": "t-mod", "test": "tests::test_color", "line": 2, "head_line": 3}],
        }
        ev = r.evaluate()
        self.assertEqual(check(ev, "T2")["status"], "FAIL")
        self.assertIn("1 changed expectation(s) (T3)", check(ev, "T2")["evidence"])
        r.corpus["tuple_stats"] = {"unmappable_cases": [{"test": "tests::test_color", "line": 5, "helper": "minify_test", "side": "head", "in_diff": True, "reason": "unknown flag"}]}
        ev = r.evaluate()
        self.assertEqual(check(ev, "T2")["status"], "PARTIAL")
        self.assertEqual((check(ev, "T5")["status"], check(ev, "T5")["severity"]), ("PARTIAL", "MAJOR"))


class SideEffectTest(ReportTestCase):
    def test_s1_accepts_test_derived_areas(self):
        r = self.run
        cid = r.case(probe_case("p-selectors/x", area="selectors"), delta=True)
        r.oracle["verdicts"][cid] = verdict(cid, "different", "different", "still-different")
        self.assertEqual(check(r.evaluate(), "S1")["status"], "FAIL")
        r.prep["test_areas"] = ["selectors"]
        self.assertEqual(check(r.evaluate(), "S1")["status"], "PASS")

    def test_screenshot_errors_are_reported_in_o6(self):
        r = self.run
        cid = r.case(probe_case("p-color/x"), delta=True)
        r.oracle["verdicts"][cid] = verdict(cid, "equivalent", "equivalent", "both-equivalent", visualErrors=["webkit"])
        o6 = check(r.evaluate(), "O6")
        self.assertEqual(o6["status"], "PASS")
        self.assertIn("screenshot failed in webkit", o6["evidence"])

    def test_s2_sums_lower_minify(self):
        r = self.run
        r.corpus["size"] = [{"name": "a", "mode": "minify", "base": 1000, "head": 1000}, {"name": "a", "mode": "lower-minify", "base": 1000, "head": 1100}]
        s2 = check(r.evaluate(), "S2")
        self.assertEqual(s2["status"], "FAIL")
        self.assertIn("lower-minify total 1000 -> 1100", s2["evidence"])

    def test_s3_flags_duplicates(self):
        r = self.run
        r.prep["pr"] = {"author": "me", "number": 2}
        r.prep["overlapping_prs"] = [{"number": 1, "title": "same fix", "author": "me", "shared_files": ["src/x.rs"]}, {"number": 3, "title": "other", "author": "you", "shared_files": ["src/x.rs"]}]
        s3 = check(r.evaluate(), "S3")
        self.assertIn("possible duplicate of #1", s3["evidence"])
        self.assertTrue(s3["items"][0].startswith("#1 same fix: possible duplicate (same author"))


class HelpersTest(unittest.TestCase):
    def test_case_id_strips_annotations(self):
        self.assertEqual(report.case_id("p-a/b~dark@legacy-2021 [head equivalent in x]"), "p-a/b")

    def test_snippet_words(self):
        self.assertEqual(report.snippet_words("alpha beta gamma delta", 15), "alpha beta…")

    def test_diff_excerpt_shows_the_changed_part(self):
        a = "x" * 500 + "color:red" + "y" * 500
        b = "x" * 500 + "color:blue" + "y" * 500
        text = report.diff_excerpt(a, b, 200)
        self.assertIn("color:red", text)
        self.assertIn("color:blue", text)
        self.assertLess(len(text), 400)

    def test_untouched_covers(self):
        self.assertTrue(report.untouched_covers({"covers": ["src/rules/*.rs"]}, ["src/values/color.rs"]))
        self.assertFalse(report.untouched_covers({"covers": ["src/rules/*.rs"]}, ["src/rules/supports.rs"]))
        self.assertFalse(report.untouched_covers({"covers": []}, ["src/values/color.rs"]))


class WorklistTest(ReportTestCase):
    def run_worklist(self, checklist=()):
        self.run.write()
        with mock.patch.object(report, "load_checklists", lambda areas: [dict(it) for it in checklist]), redirect_stdout(io.StringIO()):
            out = status.worklist(self.run.dir)
        return out, json.loads((self.run.dir / "analysis.json").read_text())

    def test_slots_are_uncapped_grouped_and_stale_marked(self):
        r = self.run
        parent = r.case(probe_case("p-color/x"))
        muts = [r.case(mutation_case(parent, f"wrap-{i}"), delta=True) for i in range(14)]
        for m in muts:
            r.oracle["verdicts"][m] = verdict(m, "no-coverage", "no-coverage", "unverified")
        reg = r.case(probe_case("p-color/reg"), delta=True)
        r.case(mutation_case(reg, "nest"), delta=True)
        r.oracle["verdicts"][reg] = verdict(reg, "equivalent", "different", "regressed")
        r.analysis["deltas"] = [{"id": "p-color/gone", "classification": "", "reason": ""}]
        out, analysis = self.run_worklist()
        slots = {s["id"]: s for s in out["deltas"]}
        self.assertEqual(slots["m-p-color/x-*"]["count"], 14)
        self.assertEqual(slots[reg]["checks"], ["O1"])
        self.assertEqual(out["stale_slots"], ["p-color/gone"])
        self.assertTrue(next(d for d in analysis["deltas"] if d["id"] == "p-color/gone")["_stale"])
        for d in analysis["deltas"]:
            if d["id"] == "m-p-color/x-*":
                d.update(classification="ORACLE_NOISE", reason="L1 no coverage")
        r.analysis = analysis
        ev = r.evaluate()
        self.assertEqual(check(ev, "O8")["status"], "FAIL")
        self.assertNotIn("p-color/gone", check(ev, "A3")["evidence"])
        self.assertEqual({s["id"] for s in report.open_slots(ev)}, {reg, f"m-{reg}-nest"})

    def test_items_for_untouched_files_are_prefilled(self):
        item = {**ITEM, "covers": ["src/rules/*.rs"]}
        out, analysis = self.run_worklist([item])
        self.assertEqual(out["prefilled_na"], ["COLOR-01"])
        self.assertEqual(out["checklist"], [])
        self.assertEqual(analysis["checklist"][0]["evidence"], "Covers src/rules/*.rs; diff touches none")


class StatusTest(ReportTestCase):
    def test_rows_report_open_slots_and_stale_oracle(self):
        r = self.run
        r.analysis["deltas"] = [{"id": "x", "classification": ""}]
        d = r.write()
        r.oracle["inputs"] = {"cases": "0" * 64}
        (d / "oracle.json").write_text(json.dumps(r.oracle))
        rows = dict(status.stage_rows(d))
        self.assertEqual(rows["analysis"], "open (1 slots; refresh with `lcr worklist`)")
        self.assertIn("stale", rows["oracle"])
        self.assertEqual(rows["probe"], "-")


class RenderTest(ReportTestCase):
    def test_report_and_summary_are_deterministic(self):
        r = self.run
        cid = r.case(probe_case("p-color/f", flags=["custom-functions"]), delta=True)
        r.corpus["flag_only"] = {"custom-functions": [cid]}
        neutral = r.case(probe_case("p-color/n"))
        r.oracle["verdicts"][cid] = verdict(cid, "unknown", "different", "introduced")
        r.oracle["verdicts"][neutral] = verdict(neutral, "different", "different", "still-different", neutral=True)
        r.analysis["deltas"] = [{"id": neutral, "classification": "NEEDS_MAINTAINER_DECISION", "reason": "keep it?"}]
        r.write()
        texts = []
        for _ in range(2):
            with mock.patch.object(report, "load_checklists", lambda areas: []), redirect_stdout(io.StringIO()):
                report.report(r.dir)
                texts.append(((r.dir / "report.md").read_text(), (r.dir / "report.json").read_text(), report.summary(r.dir)))
        self.assertEqual(texts[0], texts[1])
        md, rep, summ = texts[0]
        self.assertIn("**VERDICT: UNSAFE (flag custom-functions only)**", md)
        self.assertIn("### 4.2 Changed and still different from input (0)", md)
        self.assertIn("default path byte-identical (1 requests)", summ)
        self.assertIn("Decision needed:\n- keep it? (1 case(s))", summ)
        self.assertEqual(json.loads(rep)["verdict_scope"], "flag custom-functions only")


if __name__ == "__main__":
    unittest.main()
