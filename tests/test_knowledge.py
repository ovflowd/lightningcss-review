"""Invariants of the agent-facing knowledge: SKILL.md, references/, curated probes, probe template.
Run: python3 -I -m unittest discover -s tests"""
import re
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "lib"))

from lcr import probes  # noqa: E402

TRANSITIONS = ["errored", "input-rejected", "introduced", "both-equivalent", "near-introduced", "fixed", "regressed", "worsened", "still-different", "unverified"]
CLASSIFICATIONS = ["INTENDED", "ACCEPTABLE_SIDE_EFFECT", "REGRESSION", "PRE_EXISTING", "NEEDS_MAINTAINER_DECISION", "ORACLE_NOISE"]
ITEM_RE = re.compile(r"^- \[([A-Z0-9]+-\d+)\] ")


def read(rel: str) -> str:
    return (ROOT / rel).read_text()


def curated() -> list:
    loaded, problems = probes.load_probes(probes.curated_dirs())
    return loaded, problems


class ScriptsTest(unittest.TestCase):
    def run_script(self, *args):
        return subprocess.run([sys.executable, "-I", *args], cwd=ROOT, capture_output=True, text=True)

    def test_context_lint_passes(self):
        res = self.run_script("scripts/lint_context.py")
        self.assertEqual(res.returncode, 0, res.stdout)

    def test_checklist_format_passes(self):
        res = self.run_script("scripts/check_checklists.py")
        self.assertEqual(res.returncode, 0, res.stdout)


class ChecklistTest(unittest.TestCase):
    def items(self) -> dict[str, list[str]]:
        out = {}
        for path in sorted((ROOT / "references" / "checklists").glob("*.md")):
            current = None
            for line in path.read_text().splitlines():
                m = ITEM_RE.match(line)
                if m:
                    current = m.group(1)
                    out[current] = []
                elif current and line.startswith("  "):
                    out[current].append(line.strip())
        return out

    def test_same_root_as_names_an_existing_other_item(self):
        items = self.items()
        links = {i: l.split(":", 1)[1].strip() for i, lines in items.items() for l in lines if l.startswith("same-root-as:")}
        self.assertIn("COMPAT-10", links)
        for item, target in links.items():
            self.assertIn(target, items, item)
            self.assertNotEqual(item, target)

    def test_same_root_as_follows_verify(self):
        for item, lines in self.items().items():
            if any(l.startswith("same-root-as:") for l in lines):
                self.assertTrue(lines[0].startswith("verify:"), item)

    def test_supports_boolean_items_are_base_relative(self):
        text = read("references/checklists/supports-container.md")
        cond02 = next(l for l in text.splitlines() if l.startswith("- [COND-02]"))
        self.assertIn("FAIL_PRE_EXISTING", cond02)
        compat10 = next(l for l in read("references/checklists/prefixing-compat.md").splitlines() if l.startswith("- [COMPAT-10]"))
        self.assertIn("COND-02", compat10)

    def test_general_checklist_allows_pre_existing_answers(self):
        self.assertIn("FAIL_PRE_EXISTING", read("references/checklists/general.md").split("- [GEN-01]")[0])

    def test_animation_shorthand_timeline_split(self):
        text = read("references/checklists/transition-animation.md")
        anim05 = next(l for l in text.splitlines() if l.startswith("- [ANIM-05]"))
        self.assertNotIn("parsed inside", anim05)
        self.assertIn("- [ANIM-14] (NOTE)", text)

    def test_compact_test_item_accepts_either_evidence(self):
        tests04 = next(l for l in read("references/checklists/tests.md").splitlines() if l.startswith("- [TESTS-04]"))
        self.assertIn("**or**", tests04)
        self.assertIn("effective_severity: MINOR", tests04)

    def line(self, rel, item):
        return next(l for l in read(rel).splitlines() if l.startswith(f"- [{item}]"))

    def test_missing_branch_coverage_is_minor_and_reasons_live_outside_code(self):
        tests03 = self.line("references/checklists/tests.md", "TESTS-03")
        self.assertTrue(tests03.startswith("- [TESTS-03] (MINOR)"))
        self.assertIn("oracle-verified", tests03)
        tests11 = self.line("references/checklists/tests.md", "TESTS-11")
        self.assertTrue(tests11.startswith("- [TESTS-11] (NOTE)"))
        self.assertIn("PR body or a comment", tests11)

    def test_display_handler_and_rule_dedupe_are_separate_items(self):
        rel = "references/checklists/display-layout.md"
        self.assertNotIn("is_duplicate", self.line(rel, "DISPLAY-02"))
        self.assertIn("StyleRule::is_duplicate", self.line(rel, "DISPLAY-03"))
        # value-prefixed-sibling only puts prefixes first; the later-prefixed order needs reverse-decls.
        self.assertIn("reverse-decls", self.items()["DISPLAY-02"][0])

    def test_value_prefix_mutation_is_named_where_value_prefixes_matter(self):
        from lcr import mutations

        self.assertIn("value-prefixed-sibling", mutations.MUTATIONS)
        items = self.items()
        for item in ("GEN-06", "DISPLAY-02", "TESTS-03"):
            self.assertIn("value-prefixed-sibling", items[item][0], item)


