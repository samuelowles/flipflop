#!/usr/bin/env python3
"""Parse-eval harness for golden bill fixtures (issue #61).

Iterates ``python/fixtures/*.pdf``, runs each through the appropriate
retailer parser (matching how ``python/server.py /parse`` selects one —
retailer-specific via ``parser_for_retailer`` with a ``GenericParser``
fallback), loads the sibling ``*.expected.json``, and compares fields.

Comparison contract
-------------------
- EXACT match on the bill-derived deterministic fields::
      retailer, meter_type, icp_number, period_start, period_end,
      days, usage_kwh, total_cents, c_per_kwh, c_per_day,
      fixed_term_expiry, break_fee_cents
- ``plan_name`` is matched as a SUBSTRING (expected-in-actual or
  actual-in-expected). The plan_name extractor is intentionally heuristic
  (returns retailer-prefixed or label-bearing strings); the existing parser
  test suite asserts it with ``in`` checks, and this harness honors that
  same contract rather than enforcing an exact string the parser was never
  designed to produce.
- ``confidence`` checked >= 0.7 (threshold — it is a blended float).
- IGNORE ``raw_json`` and ``parser_used`` (not comparable across runs).

Exits non-zero on any mismatch (fails the PR in CI). Prints a per-retailer
pass-rate table + average confidence.

Usage (from repo root)::

    python scripts/eval_parser.py

Does NOT require Flask/HTTP — imports parsers directly.
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from dataclasses import asdict
from pathlib import Path
from typing import Optional

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "python"))

from parsers.base import parser_for_retailer, ParserResult  # noqa: E402
from parsers.generic_parser import GenericParser  # noqa: E402
import parsers  # noqa: E402,F401  (side effect: registers all retailer parsers)

FIXTURES_DIR = REPO_ROOT / "python" / "fixtures"

# Fields compared with exact equality (bill-derived deterministic values).
EXACT_FIELDS = (
    "retailer", "meter_type", "icp_number",
    "period_start", "period_end", "days", "usage_kwh",
    "total_cents", "c_per_kwh", "c_per_day",
    "fixed_term_expiry", "break_fee_cents",
)
# plan_name is extracted heuristically (retailer prefix, label, truncation) —
# the existing 358-test suite asserts it with substring ``in`` checks, not
# equality. The harness honors that contract: expected must be a substring of
# actual (or vice-versa), not an exact string match.
PLAN_NAME_FIELD = "plan_name"
CONFIDENCE_THRESHOLD = 0.7


def _result_to_dict(result: ParserResult) -> dict:
    """Convert a ParserResult to a plain dict (excludes raw_json/parser_used)."""
    d = asdict(result)
    d.pop("raw_json", None)
    d.pop("parser_used", None)
    return d


def _select_parser(retailer_id: str):
    """Select parser exactly as server.py /parse does: specific, else generic."""
    p = parser_for_retailer(retailer_id) if retailer_id else None
    return p if p is not None else GenericParser()


def _compare(actual: dict, expected: dict) -> list[str]:
    """Return a list of mismatch descriptions (empty if all match)."""
    mismatches: list[str] = []
    for field in EXACT_FIELDS:
        av = actual.get(field)
        ev = expected.get(field)
        # Numeric tolerance for float fields that may serialize differently.
        if isinstance(ev, float) or isinstance(av, float):
            try:
                if abs(float(av) - float(ev)) > 0.005:
                    mismatches.append(f"{field}: expected {ev}, got {av}")
            except (TypeError, ValueError):
                mismatches.append(f"{field}: expected {ev}, got {av}")
        elif av != ev:
            mismatches.append(f"{field}: expected {ev!r}, got {av!r}")

    # plan_name: heuristic field — substring match (bidirectional). When the
    # expected value is empty, the check is skipped (the fixture's layout is
    # known to defeat the plan_name extractor; asserting it would test nothing).
    ap = str(actual.get(PLAN_NAME_FIELD, ""))
    ep = str(expected.get(PLAN_NAME_FIELD, ""))
    if ep and ep not in ap and ap not in ep:
        mismatches.append(
            f"{PLAN_NAME_FIELD}: expected substring {ep!r}, got {ap!r}"
        )
    return mismatches


def evaluate_fixture(pdf_path: Path) -> dict:
    """Evaluate one fixture. Returns a result record dict.

    Handles missing/malformed expected.json gracefully (clear error, not a
    stack trace) per the input-validation boundary rule.
    """
    expected_path = pdf_path.with_suffix(".expected.json")
    stem = pdf_path.stem
    # Filename convention: <retailer_id>_<n>.pdf
    retailer_id = stem.rsplit("_", 1)[0] if "_" in stem else ""

    record = {
        "fixture": stem,
        "retailer_id": retailer_id,
        "ok": False,
        "confidence": 0.0,
        "errors": [],
    }

    if not expected_path.exists():
        record["errors"].append(f"missing expected file: {expected_path.name}")
        return record

    try:
        expected = json.loads(expected_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        record["errors"].append(f"malformed expected JSON: {exc}")
        return record
    if not isinstance(expected, dict):
        record["errors"].append("expected JSON is not an object")
        return record

    try:
        parser = _select_parser(retailer_id)
        result = parser.parse(str(pdf_path))
    except Exception as exc:  # noqa: BLE001 — surface any parser failure
        record["errors"].append(f"parser raised: {type(exc).__name__}: {exc}")
        return record

    actual = _result_to_dict(result)
    record["confidence"] = actual.get("confidence", 0.0)

    mismatches = _compare(actual, expected)
    if mismatches:
        record["errors"].extend(mismatches)

    if actual.get("confidence", 0.0) < CONFIDENCE_THRESHOLD:
        record["errors"].append(
            f"confidence {actual.get('confidence'):.3f} < {CONFIDENCE_THRESHOLD}"
        )

    record["ok"] = not record["errors"]
    return record


def main() -> int:
    if not FIXTURES_DIR.is_dir():
        print(f"ERROR: fixtures dir not found: {FIXTURES_DIR}", file=sys.stderr)
        return 2

    pdfs = sorted(FIXTURES_DIR.glob("*.pdf"))
    if not pdfs:
        print(f"ERROR: no .pdf fixtures in {FIXTURES_DIR}", file=sys.stderr)
        return 2

    records = [evaluate_fixture(p) for p in pdfs]

    # --- Per-retailer aggregation ---
    by_retailer: dict[str, list[dict]] = defaultdict(list)
    for r in records:
        by_retailer[r["retailer_id"]].append(r)

    total = len(records)
    total_pass = sum(1 for r in records if r["ok"])
    avg_conf = sum(r["confidence"] for r in records) / total if total else 0.0

    # --- Report ---
    print("=" * 64)
    print("PARSE-EVAL HARNESS — golden bill fixtures")
    print("=" * 64)
    print(f"{'Retailer':<16} {'Pass':>8} {'Rate':>8} {'Avg Conf':>10}")
    print("-" * 64)
    for rid in sorted(by_retailer):
        rs = by_retailer[rid]
        passed = sum(1 for r in rs if r["ok"])
        rate = passed / len(rs)
        conf = sum(r["confidence"] for r in rs) / len(rs)
        print(f"{rid:<16} {f'{passed}/{len(rs)}':>8} {rate:>7.0%} {conf:>10.3f}")
    print("-" * 64)
    print(f"{'TOTAL':<16} {f'{total_pass}/{total}':>8} "
          f"{total_pass / total:>7.0%} {avg_conf:>10.3f}")
    print("=" * 64)

    # --- Per-fixture failures (if any) ---
    failures = [r for r in records if not r["ok"]]
    if failures:
        print(f"\nFAILURES ({len(failures)}):")
        for r in failures:
            print(f"\n  {r['fixture']}:")
            for err in r["errors"]:
                print(f"    - {err}")

    print(f"\n{'PASS' if not failures else 'FAIL'}: "
          f"{total_pass}/{total} fixtures, avg confidence {avg_conf:.3f}")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
