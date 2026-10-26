"""Keep the agent's context small and timeless.

Everything an agent reads during a review (SKILL.md, references/) must explain mechanisms, not
history: no issue/PR numbers, commit hashes, release versions or line numbers, which go stale and
cost tokens without telling a reviewer what to check. Files also have size budgets.
Probe files and config are data, not instructions, and are not checked here.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUDGET = {  # bytes
    "SKILL.md": 12000,
    "references/checklists/general.md": 5000,
    "references/checklists/*.md": 4500,
    "references/spec/*.md": 8000,
    "references/*.md": 9000,
}
FORBIDDEN = [
    (re.compile(r"(?<![\w&/])#\d{2,5}\b"), "issue/PR number"),
    (re.compile(r"\b(?:PRs?|issues?|pull)\s+#?\d{2,5}\b", re.I), "issue/PR reference"),
    (re.compile(r"(?<![\w/.-])[0-9a-f]{7,40}(?![\w-])"), "commit hash"),
    (re.compile(r"\bv?1\.(?:[1-3]\d)\.\d+\b"), "Lightning CSS release version"),
    (re.compile(r"\.(?:rs|js|mjs|toml):\d+"), "file:line reference"),
]


def budget_for(rel: str) -> int:
    from fnmatch import fnmatch

    for pattern, size in BUDGET.items():
        if fnmatch(rel, pattern):
            return size
    return 0


problems = 0
files = [ROOT / "SKILL.md"] + sorted((ROOT / "references").rglob("*.md"))
total = 0
for path in files:
    rel = str(path.relative_to(ROOT))
    text = path.read_text()
    total += len(text.encode())
    limit = budget_for(rel)
    if limit and len(text.encode()) > limit:
        print(f"{rel}: {len(text.encode())} bytes > budget {limit}")
        problems += 1
    for i, line in enumerate(text.splitlines(), 1):
        if "http://" in line or "https://" in line:
            line = re.sub(r"https?://\S+", "", line)
        for pat, what in FORBIDDEN:
            m = pat.search(line)
            if m:
                print(f"{rel}:{i}: {what}: {m.group(0)!r}")
                problems += 1
                break
print(f"{len(files)} files, {total} bytes, {problems} problems")
sys.exit(1 if problems else 0)
