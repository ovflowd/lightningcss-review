"""lcr: deterministic review harness for parcel-bundler/lightningcss pull requests."""
from __future__ import annotations

import argparse
import errno
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lcr.common import LcrError, cache_dir, log  # noqa: E402


def resolve_run(value: str | None) -> Path:
    """A run id, a PR number (its newest run) or `latest`. Never implicit: concurrent reviews
    share runs/LATEST, so the resolved id is printed whenever it was not spelled out."""
    runs = cache_dir() / "runs"
    if not value:
        raise LcrError("pass a run id, a PR number or `latest`")
    if value == "latest":
        latest = runs / "LATEST"
        if not latest.exists():
            raise LcrError("no runs yet; start with `lcr prepare <PR>`")
        value = latest.read_text().strip()
        log(f"latest -> {value}")
    if value.isdigit():
        matches = sorted(runs.glob(f"pr{value}-*"), key=lambda p: (p.stat().st_mtime, p.name))
        if not matches:
            raise LcrError(f"no run for PR #{value}; run `lcr prepare {value}`")
        if len(matches) > 1:
            log(f"PR #{value} -> {matches[-1].name} (newest of {len(matches)} runs)")
        return matches[-1]
    path = runs / value
    if not path.exists():
        raise LcrError(f"unknown run {value}")
    return path


def clean(run: str | None, keep: int, results: bool) -> int:
    """Without flags: delete all but the newest `keep` runs. `<run>`: drop its instrumented build
    trees (build.json and the adapters stay). `--results`: drop raw oracle results and screenshots
    wherever verdicts.jsonl exists (of one run, or of every run)."""
    import shutil as _sh

    runs_dir = cache_dir() / "runs"
    if run is None and not results:
        runs = sorted((p for p in runs_dir.iterdir() if p.is_dir()), key=lambda p: p.stat().st_mtime, reverse=True)
        for old in runs[keep:]:
            _sh.rmtree(old)
            log(f"removed {old.name}")
        return 0
    targets = [resolve_run(run)] if run else sorted(p for p in runs_dir.iterdir() if p.is_dir())
    freed = sum(clean_run(run_dir, build_trees=bool(run), results=results) for run_dir in targets)
    log(f"freed {freed >> 20} MiB in {len(targets)} run(s)")
    return 0


