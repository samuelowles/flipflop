"""Tests for pricing helper functions."""
import json

from comparator.pricing import (
    calculate_bill_cost,
    apply_tiers,
    apply_discount,
    is_low_user_eligible,
    is_unsupported_plan,
    project_annual_cost,
)


class TestCalculateBillCost:
    def test_simple_plan_no_discount(self):
        plan = {
            "c_per_kwh": 25.0,
            "c_per_day": 90.0,
            "prompt_payment_discount": 0,
        }
        # 500 kWh over 30 days
        cost = calculate_bill_cost(500.0, 30, plan)
        # Energy: 500 * 0.25 = $125.00 = 12500 cents
        # Daily: 30 * 0.90 = $27.00 = 2700 cents
        # Total: 15200 cents
        assert cost == 15200

    def test_zero_usage(self):
        plan = {"c_per_kwh": 25.0, "c_per_day": 90.0, "prompt_payment_discount": 0}
        cost = calculate_bill_cost(0.0, 30, plan)
        # Daily only: 2700 cents
        assert cost == 2700

    def test_with_prompt_payment_discount(self):
        plan = {
            "c_per_kwh": 25.0,
            "c_per_day": 90.0,
            "prompt_payment_discount": 10.0,  # 10%
        }
        cost = calculate_bill_cost(500.0, 30, plan)
        # Subtotal = 15200
        # Discount 10% = 1520
        # Total = 13680
        assert cost == 13680

    def test_large_usage(self):
        plan = {"c_per_kwh": 30.0, "c_per_day": 90.0, "prompt_payment_discount": 0}
        cost = calculate_bill_cost(1000.0, 31, plan)
        # Energy: 1000 * 0.30 = 30000 cents
        # Daily: 31 * 0.90 = 2790 cents = 27.90
        # Total: 32790 cents
        assert cost == 32790


class TestApplyTiers:
    def test_single_tier(self):
        tiers = [{"threshold_kwh": 0, "c_per_kwh": 25.0}]
        rate = apply_tiers(500.0, tiers)
        assert rate == 25.0

    def test_two_tiers_split(self):
        tiers = [
            {"threshold_kwh": 500, "c_per_kwh": 30.0},
            {"threshold_kwh": 0, "c_per_kwh": 25.0},
        ]
        # 800 kWh: 500 at 30.0 + 300 at 25.0 = 15000 + 7500 = 22500
        # Effective rate: 22500 / 800 = 28.125 c/kWh (banker's round → 28.12)
        rate = apply_tiers(800.0, tiers)
        assert round(rate, 2) == 28.12

    def test_all_in_first_tier(self):
        tiers = [
            {"threshold_kwh": 1000, "c_per_kwh": 30.0},
            {"threshold_kwh": 0, "c_per_kwh": 20.0},
        ]
        rate = apply_tiers(300.0, tiers)
        assert rate == 30.0  # All below first threshold

    def test_empty_tiers(self):
        rate = apply_tiers(500.0, [])
        assert rate == 0.0

    def test_usage_exceeds_all_tiers(self):
        tiers = [
            {"threshold_kwh": 500, "c_per_kwh": 30.0},
            {"threshold_kwh": 1000, "c_per_kwh": 28.0},
        ]
        # 500 at 30.0 = 15000
        # 500 at 28.0 = 14000
        # 500 at 28.0 (overflow, last tier rate) = 14000
        # 43000 / 1500 = 28.666...
        rate = apply_tiers(1500.0, tiers)
        assert round(rate, 2) == 28.67


class TestApplyDiscount:
    def test_ten_percent_discount(self):
        assert apply_discount(10000, 10.0) == 9000

    def test_no_discount(self):
        assert apply_discount(10000, 0) == 10000

    def test_zero_discount_for_negative(self):
        assert apply_discount(10000, -5.0) == 10000

    def test_full_discount(self):
        assert apply_discount(10000, 100.0) == 0

    def test_fractional_result(self):
        # 100 cents, 3.5% discount → 96 or 97 cents depending on rounding
        result = apply_discount(100, 3.5)
        assert result in (96, 97)


