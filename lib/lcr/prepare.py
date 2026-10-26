"""Stage 1: resolve a PR to an exact base/head pair, export both trees, and classify the change.

Head is the tree you would get by merging the PR into the current upstream master
(`git merge-tree --write-tree`, no commit is created). When that conflicts, head falls back to
the PR head commit and base to its merge-base with master, and the report says so.
"""
from __future__ import annotations

import fnmatch
import io
import json
import re
import tarfile
from pathlib import Path

from .common import (
    UPSTREAM,
    LcrError,
    cache_dir,
    git,
    load_config,
    log,
    read_json,
    repo_dir,
    run,
    skill_version,
    write_json,
)

GENERIC_NAMES = {
    "parse", "to_css", "new", "default", "from", "into", "minify", "clone", "eq", "fmt", "visit",
    "is_compatible", "get_fallbacks", "handle_property", "finalize", "parse_string", "to_css_string",
    "into_owned", "hash", "len", "is_empty", "iter", "next", "write", "flush", "deref", "as_ref",
    "parse_with_options", "add_prefix", "set_prefixes_for_targets", "get_necessary_prefixes",
    "test", "main", "run", "value", "name", "inner", "Self", "T",
}


def ensure_repo() -> Path:
    repo = repo_dir()
    if not (repo / ".git").exists():
        log(f"cloning {UPSTREAM} into {repo}")
        repo.parent.mkdir(parents=True, exist_ok=True)
        run(["git", "clone", "--quiet", f"https://github.com/{UPSTREAM}.git", str(repo)])
    remote = git("remote", "get-url", "origin").strip()
    if UPSTREAM not in remote:
        # A fork clone is fine as long as an upstream remote exists.
        remotes = git("remote").split()
        if "upstream" not in remotes:
            git("remote", "add", "upstream", f"https://github.com/{UPSTREAM}.git")
    return repo


def upstream_remote() -> str:
    remote = git("remote", "get-url", "origin").strip()
    return "origin" if UPSTREAM in remote else "upstream"


def gh_json(args: list[str], check: bool = True):
    out = run(["gh", *args], timeout=180, check=check).stdout
    return json.loads(out) if out.strip() else None


def export_tree(treeish: str, dest: Path) -> None:
    if dest.exists():
        return
    import subprocess

    data = subprocess.run(
        ["git", "-C", str(repo_dir()), "archive", "--format=tar", treeish], capture_output=True, check=True
    ).stdout
    dest.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        tar.extractall(dest, filter="data")


def parse_hunks(patch: str) -> dict:
    """file -> {"head": [[start, end], ...], "base": [[start, end], ...]} (changed line ranges)."""
    files: dict[str, dict] = {}
    current = None
    for line in patch.splitlines():
        if line.startswith("diff --git "):
            m = re.match(r"diff --git a/(.*?) b/(.*)$", line)
            current = m.group(2) if m else None
            if current:
                files.setdefault(current, {"head": [], "base": [], "added": 0, "removed": 0})
            continue
        if current is None:
            continue
        m = re.match(r"@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@", line)
        if m:
            b0, bn = int(m.group(1)), int(m.group(2) or 1)
            h0, hn = int(m.group(3)), int(m.group(4) or 1)
            if bn:
                files[current]["base"].append([b0, b0 + bn - 1])
            if hn:
                files[current]["head"].append([h0, h0 + hn - 1])
            continue
        if line.startswith("+") and not line.startswith("+++"):
            files[current]["added"] += 1
        elif line.startswith("-") and not line.startswith("---"):
            files[current]["removed"] += 1
    return files


ITEM_RE = re.compile(
    r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|const|unsafe|extern \"C\")\s+)*"
    r"(fn|struct|enum|trait|type|macro_rules!|mod)\s+([A-Za-z_][A-Za-z0-9_]*)"
)
IMPL_RE = re.compile(r"^\s*impl(?:<[^>]*>)?\s+(?:([A-Za-z_:][A-Za-z0-9_:<>,' ]*?)\s+for\s+)?([A-Za-z_][A-Za-z0-9_]*)")


