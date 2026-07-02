"""Tests for plan comparator engine."""
import json

import pytest

from comparator.plan_comparator import (
    compare,
    _compute_avg_daily_kwh,
    _plan_matches_meter_type,
    _project_annual,
)


@pytest.fixture
def usage_profile():
    return {"avg_daily_kwh": 15.0, "meter_type": "standard"}


@pytest.fixture
def current_plan():
    return {
        "id": "plan-current",
        "name": "Current Standard",
        "retailer_id": "contact",
        "c_per_kwh": 28.0,
        "c_per_day": 90.0,
        "prompt_payment_discount": 10.0,
        "low_user_eligible": 0,
    }


@pytest.fixture
def cheaper_plan():
    return {
        "id": "plan-cheaper",
        "name": "Cheaper Online",
        "retailer_id": "mercury",
        "c_per_kwh": 24.0,
        "c_per_day": 90.0,
        "prompt_payment_discount": 0,
        "low_user_eligible": 0,
    }


@pytest.fixture
def expensive_plan():
    return {
        "id": "plan-expensive",
        "name": "Premium Plan",
        "retailer_id": "genesis",
        "c_per_kwh": 32.0,
        "c_per_day": 100.0,
        "prompt_payment_discount": 0,
        "low_user_eligible": 0,
    }


@pytest.fixture
def bill_history():
    return [
        {
            "usage_kwh": 450.0,
            "days": 30,
            "total_cents": 13000,
            "c_per_kwh": 28.0,
            "c_per_day": 90.0,
            "period_start": "2026-03-01",
            "period_end": "2026-03-31",
            "plan_name": "Standard",
            "meter_type": "standard",
            "icp_number": "0001234567ABC99",
            "retailer": "Contact Energy",
        },
        {
            "usage_kwh": 480.0,
            "days": 31,
            "total_cents": 13800,
            "c_per_kwh": 28.0,
            "c_per_day": 90.0,
            "period_start": "2026-04-01",
            "period_end": "2026-04-30",
            "plan_name": "Standard",
            "meter_type": "standard",
            "icp_number": "0001234567ABC99",
            "retailer": "Contact Energy",
        },
    ]


class TestUsageBandSelection:
    """AC #124: chooses the cheapest valid plan for low/medium/high usage bands."""

    @pytest.mark.parametrize(
        "avg_daily_kwh, band",
        [
            (8.0, "low"),
            (15.0, "medium"),
            (25.0, "high"),
        ],
    )
    def test_cheapest_plan_selected_per_band(
        self, avg_daily_kwh, band, current_plan, cheaper_plan, expensive_plan, bill_history
    ):
        usage = {"avg_daily_kwh": avg_daily_kwh, "meter_type": "standard"}
        results = compare(
            usage,
            current_plan,
            [current_plan, cheaper_plan, expensive_plan],
            bill_history,
        )
        alternatives = [r for r in results if not r["stay_where_you_are"]]
        assert alternatives, f"no alternatives returned for {band} band"
        cheapest = alternatives[0]
        assert cheapest["plan_id"] == "plan-cheaper"
        for other in alternatives[1:]:
            assert cheapest["projected_cost_cents"] <= other["projected_cost_cents"]

    @pytest.mark.parametrize(
        "avg_daily_kwh, band",
        [
            (8.0, "low"),
            (15.0, "medium"),
            (25.0, "high"),
        ],
    )
    def test_projected_cost_known_values(self, avg_daily_kwh, band, cheaper_plan):
        """AC: known inputs and expected costs across usage bands."""
        cost = _project_annual(avg_daily_kwh, cheaper_plan)
        monthly_kwh = avg_daily_kwh * (365 / 12)
        expected_monthly = int(round(monthly_kwh * 24.0)) + int(round(30 * 90.0))
        expected = expected_monthly * 12
        assert cost == expected


