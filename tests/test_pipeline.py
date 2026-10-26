"""Unit tests for the pipeline stages (adapter driver, tuples, probes, corpus, prepare, oracle driver,
inspection). Run: python3 -I -m unittest discover -s tests"""
import contextlib
import errno
import io
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "lib"))

from lcr import adapter, build, common, corpus, mutations, oracle, prepare, probes, show, tuples  # noqa: E402
import lcr_main  # noqa: E402

# A stand-in for the JSONL adapter: echoes the CSS as the output. `hang` leaves a grandchild that
# holds stdout open for a while (so the killed process's EOF arrives late) and never answers;
# `sleep:<s>` answers after <s> seconds. FLAG names a parser flag this "revision" does not know.
FAKE_ADAPTER = r'''#!/usr/bin/env python3
import json, subprocess, sys, time
FLAG = %r
for line in sys.stdin:
    req = json.loads(line)
    css = req.get("css", "")
    if css == "hang":
        subprocess.Popen(["sleep", "1.5"])
        time.sleep(30)
    if css.startswith("sleep:"):
        time.sleep(float(css.split(":")[1]))
    if FLAG and FLAG in req.get("flags", []):
        out = {"id": req["id"], "ok": False, "stage": "request", "error": "unknown parser flag " + FLAG}
    else:
        out = {"id": req["id"], "ok": True, "code": css.replace("  ", " ")}
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()
'''


def fake_adapter(directory: Path, name: str, unknown_flag: str = "") -> Path:
    path = directory / name
    path.write_text(FAKE_ADAPTER % unknown_flag)
    path.chmod(0o755)
    return path


def write_probe(directory: Path, slug: str, extra: str = "", css: str = ".t { color: red }", area: str = "color") -> Path:
    path = directory / f"{slug}.css"
    path.write_text(f"/*! lcr-probe\nid: {area}/{slug}\narea: {area}\ntitle: t\nmode: minify\ntargets: none\nexpect: idempotent, output-contains:\"red\"\nknown: none\nref: https://drafts.csswg.org/css-color-4/#x\n{extra}*/\n{css}\n")
    return path


class AdapterTest(unittest.TestCase):
    def test_restart_after_timeout_does_not_hang(self):
        with tempfile.TemporaryDirectory() as d:
            proc = adapter.AdapterProcess(fake_adapter(Path(d), "a"), timeout=0.5)
            try:
                self.assertEqual(proc.request({"id": "1", "css": "hang"})["stage"], "timeout")
                self.assertTrue(proc.request({"id": "2", "css": "a"})["ok"])
                time.sleep(2)  # the killed adapter's EOF arrives now; it must not reach the new queue
                started = time.time()
                self.assertTrue(proc.request({"id": "3", "css": "b"})["ok"])
                self.assertLess(time.time() - started, 2)
            finally:
                proc.close()

    def test_per_request_timeout(self):
        with tempfile.TemporaryDirectory() as d:
            binary = fake_adapter(Path(d), "a")
            out = adapter.run_requests(binary, [{"id": "slow", "css": "sleep:1", "_timeout": 3}, {"id": "short", "css": "sleep:1", "_timeout": 0.3}], workers=1, timeout=10)
        self.assertTrue(out["slow"]["ok"])
        self.assertEqual(out["slow"]["code"], "sleep:1")
        self.assertEqual(out["short"]["stage"], "timeout")


