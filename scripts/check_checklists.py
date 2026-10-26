"""Fail if any checklist breaks the format `lcr report` parses (see CONTRIBUTING.md)."""
import re
import sys
from pathlib import Path

ITEM = re.compile(r"^- \[([A-Z0-9]+)-(\d+)\] \((BLOCKER|MAJOR|MINOR|NOTE)\) (.+)$")
root = Path(__file__).resolve().parents[1] / "references" / "checklists"
problems = 0
for path in sorted(root.glob("*.md")):
    lines = path.read_text().splitlines()
    ids, prefixes = [], set()
    for i, line in enumerate(lines):
        if line.startswith("- ["):
            m = ITEM.match(line.strip())
            if not m:
                print(f"{path.name}:{i + 1}: malformed item")
                problems += 1
                continue
            prefixes.add(m.group(1))
            ids.append(int(m.group(2)))
            nxt = lines[i + 1].strip() if i + 1 < len(lines) else ""
            if not nxt.startswith("verify:"):
                print(f"{path.name}:{i + 1}: item without a verify: line")
                problems += 1
    if len(prefixes) > 1:
        print(f"{path.name}: more than one id prefix {sorted(prefixes)}")
        problems += 1
    if ids != list(range(1, len(ids) + 1)):
        print(f"{path.name}: ids are not numbered 1..{len(ids)} without gaps")
        problems += 1
print(f"{len(list(root.glob('*.md')))} checklists, {problems} problems")
sys.exit(1 if problems else 0)
