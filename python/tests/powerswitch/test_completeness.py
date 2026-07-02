"""Tests for the Powerswitch completeness gate (#67)."""

from __future__ import annotations

from pathlib import Path

import pytest

from powerswitch.parser import _extract_plan, ParsedPlan
from powerswitch.completeness import (
    CompletenessResult,
    REQUIRED_MONEY_FIELDS,
    RUN_FAILURE_THRESHOLD,
    is_complete,
    score_run,
)

_FIXTURES = (
    Path(__file__).resolve().parent.parent.parent.parent
    / "workers"
    / "tests"
    / "fixtures"
    / "powerswitch"
)


def _fixture(name: str) -> str:
    path = _FIXTURES / name
    assert path.exists(), f"missing #66 fixture: {path}"
    return path.read_text(encoding="utf-8")


def _make_plan(**kwargs) -> ParsedPlan:
    """Build a ParsedPlan with sensible complete defaults."""
    plan = ParsedPlan()
    plan.retailer = "Mercury"
    plan.retailer_id = "mercury"
    plan.plan_name = "Open Variable"
    plan.region = "Auckland"
    plan.c_per_kwh = 29.1
    plan.c_per_day = 2.3
    for k, v in kwargs.items():
        setattr(plan, k, v)
    return plan


class TestRequiredMoneyFields:
    """Missing money = FAILURE (reverses eiep14a silent-0.0 default)."""

    def test_constants(self):
        assert REQUIRED_MONEY_FIELDS == ("c_per_kwh", "c_per_day")

    def test_complete_plan_passes(self):
        ok, result = is_complete(_make_plan())
        assert ok is True
        assert result.complete is True
        assert result.missing_fields == []

    def test_missing_c_per_kwh_fails(self):
        ok, result = is_complete(_make_plan(c_per_kwh=None))
        assert ok is False
        assert "c_per_kwh" in result.missing_fields
        assert "money" in result.reason

    def test_missing_c_per_day_fails(self):
        ok, result = is_complete(_make_plan(c_per_day=None))
        assert ok is False
        assert "c_per_day" in result.missing_fields

    def test_both_money_missing_fails(self):
        ok, result = is_complete(_make_plan(c_per_kwh=None, c_per_day=None))
        assert ok is False
        assert set(result.missing_fields) == {"c_per_kwh", "c_per_day"}

    def test_flick_incomplete_fixture_fails(self):
        """The #66 incomplete Flick fixture must fail completeness."""
        plan = _extract_plan(_fixture("flick_incomplete.html"), source_url="u")
        assert plan is not None
        ok, result = is_complete(plan)
        assert ok is False
        assert "c_per_kwh" in result.missing_fields
        assert "c_per_day" in result.missing_fields


class TestTouGuard:
    """TOU plans flagged unsupported unless windows parse cleanly."""

    def test_tou_plan_flagged_unsupported(self):
        """A TOU plan with no parsed windows → tou_unsupported=True.

        Money completeness is independent: it still passes if the flat
        money fields are present.
        """
        plan = _make_plan(is_tou=True)
        ok, result = is_complete(plan)
        # Money is complete, so is_complete returns True...
        assert ok is True
        # ...but the TOU flag is raised.
        assert result.tou_unsupported is True

    def test_non_tou_plan_not_flagged(self):
        plan = _make_plan(is_tou=False)
        ok, result = is_complete(plan)
        assert ok is True
        assert result.tou_unsupported is False

    def test_mercury_tou_fixture_flagged(self):
        plan = _extract_plan(_fixture("mercury_christchurch_tou.html"), source_url="u")
        assert plan is not None
        assert plan.is_tou is True
        _ok, result = is_complete(plan)
        assert result.tou_unsupported is True

    def test_tou_with_missing_money_still_fails_completeness(self):
        """TOU-unsupported flag doesn't override a real money failure."""
        plan = _make_plan(is_tou=True, c_per_kwh=None)
        ok, result = is_complete(plan)
        assert ok is False
        assert result.tou_unsupported is True
        assert "c_per_kwh" in result.missing_fields


class TestRunScorer:
    """90% parse-rate threshold for a run."""

    def test_empty_run_fails(self):
        score = score_run([])
        assert score.passed is False
        assert score.total == 0
        assert score.parse_rate == 0.0

    def test_all_complete_passes(self):
        plans = [_make_plan() for _ in range(10)]
        score = score_run(plans)
        assert score.total == 10
        assert score.complete == 10
        assert score.failed == 0
        assert score.parse_rate == 1.0
        assert score.passed is True

    def test_below_threshold_fails(self):
        """<90% complete → run failed. 8/10 = 80%."""
        plans = [_make_plan() for _ in range(8)] + [
            _make_plan(c_per_kwh=None) for _ in range(2)
        ]
        score = score_run(plans)
        assert score.complete == 8
        assert score.failed == 2
        assert score.parse_rate == pytest.approx(0.8)
        assert score.passed is False

    def test_at_threshold_passes(self):
        """Exactly 90% → passes (>= threshold)."""
        plans = [_make_plan() for _ in range(9)] + [_make_plan(c_per_kwh=None)]
        score = score_run(plans)
        assert score.parse_rate == pytest.approx(0.9)
        assert score.passed is True

    def test_threshold_constant(self):
        assert RUN_FAILURE_THRESHOLD == 0.90

    def test_full_fixture_batch_passes(self):
        """All 13 #66 fixtures parsed as a single run.

        1 incomplete (Flick), 1 drifted (yields no plan → excluded),
        11 complete → 11/12 = 91.7% ≥ 90% → pass.
        """
        fixture_names = [
            "contact_auckland_standard.html",
            "contact_wellington_lowuser.html",
            "genesis_auckland_standard.html",
            "mercury_auckland_standard.html",
            "mercury_christchurch_tou.html",
            "meridian_wellington_standard.html",
            "nova_auckland_lowuser.html",
            "powershop_auckland.html",
            "pulse_auckland_full.html",
            "trustpower_wellington.html",
            "electric_kiwi_christchurch.html",
            "flick_incomplete.html",
            "drifted_structure.html",
        ]
        plans = []
        for name in fixture_names:
            plan = _extract_plan(_fixture(name), source_url=f"u/{name}")
            if plan is not None:  # drifted_structure yields None
                plans.append(plan)

        score = score_run(plans)
        assert score.total == 12  # 13 minus the drifted page
        assert score.complete == 11  # all but Flick
        assert score.failed == 1
        assert score.parse_rate == pytest.approx(11 / 12)
        assert score.passed is True

    def test_subthreshold_batch_fails(self):
        """A synthetic batch below 90% fails the run."""
        plans = [_make_plan() for _ in range(5)] + [
            _make_plan(c_per_kwh=None, c_per_day=None) for _ in range(2)
        ]
        score = score_run(plans)
        assert score.parse_rate == pytest.approx(5 / 7)
        assert score.passed is False
        assert len(score.failures) == 2