class TupleFlagsTest(unittest.TestCase):
    def test_unknown_parser_flag_passes_through(self):
        t = {"helper": "minify_test_with_options_and_browsers", "fields": {"source": "@function --f() {}", "expected": "x", "browsers": "None", "options": {"flags": "ParserFlags(NESTING | CUSTOM_FUNCTIONS)"}}}
        [(_, req, _)] = tuples.to_requests(t, {})
        self.assertEqual(req["flags"], ["custom-functions", "nesting"])

    def test_mapping_problem_names_the_reason(self):
        self.assertIn("no adapter mapping", tuples.mapping_problem({"helper": "nope", "fields": {}}))
        self.assertIsNone(tuples.to_requests({"helper": "nope", "fields": {}}, {}))

    def test_rejected_tuples_are_unmappable_with_reason(self):
        cases = [
            {"id": "t-a", "source": "tuple", "side": "head", "helper": "h", "test": "x::test_f", "line": 3, "in_diff": True},
            {"id": "t-b", "source": "tuple", "side": "both", "helper": "h", "test": "x::test_g", "line": 9, "in_diff": False},
        ]
        head = {"t-a": {"ok": False, "stage": "request", "error": "unknown parser flag custom-functions"}, "t-b": {"ok": True, "code": ""}}
        [row] = corpus.rejected_tuples(cases, head)
        self.assertEqual(row["id"], "t-a")
        self.assertTrue(row["in_diff"])
        self.assertIn("unknown parser flag custom-functions", row["reason"])
        rows = corpus.sort_unmappable([{**row, "in_diff": False}, row, row])
        self.assertEqual([(r["in_diff"], r["count"]) for r in rows], [(True, 2), (False, 1)])


class ProbeHeaderTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

    def test_repro_and_timeout(self):
        p = probes.parse_probe(write_probe(self.dir, "x", "repro: #1291\ntimeout: 60\n"))
        self.assertEqual(p.errors, [])
        self.assertEqual((p.repro, p.timeout), (1291, 60.0))
        bad = probes.parse_probe(write_probe(self.dir, "y", "repro: 1291\ntimeout: 9999\n"))
        joined = " | ".join(bad.errors)
        self.assertIn("bad repro", joined)
        self.assertIn("bad timeout", joined)

    def test_ref_placeholders_rejected(self):
        path = self.dir / "z.css"
        for ref in ("https://github.com/parcel-bundler/lightningcss/pull/<open", "https://github.com/x/y/pull/N", "see-spec", "https://x/…"):
            path.write_text(f"/*! lcr-probe\nid: color/z\narea: color\ntitle: t\nmode: minify\nexpect: no-panic\nknown: none\nref: {ref}\n*/\n.t{{}}\n")
            self.assertTrue(any("bad ref" in e for e in probes.parse_probe(path).errors), ref)
        path.write_text("/*! lcr-probe\nid: color/z\narea: color\ntitle: t\nmode: minify\nexpect: no-panic\nknown: none\nref: https://github.com/parcel-bundler/lightningcss/issues/1291 https://drafts.csswg.org/css-color-4/#missing\n*/\n.t{}\n")
        self.assertEqual(probes.parse_probe(path).errors, [])

    def test_lower_without_targets_is_pretty_minify(self):
        path = self.dir / "w.css"
        path.write_text("/*! lcr-probe\nid: color/w\narea: color\ntitle: t\nmode: lower\ntargets: none\nexpect: no-panic\nknown: none\nref: https://x.org/\n*/\n.t{}\n")
        p = probes.parse_probe(path)
        self.assertEqual(p.errors, [])
        self.assertEqual(p.request(), {"kind": "sheet", "css": ".t{}\n", "minify": True, "compact": False, "targets": None})

    def test_basename_mismatch_and_unknown_key_warn(self):
        path = self.dir / "other-name.css"
        path.write_text("/*! lcr-probe\nid: color/w\narea: color\ntitle: t\nmode: minify\nexpect: no-panic\nknown: none\nref: https://x.org/\nexpected: x\n*/\n.t{}\n")
        p = probes.parse_probe(path)
        self.assertEqual(p.errors, [])
        self.assertEqual(len(p.warnings), 2)