def enclosing_items(text: str, ranges: list[list[int]]) -> list[dict]:
    """For each changed range, the nearest enclosing fn and impl/type above it (heuristic, deterministic)."""
    lines = text.splitlines()
    items = []
    for start, end in ranges:
        found_fn = found_impl = None
        for idx in range(min(end, len(lines)) - 1, -1, -1):
            line = lines[idx]
            if found_fn is None:
                m = ITEM_RE.match(line)
                if m and idx < end:
                    found_fn = {"kind": m.group(1), "name": m.group(2), "line": idx + 1}
            if found_impl is None:
                m = IMPL_RE.match(line)
                if m:
                    found_impl = {"trait": (m.group(1) or "").strip() or None, "type": m.group(2), "line": idx + 1}
            if found_fn and found_impl:
                break
        items.append({"range": [start, end], "item": found_fn, "impl": found_impl})
    return items


def classify_files(paths: list[str]) -> dict[str, list[str]]:
    rules = load_config("areas.json")["files"]
    out = {}
    for path in paths:
        for pattern, areas in rules:
            if fnmatch.fnmatch(path, pattern):
                out[path] = areas
                break
    return out


def test_fns_in_ranges(text: str, ranges: list[list[int]]) -> list[str]:
    """Names of `#[test] fn` items in src/lib.rs that overlap the changed ranges."""
    lines = text.splitlines()
    starts = []
    for i, line in enumerate(lines):
        m = re.match(r"^  fn (test_[a-z0-9_]+)\(\)", line)
        if m and i > 0 and lines[i - 1].strip() == "#[test]":
            starts.append((i + 1, m.group(1)))
    names = set()
    for start, end in ranges:
        current = None
        for line_no, name in starts:
            if line_no <= end:
                current = name
            else:
                break
        if current:
            names.add(current)
        for line_no, name in starts:
            if start <= line_no <= end:
                names.add(name)
    return sorted(names)


def test_area_map() -> dict[str, list[str]]:
    areas = load_config("areas.json")["areas"]
    mapping: dict[str, list[str]] = {}
    for area, meta in areas.items():
        for test in meta.get("tests", []):
            mapping.setdefault(test, []).append(area)
    extra = read_json(Path(__file__).resolve().parents[2] / "config" / "testmap.json", {}) or {}
    for test in extra.get("tests", []):
        mapping.setdefault(test["name"], [])
        for a in test.get("areas", []):
            if a not in mapping[test["name"]]:
                mapping[test["name"]].append(a)
    return mapping


def blast_radius(head_tree: str, items: list[dict]) -> list[dict]:
    names = set()
    for entry in items:
        for key in ("item", "impl"):
            obj = entry.get(key)
            if not obj:
                continue
            name = obj.get("name") or obj.get("type")
            if name and name not in GENERIC_NAMES and len(name) > 2:
                names.add(name)
    radius = []
    for name in sorted(names):
        proc = run(
            ["git", "-C", str(repo_dir()), "grep", "-n", "-w", "--fixed-strings", name, head_tree, "--", "src", "selectors", "node/src", "napi/src", "c/src"],
            check=False,
        )
        hits = []
        for line in proc.stdout.splitlines():
            parts = line.split(":", 3)
            if len(parts) >= 3:
                hits.append(parts[1])
        files = sorted(set(hits))
        radius.append({"name": name, "files": files, "areas": sorted({a for f in files for a in classify_files([f]).get(f, [])})})
    return radius


def linked_issue_numbers(pr: dict) -> list[int]:
    nums = {i["number"] for i in pr.get("closingIssuesReferences") or [] if i.get("number")}
    body = (pr.get("body") or "") + "\n" + (pr.get("title") or "")
    for m in re.finditer(r"(?:(?<![\w/])#|github\.com/parcel-bundler/lightningcss/issues/)(\d{1,5})\b", body):
        nums.add(int(m.group(1)))
    nums.discard(pr["number"])
    return sorted(nums)


