"""Drive the JSONL adapter binary: one request at a time per worker, restart on crash/timeout.

Results are keyed by request id and returned sorted, so the output does not depend on the number
of workers or on scheduling.
"""
from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .common import LcrError, log


class AdapterProcess:
    def __init__(self, binary: Path, timeout: float = 10.0):
        self.binary = binary
        self.timeout = timeout
        self.proc = None
        self.lines: queue.Queue = queue.Queue()
        self.restarts = 0

    def start(self):
        self.proc = subprocess.Popen(
            [str(self.binary)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
            env={**os.environ, "RUST_BACKTRACE": "0"},
        )
        self.lines = queue.Queue()
        proc = self.proc

        def reader():
            for line in proc.stdout:
                self.lines.put(line)
            self.lines.put(None)

        threading.Thread(target=reader, daemon=True).start()

    def close(self):
        if self.proc:
            try:
                self.proc.kill()
            except OSError:
                pass
            self.proc = None

    def request(self, req: dict) -> dict:
        if self.proc is None or self.proc.poll() is not None:
            self.start()
        try:
            self.proc.stdin.write(json.dumps(req, ensure_ascii=False) + "\n")
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError):
            self.close()
            self.restarts += 1
            return {"id": req.get("id"), "ok": False, "stage": "crash", "error": "adapter stdin closed"}
        try:
            line = self.lines.get(timeout=self.timeout)
        except queue.Empty:
            self.close()
            self.restarts += 1
            return {"id": req.get("id"), "ok": False, "stage": "timeout", "error": f"no response within {self.timeout}s"}
        if line is None:
            code = self.proc.wait() if self.proc else None
            self.close()
            self.restarts += 1
            return {"id": req.get("id"), "ok": False, "stage": "crash", "error": f"adapter exited ({code}); stack overflow or abort"}
        try:
            resp = json.loads(line)
        except json.JSONDecodeError:
            self.close()
            self.restarts += 1
            return {"id": req.get("id"), "ok": False, "stage": "protocol", "error": line[:500]}
        return resp


def run_requests(binary: Path, requests: list[dict], workers: int | None = None, timeout: float = 10.0, label: str = "") -> dict[str, dict]:
    if not binary.exists():
        raise LcrError(f"adapter binary missing: {binary} (run `lcr build` first)")
    workers = workers or min(8, max(1, (os.cpu_count() or 2) // 2))
    chunks = [requests[i::workers] for i in range(workers)]
    results: dict[str, dict] = {}
    lock = threading.Lock()
    done = [0]
    total = len(requests)

    def work(chunk):
        proc = AdapterProcess(binary, timeout)
        try:
            for req in chunk:
                resp = proc.request(req)
                resp["id"] = req["id"]
                with lock:
                    results[req["id"]] = resp
                    done[0] += 1
                    if total >= 2000 and done[0] % 5000 == 0:
                        log(f"{label} {done[0]}/{total}")
        finally:
            proc.close()

    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(work, chunks))
    return dict(sorted(results.items()))


def normalize_response(resp: dict) -> dict:
    """The part of a response that defines behavior (used to detect base/head deltas)."""
    if resp.get("ok"):
        out = {"ok": True, "code": resp.get("code")}
        if resp.get("exports"):
            out["exports"] = resp["exports"]
        if resp.get("recognition"):
            out["recognition"] = resp["recognition"]
        return out
    error = resp.get("error") or ""
    # Error text carries locations and Debug noise; keep the stage and the error kind name.
    kind = error.split("|", 1)[-1].strip().split("(", 1)[0].split(" ", 1)[0] if "|" in error else error[:80]
    return {"ok": False, "stage": resp.get("stage"), "kind": kind}