class MutationDomTest(unittest.TestCase):
    def test_nest_wraps_the_dom_override(self):
        parent = {"id": "p-color/x", "source": "probe", "probe": {"area": "color", "dom": '<div class="a">x</div>'}, "timeout": 30, "request": {"kind": "sheet", "css": ".a { color: red }", "minify": True}}
        cases = {c["mutation"]: c for c in mutations.mutation_cases([parent])}
        self.assertEqual(cases["nest"]["dom"], '<div class="lcr-n"><div class="a">x</div></div>')
        self.assertNotIn("dom", cases["important"])
        self.assertEqual(cases["important"]["timeout"], 30)


class IdempotencyTest(unittest.TestCase):
    def test_split_is_base_aware(self):
        head = {"new": {"stable": False}, "pre": {"stable": False}, "fixed": {"stable": True}, "only-head": {"stable": False}}
        base = {"new": {"stable": True}, "pre": {"stable": False}, "fixed": {"stable": False}}
        self.assertEqual(corpus.idempotency_split(head, base), (["new", "only-head"], ["pre"]))

    def test_probe_assertions_are_filled(self):
        p = {"id": "p-a", "assert": {"base": {"idempotent": None, "equivalent": None}, "head": {"idempotent": None, "equivalent": None}}}
        corpus.fill_idempotent([p], {"p-a": {"stable": False}}, {"p-a": {"stable": True}})
        self.assertEqual(p["assert"]["head"], {"idempotent": False, "equivalent": None})
        self.assertEqual(p["assert"]["base"]["idempotent"], True)

    def test_print_mode_probe_that_expects_idempotent_is_rerun(self):
        cases = [
            {"id": "p", "request": {"kind": "sheet", "css": "a", "minify": False}, "probe": {"expect": ["idempotent"]}},
            {"id": "q", "request": {"kind": "sheet", "css": "a", "minify": False}, "probe": {"expect": []}},
            {"id": "m", "request": {"kind": "sheet", "css": "a", "minify": True, "css_modules": {}}},
        ]
        outs = {k: {"ok": True, "code": "x"} for k in ("p", "q", "m")}
        self.assertEqual([r["id"] for r in corpus.idempotency_requests(cases, outs)], ["p"])


class FlagOnlyTest(unittest.TestCase):
    def test_flag_only_lists_cases_base_cannot_run(self):
        cases = [{"id": i} for i in ("a", "b", "c", "d")]
        base = {"a": {"stage": "request", "error": "unknown parser flag custom-functions"}, "b": {"stage": "request", "error": "unknown parser flag custom-functions"}, "c": {"stage": "parse"}, "d": {"stage": "request", "error": "unknown parser flag x"}}
        head = {"a": {"ok": True}, "b": {"ok": False, "stage": "parse"}, "c": {"ok": True}, "d": {"stage": "request", "error": "unknown parser flag x"}}
        self.assertEqual(corpus.flag_only(cases, base, head), {"custom-functions": ["a", "b"]})
        self.assertEqual(corpus.merge_flag_only({"f": ["a", "z"]}, {"f": ["b"]}, {"a"}), {"f": ["b", "z"]})