class CuratedProbeTest(unittest.TestCase):
    def test_curated_probes_validate(self):
        loaded, problems = curated()
        self.assertEqual(problems, [])
        self.assertGreater(len(loaded), 0)

    def test_refs_are_urls_without_placeholders(self):
        loaded, _ = curated()
        for p in loaded:
            for ref in p.refs:
                self.assertRegex(ref, r"^https?://[^<>]+$", p.id)

    def test_headers_do_not_prejudge_open_prs_or_quote_maintainers(self):
        loaded, _ = curated()
        bad = re.compile(r"open PR|open fix PR|\(approved|maintainer (wants|questioned|considers|said)|\bDevon\b|would make it match", re.I)
        for p in loaded:
            header = p.path.read_text().split("*/", 1)[0]
            self.assertIsNone(bad.search(header), p.id)

    def test_no_curated_probe_claims_a_repro(self):
        for path in sorted((ROOT / "corpus" / "probes").rglob("*.css")):
            header = path.read_text().split("*/", 1)[0]
            self.assertNotRegex(header, r"(?m)^repro:", str(path))

    def by_id(self, pid):
        loaded, _ = curated()
        return next(p for p in loaded if p.id == pid)

    def test_logical_after_nested_rule_uses_chrome_targets(self):
        p = self.by_id("nesting/logical-after-nested-rule")
        self.assertEqual(p.targets_text, "chrome 80")
        self.assertNotIn("pull/", " ".join(p.refs))

    def test_margin_block_var_probe_targets_below_logical_longhands(self):
        p = self.by_id("logical/shorthand-with-var-in-calc-lowered")
        self.assertEqual(p.targets_text, "chrome 68")
        self.assertIn('output-not-contains:"margin-block:"', p.expect)

    def test_color_mix_token_list_probe_is_an_unfiled_bug(self):
        self.assertEqual(self.by_id("color/color-mix-none-in-token-list").known, "open-bug")

    def test_function_rule_probe_note_is_current(self):
        p = self.by_id("at-rules-other/function-rule-untouched-without-flag")
        self.assertNotIn("cannot express", p.note)


class ContractDocsTest(unittest.TestCase):
    def test_oracle_reference_documents_every_transition(self):
        text = read("references/oracle.md")
        for t in TRANSITIONS:
            self.assertIn(f"`{t}`", text, t)
        self.assertIn("engines: {engine: {base, head}}", text)

    def test_skill_names_new_transitions_and_classifications(self):
        text = read("SKILL.md")
        for t in ("errored", "input-rejected", "worsened", "introduced"):
            self.assertIn(f"`{t}`", text, t)
        for c in CLASSIFICATIONS + ["FAIL_PRE_EXISTING"]:
            self.assertIn(f"`{c}`" if c != "FAIL_PRE_EXISTING" else c, text, c)
        for key in ("effective_severity", "finding: F<n>", "repro: #N", "--rerun"):
            self.assertIn(key, text, key)

    def test_decision_needed_is_never_described_as_a_verdict_floor(self):
        for rel in ("SKILL.md", "docs/harness.md"):
            text = " ".join(read(rel).split())
            self.assertNotRegex(text, r"(?i)caps? the verdict", rel)
        skill = " ".join(read("SKILL.md").split())
        self.assertIn("Never UNSAFE: MAJOR if the oracle shows head worse than base, else a NOTE", skill)

    def test_o9_judges_engines_against_the_spec(self):
        skill = " ".join(read("SKILL.md").split())
        self.assertIn("an engine that lags the spec", skill)
        self.assertIn("REGRESSION needs base to match the spec in an engine where head does not", skill)
        self.assertNotIn("base matched in every engine", skill)
        self.assertIn("base wrong wherever head is → PRE_EXISTING", skill)
        self.assertIn("`references/spec/<cluster>.md`", skill)

    def test_thread_step_reads_issue_comments_and_searches_related_issues(self):
        skill = " ".join(read("SKILL.md").split())
        self.assertIn("maintainer comments on each linked issue, closed too", skill)
        self.assertIn("`gh search issues`", skill)
        self.assertIn("standing maintainer policy", skill)

    def test_probe_format_documents_new_keys(self):
        text = read("references/probe-format.md")
        for key in ("`repro`", "`timeout`", "`open-bug`"):
            self.assertIn(key, text, key)
        self.assertNotIn("i.e. `lower` with\n`targets: none`", text)

    def test_template_lists_known_values_and_repro(self):
        text = read("templates/probe.css.tmpl")
        self.assertIn("open-bug", text)
        self.assertRegex(text, r"(?m)^repro: ")


if __name__ == "__main__":
    unittest.main()