def risk_flags(files: dict, file_areas: dict, hunks: dict, head_root: Path, base_root: Path) -> list[dict]:
    cfg = load_config("areas.json")
    flags = []
    paths = set(files)
    src_changes = [p for p in paths if p.startswith(("src/", "selectors/")) and p not in ("src/lib.rs",)]
    test_changes = [p for p in paths if p in ("src/lib.rs",) or p.startswith(("tests/", "node/test/"))]

    def add(fid, detail, paths_=()):
        flags.append({"id": fid, "detail": detail, "paths": sorted(paths_)})

    core = sorted(p for p in paths if p in cfg["core_files"])
    if core:
        add("core-file", "touches files with a wide blast radius", core)
    if src_changes and not test_changes:
        add("no-tests", "source changes without test changes", src_changes)
    lib = hunks.get("src/lib.rs")
    if lib and lib["removed"]:
        add("test-lines-removed", f"{lib['removed']} line(s) removed from src/lib.rs (expectations changed or deleted)", ["src/lib.rs"])
    for gen, command in cfg["generated_files"].items():
        if gen in paths:
            if gen in ("src/compat.rs", "src/prefixes.rs") and "scripts/build-prefixes.js" not in paths:
                add("generated-edited", f"{gen} changed; it is generated by `{command}` — verify it was regenerated, not hand-edited", [gen])
            elif gen == "node/ast.d.ts":
                add("ast-types-changed", "node/ast.d.ts changed; verify it matches `yarn build-ast` output", [gen])
    if any(p.startswith("selectors/") for p in paths):
        add("selectors-crate", "touches the forked parcel_selectors crate (published separately)", [p for p in paths if p.startswith("selectors/")])
    if paths & {"Cargo.toml", "Cargo.lock", "package.json", "yarn.lock"}:
        add("dependencies", "dependency manifests changed", paths & {"Cargo.toml", "Cargo.lock", "package.json", "yarn.lock"})
    added_total = sum(h["added"] for h in hunks.values())
    removed_total = sum(h["removed"] for h in hunks.values())
    if added_total + removed_total > 600:
        add("large-diff", f"+{added_total}/-{removed_total} lines", [])
    # Patterns in added non-test Rust lines.
    patterns = {
        "added-unwrap": (r"\.unwrap\(\)|\.expect\(", "new unwrap()/expect() in library code (panics on user input?)"),
        "added-panic": (r"\b(panic!|unreachable!|todo!|unimplemented!)\(", "new panic!/unreachable!/todo! in library code"),
        "added-unsafe": (r"\bunsafe\b", "new unsafe code"),
        "added-float-compare": (r"==\s*-?\d+\.\d+|\d+\.\d+\s*==", "float equality comparison"),
        "added-clone-heavy": (r"\.to_vec\(\)|\.to_owned\(\)\.clone\(\)", "extra allocations in hot paths"),
    }
    added_lines: dict[str, list[str]] = {}
    for path in src_changes:
        if not path.endswith(".rs"):
            continue
        for line in files.get(path, {}).get("added_lines", []):
            for fid, (pat, _) in patterns.items():
                if re.search(pat, line):
                    added_lines.setdefault(fid, []).append(path)
    for fid, ps in sorted(added_lines.items()):
        add(fid, patterns[fid][1], set(ps))
    pub_added = []
    for path in src_changes:
        for line in files.get(path, {}).get("added_lines", []):
            if re.match(r"\s*pub (fn|struct|enum|trait|mod|type|const|use)\b", line):
                pub_added.append(path)
    if pub_added:
        add("public-api", "new or changed `pub` items (Rust API / AST / TS types surface)", set(pub_added))
    if any(p.startswith(("node/", "napi/", "wasm/", "c/")) for p in paths) or "src/visitor.rs" in paths:
        add("bindings", "touches bindings or the visitor API; run the JS lane", [p for p in paths if p.startswith(("node/", "napi/", "wasm/", "c/"))])
    new_props = []
    for line in files.get("src/properties/mod.rs", {}).get("added_lines", []):
        m = re.match(r'\s*"([a-z-]+)":', line)
        if m:
            new_props.append(m.group(1))
    if new_props:
        add("new-property", "new properties registered: " + ", ".join(sorted(set(new_props))), ["src/properties/mod.rs"])
    return flags