class RunProbesTest(unittest.TestCase):
    """`lcr probe` on a synthetic run with fake adapters: deleted probes leave every stage."""

    def make_run(self) -> Path:
        run = Path(tempfile.mkdtemp())
        (run / "bin").mkdir()
        fake_adapter(run / "bin", "base-adapter", unknown_flag="custom-functions")
        fake_adapter(run / "bin", "head-adapter")
        (run / "probes").mkdir()
        write_probe(run / "probes", "kept")
        write_probe(run / "probes", "gone")
        write_probe(run / "probes", "flagged", "flags: custom-functions\n")
        for name in ("cases", "outputs-base", "outputs-head", "deltas"):
            common.write_jsonl(run / "corpus" / f"{name}.jsonl", [])
        common.write_json(run / "corpus.json", {"cases": {}, "deltas": {}, "robustness": {"base": [], "head": []}, "probes": [], "idempotency": {}, "idempotency_failures": []})
        return run

    def test_rerun_drops_deleted_probes(self):
        run = self.make_run()
        with contextlib.redirect_stdout(io.StringIO()):
            corpus.run_probes(run)
        ids = {c["id"] for c in common.read_jsonl(run / "corpus" / "cases.jsonl")}
        self.assertIn("p-color/gone", ids)
        self.assertTrue(any(i.startswith("m-p-color/gone-") for i in ids))
        common.write_json(run / "oracle.json", {"verdicts": {"p-color/gone": [], "p-color/kept": []}, "dom": {"p-color/gone": {}}})
        common.write_jsonl(run / "oracle" / "verdicts.jsonl", [{"case": "p-color/gone"}, {"case": "p-color/kept"}])
        (run / "probes" / "gone.css").unlink()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            summary = corpus.run_probes(run)
        self.assertNotIn("color/gone", out.getvalue())
        self.assertIn("color/kept", out.getvalue())
        ids = {c["id"] for c in common.read_jsonl(run / "corpus" / "cases.jsonl")}
        self.assertFalse(any("gone" in i for i in ids))
        self.assertFalse(any("gone" in r["id"] for r in common.read_jsonl(run / "corpus" / "outputs-head.jsonl")))
        self.assertFalse(any("gone" in k for k in summary["idempotency"]))
        self.assertEqual([p["probe"] for p in summary["probes"]], ["color/flagged", "color/kept"])
        self.assertEqual(summary["cases"]["probe"], 2)
        self.assertEqual(list(common.read_json(run / "oracle.json")["verdicts"]), ["p-color/kept"])
        self.assertEqual(common.read_jsonl(run / "oracle" / "verdicts.jsonl"), [{"case": "p-color/kept"}])
        kept = next(p for p in summary["probes"] if p["probe"] == "color/kept")
        self.assertEqual(kept["assert"]["head"]["idempotent"], True)
        self.assertEqual(summary["flag_only"]["custom-functions"][0], "m-p-color/flagged-duplicate-nonadjacent")
        self.assertIn("p-color/flagged", summary["flag_only"]["custom-functions"])
        self.assertEqual(summary["probe_files"], corpus.probe_files_hash(run))

    def test_probe_table(self):
        entries = [{"id": "p-a/x", "probe": "a/x", "changed": True, "assert": {"base": {"equivalent": None, "output-contains:\"r\"": False}, "head": {"equivalent": None, "output-contains:\"r\"": True}}, "crash": {"head": "timeout"}}]
        text = corpus.probe_table(entries, {"p-a/x": {"stable": True}}, {})
        lines = text.splitlines()
        self.assertEqual(lines[0], "PR probes: 1 (changed on head: 1)")
        self.assertIn("a/x  [changed]", lines[2])
        self.assertTrue(lines[3].split()[-2:] == ["FAIL", "pass"])
        self.assertIn("(re-minify stable)", lines[4])
        self.assertTrue(lines[4].endswith("-     pass") or lines[4].split()[-2:] == ["-", "pass"])
        self.assertEqual(lines[5].split()[-2:], ["-", "timeout"])