class TestIsLowUserEligible:
    def test_below_threshold(self):
        assert is_low_user_eligible(7000.0) is True

    def test_at_threshold(self):
        # 8000 is NOT below 8000
        assert is_low_user_eligible(8000.0) is False

    def test_above_threshold(self):
        assert is_low_user_eligible(12000.0) is False

    def test_zero_usage(self):
        assert is_low_user_eligible(0.0) is True


class TestProjectAnnualCost:
    def test_flat_usage_year(self):
        plan = {"c_per_kwh": 25.0, "c_per_day": 90.0, "prompt_payment_discount": 0}
        # 10 kWh/day * 365 days = 3650 kWh
        # Energy: 3650 * 0.25 = 91250 cents
        # Daily: 365 * 0.90 = 32850 cents
        # Total: 124100 cents
        cost = project_annual_cost(10.0, 365, plan)
        assert cost == 124100


class TestIsUnsupportedPlan:
    """AC #125: TOU and missing-field plans must be flagged unsupported."""

    def test_flat_plan_supported(self):
        plan = {"c_per_kwh": 25.0, "c_per_day": 90.0}
        unsupported, reason = is_unsupported_plan(plan)
        assert unsupported is False
        assert reason == ""

    def test_tiered_plan_supported_without_flat_rate(self):
        # Tiers present even without c_per_kwh -> supported
        plan = {"tier_thresholds_json": [{"threshold_kwh": 0, "c_per_kwh": 25.0}]}
        unsupported, _ = is_unsupported_plan(plan)
        assert unsupported is False

    def test_tou_plan_via_is_tou_flag(self):
        plan = {
            "c_per_kwh": 25.0,
            "conditions_json": json.dumps({"is_tou": True}),
        }
        unsupported, reason = is_unsupported_plan(plan)
        assert unsupported is True
        assert "time-of-use" in reason

    def test_tou_plan_via_rate_type(self):
        plan = {
            "c_per_kwh": 25.0,
            "conditions_json": json.dumps({"rate_type": "TOU"}),
        }
        unsupported, reason = is_unsupported_plan(plan)
        assert unsupported is True
        assert "TOU" in reason

    def test_non_tou_rate_type_supported(self):
        # ANYTIME / CONTROLLED / UNCONTROLLED are flat-rate indicators, not TOU
        for rate_type in ("ANYTIME", "CONTROLLED", "UNCONTROLLED"):
            plan = {
                "c_per_kwh": 25.0,
                "conditions_json": json.dumps({"rate_type": rate_type}),
            }
            unsupported, _ = is_unsupported_plan(plan)
            assert unsupported is False, f"{rate_type} should not be unsupported"

    def test_tou_flag_falsy_supported(self):
        plan = {
            "c_per_kwh": 25.0,
            "conditions_json": json.dumps({"is_tou": False}),
        }
        unsupported, _ = is_unsupported_plan(plan)
        assert unsupported is False

    def test_missing_required_fields(self):
        # Neither c_per_kwh nor tier_thresholds_json -> unsupported (mirrors TS
        # isIncompletePlan)
        plan = {"c_per_day": 90.0}
        unsupported, reason = is_unsupported_plan(plan)
        assert unsupported is True
        assert "missing" in reason

    def test_conditions_as_dict_supported(self):
        # conditions_json may already be a parsed dict
        plan = {"c_per_kwh": 25.0, "conditions_json": {"is_tou": False}}
        unsupported, _ = is_unsupported_plan(plan)
        assert unsupported is False

    def test_malformed_conditions_does_not_crash(self):
        plan = {"c_per_kwh": 25.0, "conditions_json": "not-json"}
        unsupported, _ = is_unsupported_plan(plan)
        assert unsupported is False