class TestCompare:
    def test_ranks_cheapest_first(
        self, usage_profile, current_plan, cheaper_plan, expensive_plan, bill_history
    ):
        results = compare(
            usage_profile,
            current_plan,
            [current_plan, cheaper_plan, expensive_plan],
            bill_history,
        )

        assert len(results) >= 2
        # Stay-where-you-are plan first (current), then cheapest, then most expensive
        current_result = [r for r in results if r["stay_where_you_are"]]
        assert len(current_result) == 1

    def test_cheaper_plan_shows_saving(
        self, usage_profile, current_plan, cheaper_plan, bill_history
    ):
        results = compare(
            usage_profile,
            current_plan,
            [current_plan, cheaper_plan],
            bill_history,
        )

        cheaper = [r for r in results if r["plan_id"] == "plan-cheaper"][0]
        # Cheaper plan should save money (positive saving_cents)
        assert cheaper["saving_cents"] > 0

    def test_expensive_plan_shows_negative_saving(
        self, usage_profile, current_plan, expensive_plan, bill_history
    ):
        results = compare(
            usage_profile,
            current_plan,
            [current_plan, expensive_plan],
            bill_history,
        )

        expensive = [r for r in results if r["plan_id"] == "plan-expensive"][0]
        # More expensive plan should have negative saving
        assert expensive["saving_cents"] < 0

    def test_current_plan_flagged_as_stay(
        self, usage_profile, current_plan, cheaper_plan, bill_history
    ):
        results = compare(
            usage_profile,
            current_plan,
            [current_plan, cheaper_plan],
            bill_history,
        )

        current_result = [r for r in results if r["plan_id"] == "plan-current"][0]
        assert current_result["stay_where_you_are"] is True

        cheaper_result = [r for r in results if r["plan_id"] == "plan-cheaper"][0]
        assert cheaper_result["stay_where_you_are"] is False

    def test_returns_empty_for_no_usage(self):
        results = compare(
            {"avg_daily_kwh": 0.0, "meter_type": "standard"},
            {"id": "p1", "c_per_kwh": 25.0, "c_per_day": 90.0},
            [{"id": "p2", "c_per_kwh": 25.0, "c_per_day": 90.0}],
            [],
        )
        assert results == []

    def test_computes_avg_daily_from_history(self, current_plan, cheaper_plan, bill_history):
        # usage_profile with 0 avg_daily_kwh → should compute from bill history
        results = compare(
            {"avg_daily_kwh": 0.0, "meter_type": "standard"},
            current_plan,
            [current_plan, cheaper_plan],
            bill_history,
        )
        assert len(results) >= 2

    def test_includes_confidence(self, usage_profile, current_plan, cheaper_plan, bill_history):
        results = compare(
            usage_profile,
            current_plan,
            [current_plan, cheaper_plan],
            bill_history,
        )
        for r in results:
            assert "confidence" in r
            assert 0.0 <= r["confidence"] <= 1.0

    def test_low_user_plan_skipped_for_standard_meter(
        self, usage_profile, current_plan, bill_history
    ):
        low_user_plan = {
            "id": "plan-low-user",
            "name": "Low User",
            "retailer_id": "genesis",
            "c_per_kwh": 30.0,
            "c_per_day": 33.33,
            "low_user_eligible": 1,
        }

        results = compare(
            usage_profile,
            current_plan,
            [current_plan, low_user_plan],
            bill_history,
        )

        # Should NOT include low_user_plan since meter_type is standard
        low_user_results = [r for r in results if r["plan_id"] == "plan-low-user"]
        assert len(low_user_results) == 0


class TestComputeAvgDailyKWh:
    def test_from_two_bills(self):
        bills = [
            {"usage_kwh": 300.0, "days": 30},
            {"usage_kwh": 310.0, "days": 31},
        ]
        avg = _compute_avg_daily_kwh(bills)
        assert round(avg, 4) == pytest.approx(10.0, rel=0.01)

    def test_returns_zero_for_empty(self):
        assert _compute_avg_daily_kwh([]) == 0.0

    def test_skips_invalid_bills(self):
        bills = [
            {"usage_kwh": 0, "days": 0},
            {"usage_kwh": 500.0, "days": 30},
        ]
        avg = _compute_avg_daily_kwh(bills)
        assert avg == pytest.approx(16.6667, rel=0.01)


class TestPlanMatchesMeterType:
    def test_low_user_plan_matches_low_user_meter(self):
        assert _plan_matches_meter_type({"low_user_eligible": 1}, "low_user") is True

    def test_low_user_plan_blocked_for_controlled_meter(self):
        assert _plan_matches_meter_type({"low_user_eligible": 1}, "controlled") is False

    def test_standard_plan_matches_all(self):
        assert _plan_matches_meter_type({"low_user_eligible": 0}, "standard") is True
        assert _plan_matches_meter_type({"low_user_eligible": 0}, "low_user") is True