class PrepareAreasTest(unittest.TestCase):
    LIB = "\n".join([
        "  #[test]",
        "  pub fn test_flex() {",
        "    a",
        "  }",
        "",
        "  fn helper() {",
        "    h",
        "  }",
        "",
        "  #[cfg(feature = \"x\")]",
        "  #[test]",
        "  pub(crate) fn test_margin() {",
        "    b",
        "  }",
    ])

    def test_pub_test_fns_and_helpers(self):
        self.assertEqual(prepare.test_fns_in_ranges(self.LIB, [[3, 3]]), ["test_flex"])
        self.assertEqual(prepare.test_fns_in_ranges(self.LIB, [[5, 7]]), [])
        self.assertEqual(prepare.test_fns_in_ranges(self.LIB, [[10, 10]]), ["test_margin"])
        self.assertEqual(prepare.test_fns_in_ranges(self.LIB, [[13, 13]]), ["test_margin"])

    def test_changed_lines_skip_context(self):
        patch = "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -10,4 +10,5 @@\n ctx\n--- removed dashes\n+added\n+added2\n ctx\n ctx\n"
        self.assertEqual(prepare.changed_lines(patch)["src/lib.rs"], {"head": [[11, 12]], "base": [[11, 11]]})

    def test_change_areas(self):
        files = {
            "src/rules/function.rs": {"status": "A", "added_lines": ["let t: TokenList = x;"], "removed_lines": []},
            "src/rules/style.rs": {"status": "M", "added_lines": ["x"], "removed_lines": []},
            "src/lib.rs": {"status": "M", "added_lines": ["TokenList"], "removed_lines": []},
        }
        areas = prepare.change_areas(files)
        self.assertEqual(areas["src/rules/function.rs"], ["at-rules-other", "custom-properties"])
        self.assertEqual(areas["src/rules/style.rs"], ["rule-merging", "nesting", "selectors"])
        self.assertEqual(areas["src/lib.rs"], ["tests"])

    def test_compat_variants(self):
        text = "\n".join([
            "pub enum Feature {",
            "  AnyLink,",
            "  NewThing,",
            "}",
            "impl Feature {",
            "  pub fn is_compatible(&self, browsers: Browsers) -> bool {",
            "    match self {",
            "      Feature::AnyLink => {",
            "        if version < 5 {",
            "          return false;",
            "      }",
            "      Feature::A",
            "      | Feature::B => {",
            "        return false",
            "      }",
        ])
        self.assertEqual(prepare.compat_variants(text, [[3, 3]]), ["NewThing"])
        self.assertEqual(prepare.compat_variants(text, [[9, 9]]), ["AnyLink"])
        self.assertEqual(prepare.compat_variants(text, [[14, 14]]), ["A", "B"])

    def test_compat_radius_ignores_generic_feature_users(self):
        items = [{"file": "src/compat.rs", "item": {"name": "is_compatible"}, "impl": {"type": "Feature"}}]
        calls = []
        orig = prepare.grep_users
        prepare.grep_users = lambda tree, needle, exclude=(): calls.append((needle, exclude)) or []
        try:
            prepare.blast_radius("tree", items, ["AnyLink"])
        finally:
            prepare.grep_users = orig
        self.assertEqual(calls, [("Feature::AnyLink", ("src/compat.rs",))])


class LinkedIssuesTest(unittest.TestCase):
    def test_closing_issues(self):
        from lcr.prepare import closing_issue_numbers, linked_issue_numbers

        pr = {"number": 9, "title": "Fix x", "body": "Fixes #12, related to #13.\nCloses: https://github.com/parcel-bundler/lightningcss/issues/14",
              "closingIssuesReferences": [{"number": 15}]}
        self.assertEqual(sorted(closing_issue_numbers(pr)), [12, 14, 15])
        self.assertEqual(linked_issue_numbers(pr), [12, 13, 14, 15])


class BuildDriftTest(unittest.TestCase):
    def test_same_drift_on_both_sides_is_not_new(self):
        sig = build.drift_signature(b"a\nb\nc\n", b"a\nB\nc\n")
        moved = build.drift_signature(b"x\na\nb\nc\n", b"x\na\nB\nc\n")
        self.assertEqual(sig, moved)
        self.assertEqual(build.new_drift({"node/ast.d.ts": sig, "src/compat.rs": "h"}, {"node/ast.d.ts": moved, "node/flags.js": "x"}), ["src/compat.rs"])