def clean_run(run_dir: Path, build_trees: bool, results: bool) -> int:
    """Delete what later stages no longer read; returns the bytes freed."""
    import shutil as _sh

    freed = 0

    def drop(path: Path) -> None:
        nonlocal freed
        if path.is_dir():
            freed += sum(f.stat().st_size for f in path.rglob("*") if f.is_file())
            _sh.rmtree(path)
        elif path.exists():
            freed += path.stat().st_size
            path.unlink()

    if build_trees and (run_dir / "build.json").exists():
        for side in ("base", "head"):
            drop(run_dir / "build" / side / "tree")
    if results:
        for verdicts in sorted(run_dir.glob("oracle/**/verdicts.jsonl")):
            for raw in sorted(verdicts.parent.glob("results-*.jsonl")):
                drop(raw)
            drop(verdicts.parent / "shots")
    return freed


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="lcr", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("doctor", help="check host requirements and images")
    p = sub.add_parser("setup", help="build Docker images (builder + browser engines) and record versions")
    p.add_argument("--profiles", default=None, help="comma-separated engine profiles (default: config/engines.json default_profiles)")
    p.add_argument("--rebuild", action="store_true")

    p = sub.add_parser("prepare", help="resolve PR -> base/head trees, classify the change")
    p.add_argument("pr", nargs="?", type=int)
    p.add_argument("--range", dest="local_range", help="review a local <base>..<head> instead of a PR")
    p.add_argument("--offline", action="store_true", help="do not fetch (use refs already present)")

    for name, help_text in (
        ("build", "fmt check, inject recorder, cargo test (both sides), build adapters"),
        ("corpus", "assemble cases (tests, probes, WPT, real-world), run base/head adapters, compute deltas"),
        ("probe", "run the agent-written probes in <run>/probes through both adapters"),
        ("oracle", "run browser oracles on deltas, PR tests and probes"),
        ("perf", "optional: release-build timing on the real-world corpus and binary size, base vs head"),
        ("report", "compute verdict and render report.md/report.json from the templates"),
        ("status", "show stage status for a run"),
    ):
        p = sub.add_parser(name, help=help_text)
        p.add_argument("run", nargs="?", help="run id, PR number, or 'latest'")
        if name == "build":
            p.add_argument("--js", action="store_true", help="also run the JS lane (yarn build/test/tsc)")
            p.add_argument("--jobs", type=int, default=None)
        if name == "corpus":
            p.add_argument("--wpt", choices=["auto", "all", "none"], default="auto")
            p.add_argument("--realworld", choices=["auto", "all", "none"], default="auto")
        if name == "oracle":
            p.add_argument("--profiles", default=None)
            p.add_argument("--max-cases", type=int, default=4000)
            p.add_argument("--rerun", default=None, metavar="IDS", help="re-run only these case ids or globs (comma/space separated) and merge them into oracle.json")
        if name == "report":
            p.add_argument("--allow-incomplete", action="store_true", help="render even if analysis.json is missing")

    p = sub.add_parser("worklist", help="write/refresh analysis.json with every slot the report needs; print the open ones")
    p.add_argument("run", nargs="?")

    p = sub.add_parser("brief", help="compact digest of a run for the reviewer (instead of raw JSON)")
    p.add_argument("run", nargs="?")

    p = sub.add_parser("summary", help="print the fixed chat summary for a reported run")
    p.add_argument("run", nargs="?")

    p = sub.add_parser("show", help="print one case: input, base/head output, per-engine oracle diffs")
    p.add_argument("run")
    p.add_argument("case")
    p.add_argument("--json", action="store_true", help="everything about the case, untruncated")

    p = sub.add_parser("table", help="one line per oracle case: transition, base/head status, bad engines, legacy")
    p.add_argument("run")
    p.add_argument("--transition", default=None, help="only these transitions (comma separated)")
    p.add_argument("--check", default=None, help="only the cases a report check lists (needs report.json)")
    p.add_argument("--case", default=None, help="only case ids matching this glob")
    p.add_argument("--json", action="store_true")

    p = sub.add_parser("review", help="prepare + build + corpus (stops before the agent analysis step)")
    p.add_argument("pr", type=int)
    p.add_argument("--js", action="store_true")

    p = sub.add_parser("wpt", help="fetch the pinned WPT revision and extract the parsing corpus")
    p.add_argument("--refresh", action="store_true")

    p = sub.add_parser("realworld", help="download the pinned real-world CSS corpus")

    p = sub.add_parser("spec-coverage", help="webref inventory vs. what LightningCSS parses (missing features)")
    p.add_argument("--tree", default=None, help="source tree (default: the persistent clone)")

    p = sub.add_parser("clean", help="delete old runs; with <run> drop its build trees; --results drops raw oracle results")
    p.add_argument("run", nargs="?", help="run id, PR number or 'latest'")
    p.add_argument("--keep", type=int, default=10, help="most recent runs to keep (default 10)")
    p.add_argument("--results", action="store_true", help="delete oracle results-*.jsonl and screenshots once verdicts.jsonl exists")

    p = sub.add_parser("baseline", help="run every curated probe on current master through the oracle")
    p.add_argument("--profiles", default=None)

    p = sub.add_parser("selftest", help="run the oracle's known-answer cases in every engine profile")
    p.add_argument("--profiles", default=None)

    p = sub.add_parser("validate-probes", help="parse every probe file and report format errors")
    p.add_argument("paths", nargs="*")

    args = parser.parse_args(argv)
    try:
        if args.command == "doctor":
            from lcr.setup import doctor

            return doctor()
        if args.command == "setup":
            from lcr.setup import setup

            return setup(args.profiles, args.rebuild)
        if args.command == "prepare":
            from lcr.prepare import prepare

            run_dir = prepare(args.pr, args.local_range, args.offline)
            print(run_dir)
            return 0
        if args.command == "review":
            from lcr.prepare import prepare
            from lcr.build import build
            from lcr.corpus import corpus

            run_dir = prepare(args.pr)
            build(run_dir, js=args.js)
            corpus(run_dir)
            from lcr.status import brief

            print()
            brief(run_dir)
            return 0
        if args.command == "wpt":
            from lcr.wpt import ensure_fixtures

            print(ensure_fixtures(refresh=args.refresh))
            return 0
        if args.command == "spec-coverage":
            from lcr.common import repo_dir
            from lcr.spec import spec_coverage

            print(spec_coverage(Path(args.tree) if args.tree else repo_dir()))
            return 0
        if args.command == "clean":
            return clean(args.run, args.keep, args.results)
        if args.command == "baseline":
            from lcr.oracle import baseline

            print(baseline(args.profiles))
            return 0
        if args.command == "selftest":
            from lcr.oracle import selftest

            return selftest(args.profiles)
        if args.command == "realworld":
            from lcr.realworld import ensure_realworld

            print(ensure_realworld())
            return 0
        if args.command == "validate-probes":
            from lcr.probes import validate_cli

            paths = []
            for p in args.paths:
                # accept a run id / PR number / 'latest' as shorthand for <run>/probes
                if not Path(p).exists():
                    paths.append(str(resolve_run(p) / "probes"))
                else:
                    paths.append(p)
            return validate_cli(paths)
        run_dir = resolve_run(args.run)
        if args.command == "worklist":
            from lcr.status import worklist

            worklist(run_dir)
            return 0
        if args.command == "brief":
            from lcr.status import brief

            brief(run_dir)
            return 0
        if args.command == "summary":
            from lcr.report import summary

            summary(run_dir)
            return 0
        if args.command == "show":
            from lcr.show import show

            show(run_dir, args.case, as_json=args.json)
            return 0
        if args.command == "table":
            from lcr.show import table

            table(run_dir, transition=args.transition, check=args.check, pattern=args.case, as_json=args.json)
            return 0
        if args.command == "build":
            from lcr.build import build

            build(run_dir, js=args.js, jobs=args.jobs)
        elif args.command == "corpus":
            from lcr.corpus import corpus

            corpus(run_dir, wpt=args.wpt, realworld=args.realworld)
        elif args.command == "probe":
            from lcr.corpus import run_probes

            run_probes(run_dir)
        elif args.command == "oracle":
            from lcr.oracle import oracle

            oracle(run_dir, profiles=args.profiles, max_cases=args.max_cases, rerun=args.rerun)
        elif args.command == "perf":
            from lcr.perf import perf

            perf(run_dir)
        elif args.command == "report":
            from lcr.report import report

            report(run_dir, allow_incomplete=args.allow_incomplete)
        elif args.command == "status":
            from lcr.status import status

            status(run_dir)
        print(run_dir)
        return 0
    except LcrError as e:
        log(f"error: {e}")
        return 2
    except OSError as e:
        if e.errno != errno.ENOSPC:
            raise
        from lcr.common import DISK_REMEDY

        log(f"error: no space left on device ({e.filename or 'cache'}); {DISK_REMEDY}")
        return 2
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