def added_lines_by_file(patch: str) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    current = None
    for line in patch.splitlines():
        if line.startswith("diff --git "):
            m = re.match(r"diff --git a/(.*?) b/(.*)$", line)
            current = m.group(2) if m else None
            continue
        if current and line.startswith("+") and not line.startswith("+++"):
            out.setdefault(current, []).append(line[1:])
    return out


def prepare(pr_number: int | None = None, local_range: str | None = None, offline: bool = False) -> Path:
    repo = ensure_repo()
    remote = upstream_remote()
    meta: dict = {"schema": 1, "skill_version": skill_version(), "repo": str(repo)}
    if not offline:
        git("fetch", "--quiet", remote, "+refs/heads/master:refs/lcr/master")
    master = git("rev-parse", "refs/lcr/master").strip()
    if pr_number is not None:
        if not offline:
            git("fetch", "--quiet", remote, f"+refs/pull/{pr_number}/head:refs/lcr/pr/{pr_number}/head")
        pr = gh_json([
            "pr", "view", str(pr_number), "-R", UPSTREAM, "--json",
            "number,title,author,body,state,isDraft,url,createdAt,updatedAt,baseRefName,headRefName,headRefOid,"
            "headRepositoryOwner,mergeable,labels,closingIssuesReferences,files,additions,deletions,commits",
        ])
        pr_head = git("rev-parse", f"refs/lcr/pr/{pr_number}/head").strip()
        if pr.get("headRefOid") and pr["headRefOid"] != pr_head:
            log(f"warning: fetched head {pr_head[:12]} differs from GitHub headRefOid {pr['headRefOid'][:12]}")
        merge = run(["git", "-C", str(repo), "merge-tree", "--write-tree", "--name-only", master, pr_head], check=False)
        if merge.returncode == 0:
            head_tree = merge.stdout.split("\n")[0].strip()
            base = master
            strategy = "merged-into-master"
            conflicts = []
        else:
            # Output: tree OID, conflicted paths, blank line, informational messages.
            conflicts = merge.stdout.split("\n\n", 1)[0].split("\n")[1:]
            conflicts = sorted({l.strip() for l in conflicts if l.strip()})
            base = git("merge-base", master, pr_head).strip()
            head_tree = git("rev-parse", f"{pr_head}^{{tree}}").strip()
            strategy = "pr-head-vs-merge-base"
        run_id = f"pr{pr_number}-h{pr_head[:8]}-b{base[:8]}"
        meta.update({
            "kind": "pr",
            "pr": {
                "number": pr["number"], "title": pr["title"], "author": (pr.get("author") or {}).get("login"),
                "url": pr["url"], "state": pr["state"], "draft": pr.get("isDraft"), "created": pr["createdAt"][:10],
                "updated": pr["updatedAt"][:10], "labels": [l["name"] for l in pr.get("labels") or []],
                "body": pr.get("body") or "", "commits": len(pr.get("commits") or []),
                "head_ref": pr.get("headRefName"), "mergeable": pr.get("mergeable"),
            },
            "pr_head": pr_head,
        })
    elif local_range:
        if ".." not in local_range:
            raise LcrError("--range must look like <base>..<head>")
        b, h = local_range.split("..", 1)
        base = git("rev-parse", b).strip()
        pr_head = git("rev-parse", h).strip()
        head_tree = git("rev-parse", f"{pr_head}^{{tree}}").strip()
        strategy = "local-range"
        conflicts = []
        run_id = f"range-h{pr_head[:8]}-b{base[:8]}"
        meta.update({"kind": "range", "range": local_range, "pr_head": pr_head})
    else:
        raise LcrError("pass a PR number or --range base..head")

    run_dir = cache_dir() / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    meta.update({
        "run_id": run_id,
        "run_dir": str(run_dir),
        "base": base,
        "master": master,
        "head_tree": head_tree,
        "strategy": strategy,
        "conflicts": conflicts,
    })
    log(f"run {run_id}: base {base[:12]} head-tree {head_tree[:12]} ({strategy})")

    patch = run(["git", "-C", str(repo), "diff", "--no-color", "--no-ext-diff", "-M", base, head_tree]).stdout
    (run_dir / "diff.patch").write_text(patch)
    hunks = parse_hunks(patch)
    added = added_lines_by_file(patch)
    name_status = run(["git", "-C", str(repo), "diff", "--name-status", "-M", base, head_tree]).stdout
    files = {}
    for line in name_status.splitlines():
        parts = line.split("\t")
        status, path = parts[0], parts[-1]
        files[path] = {"status": status, **hunks.get(path, {"head": [], "base": [], "added": 0, "removed": 0}), "added_lines": added.get(path, [])}

    export_tree(base, run_dir / "src" / "base")
    export_tree(head_tree, run_dir / "src" / "head")
    head_root, base_root = run_dir / "src" / "head", run_dir / "src" / "base"

    file_areas = classify_files(sorted(files))
    items = []
    for path, info in sorted(files.items()):
        if not path.endswith(".rs") or path == "src/lib.rs":
            continue
        for side, root in (("head", head_root), ("base", base_root)):
            p = root / path
            if p.exists() and info[side]:
                for entry in enclosing_items(p.read_text(errors="replace"), info[side]):
                    items.append({"file": path, "side": side, **entry})
    test_fns = {}
    if "src/lib.rs" in files:
        for side, root in (("head", head_root), ("base", base_root)):
            p = root / "src" / "lib.rs"
            if p.exists():
                test_fns[side] = test_fns_in_ranges(p.read_text(), files["src/lib.rs"][side])
    tmap = test_area_map()
    test_areas = sorted({a for side in test_fns.values() for t in side for a in tmap.get(t, [])})
    areas = sorted({a for v in file_areas.values() for a in v} | set(test_areas))
    radius = blast_radius(head_tree, items)
    flags = risk_flags(files, file_areas, hunks, head_root, base_root)

    meta.update({
        "files": {p: {k: v for k, v in info.items() if k != "added_lines"} for p, info in sorted(files.items())},
        "file_areas": file_areas,
        "changed_items": items,
        "changed_tests": test_fns,
        "test_areas": test_areas,
        "areas": areas,
        "blast_radius": radius,
        "radius_areas": sorted({a for r in radius for a in r["areas"]} - set(areas)),
        "risk_flags": flags,
        "toolchain": (head_root / "rust-toolchain.toml").read_text() if (head_root / "rust-toolchain.toml").exists() else None,
    })

    if meta["kind"] == "pr" and not offline:
        issues_dir = run_dir / "issues"
        issues_dir.mkdir(exist_ok=True)
        linked = []
        for n in linked_issue_numbers({**meta["pr"], "number": pr_number, "closingIssuesReferences": pr.get("closingIssuesReferences")}):
            try:
                issue = gh_json(["issue", "view", str(n), "-R", UPSTREAM, "--json", "number,title,state,body,comments,labels,url"])
            except LcrError:
                continue  # a PR number, or not accessible
            if issue:
                write_json(issues_dir / f"{n}.json", issue)
                linked.append({"number": n, "title": issue["title"], "state": issue["state"]})
        meta["linked_issues"] = linked
        try:
            open_prs = gh_json(["pr", "list", "-R", UPSTREAM, "--state", "open", "--limit", "300", "--json", "number,title,files,author,updatedAt"])
        except LcrError:
            open_prs = []
        mine = set(files)
        overlaps = []
        for other in open_prs or []:
            if other["number"] == pr_number:
                continue
            shared = sorted(mine & {f["path"] for f in other.get("files") or []} - {"src/lib.rs", "Cargo.lock", "yarn.lock"})
            if shared:
                overlaps.append({"number": other["number"], "title": other["title"], "author": (other.get("author") or {}).get("login"), "shared_files": shared})
        meta["overlapping_prs"] = sorted(overlaps, key=lambda o: (-len(o["shared_files"]), o["number"]))
        try:
            # `gh pr checks` exits non-zero when checks fail or are pending; the JSON is still valid.
            checks = gh_json(["pr", "checks", str(pr_number), "-R", UPSTREAM, "--json", "name,state,bucket,link"], check=False)
        except (LcrError, json.JSONDecodeError):
            checks = []
        meta["ci_checks"] = sorted(checks or [], key=lambda c: c["name"])
    write_json(run_dir / "prepare.json", meta)
    (cache_dir() / "runs" / "LATEST").write_text(run_id + "\n")
    return run_dir