class OracleDriverTest(unittest.TestCase):
    def test_match_ids_and_merge(self):
        ids = ["p-a/x", "m-p-a/x-nest", "t-1"]
        self.assertEqual(oracle.match_ids("m-p-a/x-*, t-1", ids), ["m-p-a/x-nest", "t-1"])
        summary = {"verdicts": {"t-1": ["old"], "t-2": ["keep"]}, "dom": {"t-1": 1}, "profiles": {"latest": {}}, "stats": {"selected": 2}}
        merged = oracle.merge_verdicts(summary, {"verdicts": {"t-1": ["new"], "t-9": ["ignored"]}, "dom": {"t-1": 2}, "profiles": {"legacy-2023": {}}}, ["t-1"])
        self.assertEqual(merged["verdicts"], {"t-1": ["new"], "t-2": ["keep"]})
        self.assertEqual(merged["dom"], {"t-1": 2})
        self.assertEqual(sorted(merged["profiles"]), ["latest", "legacy-2023"])
        self.assertEqual(merged["stats"], {"selected": 2, "reruns": ["t-1"]})

    def test_errored_cases_fail_the_stage(self):
        v = lambda t: [{"summary": {"latest": {"transition": t}}}]
        many = {f"t-{i}": v("both-equivalent") for i in range(100)}
        oracle.check_errors({**many, "t-x": v("errored")})
        with self.assertRaises(common.LcrError):
            oracle.check_errors({**many, "p-a/x": v("errored")})
        with self.assertRaises(common.LcrError):
            oracle.check_errors({**many, **{f"w-{i}": v("errored") for i in range(10)}})

    def test_select_cases_marks_flag_only_and_mutation_dom(self):
        run = Path(tempfile.mkdtemp())
        cases = [
            {"id": "p-a/x", "source": "probe", "origin": "pr", "area": "color", "probe": {"area": "color", "dom": "<p></p>"}, "request": {"kind": "sheet", "css": ".a{}", "flags": ["custom-functions"]}},
            {"id": "m-p-a/x-nest", "source": "mutation", "parent": "p-a/x", "area": "color", "dom": '<div class="lcr-n"><p></p></div>', "request": {"kind": "sheet", "css": ".lcr-n{.a{}}"}},
        ]
        common.write_jsonl(run / "corpus" / "cases.jsonl", cases)
        common.write_jsonl(run / "corpus" / "deltas.jsonl", [])
        common.write_jsonl(run / "corpus" / "outputs-base.jsonl", [{"id": "p-a/x", "ok": False, "stage": "request"}, {"id": "m-p-a/x-nest", "ok": True, "code": "x"}])
        common.write_jsonl(run / "corpus" / "outputs-head.jsonl", [{"id": "p-a/x", "ok": True, "code": ".a{}"}, {"id": "m-p-a/x-nest", "ok": True, "code": "y"}])
        common.write_json(run / "corpus.json", {"flag_only": {"custom-functions": ["p-a/x"]}})
        common.write_json(run / "prepare.json", {"areas": ["color"]})
        selected, _ = oracle.select_cases(run, 10)
        by_id = {c["id"]: c for c in selected}
        self.assertEqual((by_id["p-a/x"]["introduced"], by_id["p-a/x"]["flagOnly"]), (True, "custom-functions"))
        self.assertNotIn("introduced", by_id["m-p-a/x-nest"])
        self.assertEqual(by_id["m-p-a/x-nest"]["dom"], '<div class="lcr-n"><p></p></div>')
        inputs = oracle.oracle_inputs(run)
        self.assertEqual(sorted(inputs), ["cases", "outputs-base", "outputs-head", "probe_files"])
        oracle.drop_cases(run, {"p-a/x"})


