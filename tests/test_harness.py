"""Unit tests for the deterministic parts of the harness. Run: python3 -I -m unittest discover -s tests"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "lib"))

from lcr import inject, mutations, probes, targets, tuples  # noqa: E402
from lcr.adapter import normalize_response  # noqa: E402
from lcr.prepare import enclosing_items, parse_hunks, test_fns_in_ranges  # noqa: E402

LIB_RS = '''pub fn api() {}

#[cfg(test)]
mod tests {
  use super::*;

  #[track_caller]
  fn minify_test(source: &str, expected: &str) {
    minify_test_with_options(source, expected, ParserOptions::default())
  }

  #[track_caller]
  fn minify_test_with_options<'i>(source: &'i str, expected: &'i str, options: ParserOptions<'i>) {
    let mut stylesheet = StyleSheet::parse(&source, options).unwrap();
    let _ = "a { b }";
    let _ = r#"{ unbalanced "#;
    assert_eq!(stylesheet.to_css(PrinterOptions::default()).unwrap().code, expected);
  }

  fn error_test(source: &str, error: ParserError) {
    let res = StyleSheet::parse(&source, ParserOptions::default());
    assert!(res.is_err());
  }

  #[test]
  fn test_color() {
    minify_test(".a { color: red }", ".a{color:red}");
  }
}
'''


class TargetsTest(unittest.TestCase):
    def test_encode_roundtrip(self):
        self.assertEqual(targets.encode_version("13.1"), (13 << 16) | (1 << 8))
        self.assertEqual(targets.decode_version((13 << 16) | (1 << 8)), "13.1")
        self.assertEqual(targets.parse_targets("chrome 80, safari 13.1"), {"chrome": 80 << 16, "safari": (13 << 16) | (1 << 8)})
        self.assertIsNone(targets.parse_targets("none"))

    def test_bad_target(self):
        with self.assertRaises(Exception):
            targets.parse_targets("netscape 4")

    def test_debug_parsing(self):
        text = "Browsers { android: None, chrome: Some(5898240), safari: Some(852224) }"
        self.assertEqual(targets.parse_browsers_debug(text), {"chrome": 5898240, "safari": 852224})
        self.assertIsNone(targets.parse_browsers_debug("None"))
        bits = {"Nesting": 1, "MediaRangeSyntax": 128, "MediaQueries": 448}
        self.assertEqual(targets.parse_flags_debug("Features(Nesting | MediaRangeSyntax)", bits), 129)
        self.assertEqual(targets.parse_flags_debug("Features(0x0)", bits), 0)
        t = targets.parse_targets_debug("Targets { browsers: None, include: Features(MediaRangeSyntax), exclude: Features(0x0) }", bits)
        self.assertEqual(t, {"targets": None, "include": 128, "exclude": 0})


class InjectTest(unittest.TestCase):
    def test_injection_keeps_line_numbers_and_targets_leaf_helpers(self):
        with tempfile.TemporaryDirectory() as d:
            src = Path(d) / "src"
            src.mkdir()
            (src / "lib.rs").write_text(LIB_RS)
            info = inject.inject_dump(Path(d))
            out = (src / "lib.rs").read_text()
        self.assertEqual(out.count("\n"), LIB_RS.count("\n"))
        names = [h["name"] for h in info["helpers"]]
        self.assertEqual(names, ["minify_test_with_options", "error_test"])  # minify_test is not a leaf
        self.assertIn('"options": serde_json::json!({"flags"', out)
        self.assertIn("#[track_caller] fn error_test", out)
        self.assertIn("mod lcr_dump", out)
        # the test fn itself is untouched
        self.assertIn('    minify_test(".a { color: red }", ".a{color:red}");', out)


class ProbesTest(unittest.TestCase):
    def write(self, text):
        d = tempfile.mkdtemp()
        p = Path(d) / "p.css"
        p.write_text(text)
        return p

    def test_valid_probe(self):
        p = probes.parse_probe(self.write('/*! lcr-probe\nid: color/x\narea: color\ntitle: t\nmode: lower\ntargets: chrome 80\nexpect: equivalent, output-contains:"a, b"\nknown: open-bug\nref: https://x\n*/\n.t{color:lab(50% 20 30)}\n'))
        self.assertEqual(p.errors, [])
        self.assertEqual(p.expect, ["equivalent", 'output-contains:"a, b"'])
        req = p.request()
        self.assertEqual(req["targets"], {"chrome": 80 << 16})
        self.assertTrue(req["minify"])
        self.assertFalse(req["compact"])

    def test_invalid_probe(self):
        p = probes.parse_probe(self.write("/*! lcr-probe\nid: Bad Id\narea: nope\ntitle: t\nmode: lower-minify\nexpect: maybe\nknown: soon\nref: x\n*/\n"))
        joined = " | ".join(p.errors)
        for needle in ("unknown area", "lower-minify needs targets", "bad expect", "bad known", "bad id", "empty CSS body", "bad ref"):
            self.assertIn(needle, joined)

    def test_parser_flag_passthrough(self):
        p = probes.parse_probe(self.write("/*! lcr-probe\nid: at-rules-other/f\narea: at-rules-other\ntitle: t\nmode: minify\nflags: custom-functions, error-recovery\nexpect: no-panic\nknown: none\nref: https://x.org/\n*/\n@function --f(){}\n"))
        self.assertEqual(p.errors, [])
        req = p.request()
        self.assertEqual(req["flags"], ["custom-functions"])
        self.assertTrue(req["error_recovery"])


class TuplesTest(unittest.TestCase):
    BITS = {"Nesting": 1, "MediaRangeSyntax": 128}

    def test_prefix_test_mapping(self):
        t = {"helper": "prefix_test", "fields": {"source": ".a{}", "expected": ".a {\n}\n", "targets": "Browsers { chrome: Some(5242880) }"}}
        [(suffix, req, exp)] = tuples.to_requests(t, self.BITS)
        self.assertEqual(req, {"kind": "sheet", "css": ".a{}", "minify": True, "compact": False, "targets": {"chrome": 5242880}})
        self.assertEqual(exp, {"type": "code", "code": ".a {\n}\n"})

    def test_custom_media_printer_has_no_targets(self):
        t = {"helper": "custom_media_test", "fields": {"source": "x", "expected": "y"}}
        [(_, req, _)] = tuples.to_requests(t, self.BITS)
        self.assertEqual(req["targets"], {"chrome": 95 << 16})
        self.assertIsNone(req["printer_targets"])
        self.assertEqual(req["flags"], ["custom-media"])

    def test_css_modules_filename_default_is_empty(self):
        opts = {"flags": "ParserFlags(0x0)", "css_modules": "Some(Config { pattern: Pattern { segments: [Hash, Literal(\"_\"), Local] }, dashed_idents: false, animation: true, grid: true, custom_idents: true, container: true, pure: true })", "error_recovery": False, "filename": ""}
        t = {"helper": "minify_test_with_options_and_browsers", "fields": {"source": ":local(.a){}", "expected": "x", "options": opts, "browsers": "None"}}
        [(_, req, _)] = tuples.to_requests(t, self.BITS)
        self.assertEqual(req["filename"], "")
        self.assertEqual(req["css_modules"]["pure"], True)
        self.assertNotIn("pattern", req["css_modules"])

    def test_range_expansion(self):
        t = {"helper": "property_range_test", "fields": {"names": '["width", "height"]', "cases": '[("-1px", None), ("calc(1px - 2px)", Some("0")), ("a\\"b", None)]'}}
        reqs = tuples.to_requests(t, self.BITS)
        self.assertEqual(len(reqs), 6)
        self.assertEqual(reqs[1][1], {"kind": "value", "property": "width", "value": "calc(1px - 2px)", "compact": True})
        self.assertEqual(reqs[1][2], {"type": "value", "code": "0"})
        self.assertEqual(reqs[0][2], {"type": "value-unparsed"})
        self.assertEqual(reqs[2][1]["value"], 'a"b')

    def test_matches(self):
        self.assertTrue(tuples.matches_expectation({"type": "code", "code": "x"}, {"ok": True, "code": "x"}))
        self.assertFalse(tuples.matches_expectation({"type": "value", "code": "0"}, {"ok": True, "code": "0", "recognition": "unparsed"}))
        self.assertTrue(tuples.matches_expectation({"type": "error", "stage": "parse", "error": "UnexpectedToken(Ident(\"x\"))"}, {"ok": False, "stage": "parse", "error": "… | UnexpectedToken(…)"}))

    def test_rust_unescape(self):
        self.assertEqual(tuples.rust_unescape(r"a\u{1f600}\n\\"), "a\U0001f600\n\\")


class MutationsTest(unittest.TestCase):
    CSS = '.a { margin: 0; margin-top: 5px; color: red !important }\n.b::before { content: "x;y}" }\n@media (min-width: 1px) { .c { color: blue } }\n'

    def test_split_respects_strings(self):
        items = mutations.split_top(self.CSS)
        self.assertEqual([i["kind"] for i in items], ["rule", "rule", "at-block"])
        self.assertEqual(mutations.split_decls(items[1]["body"]), ['content: "x;y}"'])

    def test_each_mutation_is_deterministic(self):
        for m in mutations.MUTATIONS:
            if m.startswith("retarget"):
                continue
            a = mutations.mutate(self.CSS, m)
            self.assertEqual(a, mutations.mutate(self.CSS, m), m)

    def test_reverse_and_wrap(self):
        self.assertIn(".a { color: red !important; margin-top: 5px; margin: 0 }", mutations.mutate(self.CSS, "reverse-decls"))
        self.assertIsNone(mutations.mutate("@import 'a.css';\n.a{color:red}", "wrap-media"))

    def test_unparseable_input_is_skipped(self):
        self.assertIsNone(mutations.mutate(".a { color: red", "important"))


class PrepareHelpersTest(unittest.TestCase):
    def test_hunks_and_items(self):
        patch = "diff --git a/src/x.rs b/src/x.rs\n--- a/src/x.rs\n+++ b/src/x.rs\n@@ -3,2 +3,3 @@ impl Foo {\n   fn a() {\n-    1\n+    2\n+    3\n"
        h = parse_hunks(patch)["src/x.rs"]
        self.assertEqual(h["head"], [[3, 5]])
        self.assertEqual((h["added"], h["removed"]), (2, 1))
        text = "struct Foo;\nimpl Handler for Foo {\n  fn a() {\n    2\n    3\n  }\n}\n"
        [entry] = enclosing_items(text, [[4, 5]])
        self.assertEqual(entry["item"]["name"], "a")
        self.assertEqual(entry["impl"]["type"], "Foo")

    def test_test_fns(self):
        text = "\n".join(["  #[test]", "  fn test_a() {", "  }", "  #[test]", "  fn test_b() {", "    x", "  }"])
        self.assertEqual(test_fns_in_ranges(text, [[6, 6]]), ["test_b"])


class AdapterTest(unittest.TestCase):
    def test_normalize_ignores_error_noise(self):
        a = normalize_response({"ok": False, "stage": "parse", "error": "line 1 col 2 | UnexpectedToken(Ident(\"x\"))"})
        b = normalize_response({"ok": False, "stage": "parse", "error": "line 9 col 9 | UnexpectedToken(Delim('}'))"})
        self.assertEqual(a, b)
        self.assertNotEqual(normalize_response({"ok": True, "code": "a"}), normalize_response({"ok": True, "code": "b"}))


if __name__ == "__main__":
    unittest.main()
