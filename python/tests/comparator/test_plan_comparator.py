"""Tests for plan comparator engine."""
import json

import pytest

from comparator.plan_comparator import compare, _compute_avg_daily_kwh, _plan_matches_meter_type


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


class TestUnsupportedFlag:
    """AC #125: TOU and missing-field plans flagged unsupported, no fake saving."""

    def test_tou_plan_flagged_unsupported(self, usage_profile, current_plan, bill_history):
        tou_plan = {
            "id": "plan-tou",
            "name": "TOU Plan",
            "retailer_id": "mercury",
            "c_per_kwh": 25.0,
            "c_per_day": 90.0,
            "conditions_json": json.dumps({"is_tou": True}),
        }
        results = compare(usage_profile, current_plan, [current_plan, tou_plan], bill_history)

        tou_result = [r for r in results if r["plan_id"] == "plan-tou"][0]
        assert tou_result["unsupported"] is True
        assert "time-of-use" in tou_result["unsupported_reason"]
        # Must NOT show a saving (zero prevents bogus switch recommendation)
        assert tou_result["saving_cents"] == 0
        assert tou_result["projected_cost_cents"] == 0

    def test_tou_plan_via_rate_type_flagged(self, usage_profile, current_plan, bill_history):
        tou_plan = {
            "id": "plan-tou-rt",
            "name": "TOU Rate",
            "retailer_id": "genesis",
            "c_per_kwh": 25.0,
            "c_per_day": 90.0,
            "conditions_json": json.dumps({"rate_type": "TOU"}),
        }
        results = compare(usage_profile, current_plan, [current_plan, tou_plan], bill_history)
        tou_result = [r for r in results if r["plan_id"] == "plan-tou-rt"][0]
        assert tou_result["unsupported"] is True

    def test_missing_field_plan_flagged_unsupported(
        self, usage_profile, current_plan, bill_history
    ):
        # No c_per_kwh and no tier_thresholds_json -> unsupported
        missing_plan = {
            "id": "plan-missing",
            "name": "Missing Fields",
            "retailer_id": "contact",
            "c_per_day": 90.0,
        }
        results = compare(
            usage_profile, current_plan, [current_plan, missing_plan], bill_history
        )
        missing_result = [r for r in results if r["plan_id"] == "plan-missing"][0]
        assert missing_result["unsupported"] is True
        assert "missing" in missing_result["unsupported_reason"]
        assert missing_result["saving_cents"] == 0

    def test_supported_plan_has_unsupported_false(
        self, usage_profile, current_plan, cheaper_plan, bill_history
    ):
        results = compare(
            usage_profile, current_plan, [current_plan, cheaper_plan], bill_history
        )
        for r in results:
            assert r["unsupported"] is False
            assert "unsupported_reason" not in r

    def test_unsupported_plan_does_not_trigger_switch(
        self, usage_profile, current_plan, bill_history
    ):
        # A TOU plan with a deceptively low c_per_kwh must NOT appear as a saving
        tou_plan = {
            "id": "plan-tou-cheap",
            "name": "Cheap TOU",
            "retailer_id": "mercury",
            "c_per_kwh": 1.0,  # would fake a huge saving if priced at flat rate
            "c_per_day": 30.0,
            "conditions_json": json.dumps({"is_tou": True}),
        }
        results = compare(usage_profile, current_plan, [current_plan, tou_plan], bill_history)
        tou_result = [r for r in results if r["plan_id"] == "plan-tou-cheap"][0]
        assert tou_result["unsupported"] is True
        assert tou_result["saving_cents"] == 0


class TestExitFeeAwareness:
    """AC #125: exit-fee / break-fee logic still works (regression guard)."""

    def test_break_fee_warning_when_saving_erased(self, bill_history):
        # Current plan has a break fee that exceeds the saving from switching
        current = {
            "id": "plan-current",
            "name": "Current",
            "retailer_id": "contact",
            "c_per_kwh": 28.0,
            "c_per_day": 90.0,
            "break_fee_cents": 50000,  # large break fee in cents
        }
        cheaper = {
            "id": "plan-cheaper",
            "name": "Cheaper",
            "retailer_id": "mercury",
            "c_per_kwh": 27.5,  # small saving, well under the break fee
            "c_per_day": 90.0,
        }
        results = compare(
            {"avg_daily_kwh": 15.0, "meter_type": "standard"},
            current,
            [current, cheaper],
            bill_history,
        )
        cheaper_result = [r for r in results if r["plan_id"] == "plan-cheaper"][0]
        # The raw saving is positive but the break fee erases it
        assert cheaper_result.get("break_fee_warning") is True
        assert cheaper_result["net_first_year_saving_cents"] < 0

    def test_no_break_fee_warning_when_fee_zero(
        self, usage_profile, current_plan, cheaper_plan, bill_history
    ):
        results = compare(
            usage_profile, current_plan, [current_plan, cheaper_plan], bill_history
        )
        cheaper_result = [r for r in results if r["plan_id"] == "plan-cheaper"][0]
        assert "break_fee_warning" not in cheaper_result