class InspectTest(unittest.TestCase):
    VERDICT = {
        "case": "t-1", "scheme": "light",
        "latest": {"chromium": {"version": "1", "touched": 1, "variants": {
            "base": {"status": "different", "diffs": [{"key": "div#1", "prop": "display", "ref": "flex", "val": "block"}]},
            "head": {"status": "equivalent", "diffs": []}}}},
        "legacy": {},
        "summary": {"latest": {"transition": "fixed", "base": "different", "head": "equivalent", "enginesBase": {"bad": ["chromium", "webkit"]}, "enginesHead": {"bad": []}, "divergent": False, "rejectedBase": 0, "rejectedHead": 1}, "legacy": {"legacy-2023": {"transition": "unverified"}}},
    }

    def test_diff_rows(self):
        rows = show.diff_rows(self.VERDICT["latest"]["chromium"]["variants"])
        self.assertEqual(rows, [("div#1", "display", "flex", "block", "=")])

    def test_table(self):
        rows = show.table_rows({"t-1": [self.VERDICT], "t-2": [{**self.VERDICT, "summary": {"latest": {"transition": "regressed"}}}]}, transitions={"fixed"})
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["bad_base"], ["chromium", "webkit"])
        text = show.format_table(rows)
        self.assertIn("CW/-", text)
        self.assertIn("2023:unverified", text)
        self.assertTrue(text.endswith("1 row(s): fixed=1"))

    def test_find_rows_and_show(self):
        run = Path(tempfile.mkdtemp())
        common.write_jsonl(run / "corpus" / "cases.jsonl", [{"id": "t-1", "source": "tuple", "request": {"kind": "sheet", "css": ".a{}"}}, {"id": "t-10", "source": "tuple", "request": {"kind": "sheet", "css": ".b{}"}}])
        common.write_jsonl(run / "corpus" / "outputs-base.jsonl", [{"id": "t-1", "ok": True, "code": "B"}, {"id": "t-10", "ok": True, "code": "X"}])
        common.write_jsonl(run / "corpus" / "outputs-head.jsonl", [{"id": "t-1", "ok": True, "code": "H"}])
        common.write_jsonl(run / "oracle" / "verdicts.jsonl", [self.VERDICT])
        self.assertEqual(show.find_rows(run / "corpus" / "outputs-base.jsonl", "id", "t-1"), [{"id": "t-1", "ok": True, "code": "B"}])
        self.assertEqual(show.resolve_case(run, "t-1")["id"], "t-1")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            show.show(run, "t-1", as_json=True)
        data = json.loads(buf.getvalue())
        self.assertEqual((data["base"]["code"], data["head"]["code"], len(data["oracle"])), ("B", "H", 1))


class DiskTest(unittest.TestCase):
    def test_atomic_write_cleans_up_on_enospc(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "x.json"

            def fail(tmp):
                tmp.write_text("partial")
                raise OSError(errno.ENOSPC, "No space left on device")

            with self.assertRaises(common.LcrError) as ctx:
                common._atomic(path, fail)
            self.assertIn("lcr clean", str(ctx.exception))
            self.assertEqual(list(Path(d).iterdir()), [])

    def test_preflight(self):
        with tempfile.TemporaryDirectory() as d:
            common.preflight_disk(Path(d), 1, "x")
            with self.assertRaises(common.LcrError):
                common.preflight_disk(Path(d), 1 << 60, "x")

    def test_clean_run(self):
        with tempfile.TemporaryDirectory() as d:
            run = Path(d)
            (run / "build" / "head" / "tree").mkdir(parents=True)
            (run / "build" / "head" / "tree" / "f").write_text("x" * 10)
            (run / "oracle" / "shots").mkdir(parents=True)
            (run / "oracle" / "results-latest.jsonl").write_text("y" * 5)
            self.assertEqual(lcr_main.clean_run(run, build_trees=True, results=True), 0)  # no build.json, no verdicts.jsonl yet
            (run / "build.json").write_text("{}")
            (run / "oracle" / "verdicts.jsonl").write_text("")
            self.assertEqual(lcr_main.clean_run(run, build_trees=True, results=True), 15)
            self.assertFalse((run / "build" / "head" / "tree").exists())
            self.assertFalse((run / "oracle" / "shots").exists())
            self.assertTrue((run / "oracle" / "verdicts.jsonl").exists())

    def test_resolve_run_is_never_implicit(self):
        with self.assertRaises(common.LcrError):
            lcr_main.resolve_run(None)


if __name__ == "__main__":
    unittest.main()
