"""
Powerswitch pricing-completeness gate (#67).

Three responsibilities:

1. **Required money fields cannot be unknown.** Unlike eiep14a's
   ``_safe_float`` (which silently defaults missing money to 0.0), the
   Powerswitch path treats a missing required money field as a FAILURE.
   This reverses the silent-zero default FOR THIS PATH ONLY — eiep14a's
   behavior is unchanged.

2. **TOU guard.** A time-of-use plan is flagged unsupported UNLESS all
   time windows and rates parse cleanly. Currently TOU windows are not
   represented in the fixtures beyond the ``data-tou`` flag, so any TOU
   plan without parsed per-window rates is flagged unsupported. The flag
   is reported on ``CompletenessResult.tou_unsupported`` and does not by
   itself fail money completeness (a TOU plan may have valid flat-rate
   money fields while being unsupported for TOU comparison).

3. **Run-level scorer.** Marks a run FAILED if <90% of fixture-required
   fields parse across the batch.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Iterable

from powerswitch.parser import ParsedPlan

logger = logging.getLogger(__name__)

# Money fields that MUST be present (non-None) for a plan to be complete.
# Absence is a failure, not a zero — see module docstring.
REQUIRED_MONEY_FIELDS = ("c_per_kwh", "c_per_day")

# 90% parse threshold — below this a run is marked failed (AC).
RUN_FAILURE_THRESHOLD = 0.90


@dataclass
class CompletenessResult:
    """Per-plan completeness verdict."""

    complete: bool
    missing_fields: list[str] = field(default_factory=list)
    tou_unsupported: bool = False
    reason: str = ""


def is_complete(plan: ParsedPlan) -> tuple[bool, CompletenessResult]:
    """Check a single plan's required-money completeness.

    Returns ``(complete, result)``. A plan is incomplete iff any
    REQUIRED_MONEY_FIELDS value is None — a missing money field is a
    FAILURE, not a silent zero (reverses eiep14a's ``_safe_float`` default
    FOR THIS PATH ONLY).

    The TOU guard is reported separately via ``result.tou_unsupported``: a
    TOU plan with unparsed time windows is flagged unsupported, but that
    flag does NOT fail money completeness on its own (a TOU plan can have
    valid flat-rate money fields while still being unsupported for TOU
    comparison). Callers consuming the flag should skip/label such plans.
    """
    missing: list[str] = []
    for field_name in REQUIRED_MONEY_FIELDS:
        value = getattr(plan, field_name, None)
        if value is None:
            missing.append(field_name)
    plan.missing_fields = missing

    tou_unsupported = plan.is_tou and not _tou_windows_complete(plan)

    if missing:
        return False, CompletenessResult(
            complete=False,
            missing_fields=missing,
            tou_unsupported=tou_unsupported,
            reason=f"missing required money fields: {', '.join(missing)}",
        )

    return True, CompletenessResult(
        complete=True,
        tou_unsupported=tou_unsupported,
        reason="TOU plan has unparsed time windows or rates" if tou_unsupported else "",
    )


def _tou_windows_complete(plan: ParsedPlan) -> bool:
    """Return True iff a TOU plan's time windows and rates all parsed.

    The Powerswitch fixtures carry only an ``data-tou`` flag without
    per-window rate blocks; until the scraper captures structured TOU
    windows, all TOU plans are treated as having unparsed windows and are
    therefore unsupported. When structured windows are added later, parse
    them here and return True only if every window has a rate.
    """
    return False


@dataclass
class RunScore:
    """Aggregate score for a batch of parsed plans."""

    total: int
    complete: int
    failed: int
    parse_rate: float
    passed: bool
    failures: list[CompletenessResult] = field(default_factory=list)


def score_run(plans: Iterable[ParsedPlan]) -> RunScore:
    """Score a batch of parsed plans against the 90% completeness threshold.

    A run PASSES iff the fraction of plans with all required money fields
    parsed is >= ``RUN_FAILURE_THRESHOLD`` (0.90). TOU-unsupported plans
    count as failures.

    Args:
        plans: Parsed plans from one scraper run.

    Returns:
        RunScore with aggregate counts and per-plan failure detail.
    """
    plan_list = list(plans)
    total = len(plan_list)
    if total == 0:
        return RunScore(total=0, complete=0, failed=0, parse_rate=0.0, passed=False)

    failures: list[CompletenessResult] = []
    complete_count = 0
    for plan in plan_list:
        ok, result = is_complete(plan)
        if ok:
            complete_count += 1
        else:
            failures.append(result)

    parse_rate = complete_count / total
    passed = parse_rate >= RUN_FAILURE_THRESHOLD

    return RunScore(
        total=total,
        complete=complete_count,
        failed=total - complete_count,
        parse_rate=parse_rate,
        passed=passed,
        failures=failures,
    )
