#!/usr/bin/env python3
"""Benchmark harness for the Python service deployment (issue #20).

Measures cold-start and per-parse latency against the external-container
(Fly.io + Flask) target. The Pyodide path is not exercised — the Pillow
C-extension blocker (see python/DEPLOY.md) keeps it off the table until
upstream publishes a Pyodide wheel. The methodology for Pyodide is
documented in the module docstring below so the comparison is
reproducible when the blocker is removed.

Usage:
  # Cold start: time from first hit to first 200 OK on /health
  python scripts/bench-python-deploy.py --target container --cold-start

  # Per-parse latency: N iterations of POST /parse
  python scripts/bench-python-deploy.py --target container \\
      --parse --iterations 50

  # Custom URL + service token (defaults to PYTHON_SERVICE_URL /
  # PYTHON_SERVICE_AUTH_TOKEN env vars)
  python scripts/bench-python-deploy.py --target container --parse \\
      --url https://flip-python.fly.dev --token "$TOKEN"

Output is JSON appended to bench-results.json (one line per run) so
trends are visible across deploys.

Pyodide methodology (for future re-evaluation):
  1. Deploy a Cloudflare Worker with Pyodide bundled via the
     `python_workers` compatibility flag.
  2. Serve the parser module from the Worker; expose /parse and /health
     as Workers routes.
  3. Hit /health to measure Pyodide cold start (worker init + interpreter
     warm-up). p95 across 50 first-hits after idle >5min is the relevant
     number; the Worker runtime caches the interpreter, so this measures
     cold start of a *new* isolate, not of every request.
  4. Hit /parse with a 1-page bill PDF; measure end-to-end latency
     including PDF parsing. This is where the Pillow blocker hits.
  5. Compare p50 / p95 / p99 against the container numbers from this
     script. Pyodide wins only if its parse latency is < container AND
     the interpreter warm-up is < 5s p95.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


DEFAULT_URL = os.environ.get(
    "PYTHON_SERVICE_URL", "http://127.0.0.1:8080"
)
DEFAULT_TOKEN = os.environ.get("PYTHON_SERVICE_AUTH_TOKEN", "")
RESULTS_FILE = Path("bench-results.json")
FIXTURE_PDF = Path("test_eval.pdf")  # any PDF in the repo root


def _hit(url: str, payload: dict | None, token: str, timeout: float = 30.0):
    """POST JSON to `url` with optional bearer token. Returns (status, ms)."""
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method="POST" if data is not None else "GET",
        headers={"Content-Type": "application/json"},
    )
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    start = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            resp.read()  # drain body so the timing reflects full response
            status = resp.status
    except urllib.error.HTTPError as e:
        status = e.code
    except urllib.error.URLError:
        status = 0  # connection refused / DNS / timeout
    return status, (time.perf_counter() - start) * 1000.0


def measure_cold_start(url: str, token: str) -> dict:
    """First hit after idle — proxies container wake-up latency."""
    status, ms = _hit(f"{url}/health", None, token)
    return {
        "mode": "cold_start",
        "target": "container",
        "url": url,
        "first_hit_status": status,
        "first_hit_ms": round(ms, 2),
    }


def measure_parse(url: str, token: str, iterations: int) -> dict:
    """N consecutive parses; report p50/p95/p99 + mean."""
    if not FIXTURE_PDF.is_file():
        return {
            "mode": "parse",
            "target": "container",
            "url": url,
            "error": f"fixture not found: {FIXTURE_PDF}",
        }
    file_bytes = FIXTURE_PDF.read_bytes()
    file_b64 = base64.b64encode(file_bytes).decode()
    payload = {
        "file_bytes": file_b64,
        "retailer_id": "contact",  # any retailer; generic fallback otherwise
    }
    samples: list[float] = []
    statuses: list[int] = []
    for _ in range(iterations):
        status, ms = _hit(f"{url}/parse", payload, token)
        statuses.append(status)
        if status == 200:
            samples.append(ms)
    if not samples:
        return {
            "mode": "parse",
            "target": "container",
            "url": url,
            "iterations": iterations,
            "error": "no successful parses",
            "statuses": statuses,
        }
    samples.sort()
    return {
        "mode": "parse",
        "target": "container",
        "url": url,
        "iterations": iterations,
        "ok": len(samples),
        "p50_ms": round(samples[len(samples) // 2], 2),
        "p95_ms": round(samples[int(len(samples) * 0.95) - 1], 2),
        "p99_ms": round(samples[int(len(samples) * 0.99) - 1], 2),
        "mean_ms": round(statistics.mean(samples), 2),
        "max_ms": round(max(samples), 2),
        "statuses": statuses,
    }


def append_result(record: dict) -> None:
    """Append one JSON line to bench-results.json (creates if absent)."""
    record["timestamp"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with RESULTS_FILE.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--target", choices=["container", "pyodide"], default="container",
        help="deployment target to benchmark (pyodide is a no-op + doc)",
    )
    parser.add_argument(
        "--url", default=DEFAULT_URL,
        help=f"service URL (default: $PYTHON_SERVICE_URL or {DEFAULT_URL})",
    )
    parser.add_argument(
        "--token", default=DEFAULT_TOKEN,
        help="bearer token (default: $PYTHON_SERVICE_AUTH_TOKEN)",
    )
    parser.add_argument(
        "--cold-start", action="store_true",
        help="measure cold-start latency (first /health hit)",
    )
    parser.add_argument(
        "--parse", action="store_true",
        help="measure per-parse latency (POST /parse)",
    )
    parser.add_argument(
        "--iterations", type=int, default=20,
        help="iterations for --parse (default: 20)",
    )
    args = parser.parse_args()

    if args.target == "pyodide":
        # Pyodide is intentionally not exercised; surface the doc instead.
        print(
            "pyodide target: no live benchmark. See module docstring for "
            "methodology. Re-run when python/DEPLOY.md blocker is removed."
        )
        return 0

    if not (args.cold_start or args.parse):
        parser.error("specify --cold-start and/or --parse")

    records: list[dict] = []
    if args.cold_start:
        records.append(measure_cold_start(args.url, args.token))
    if args.parse:
        records.append(measure_parse(args.url, args.token, args.iterations))

    for record in records:
        append_result(record)
        print(json.dumps(record, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
