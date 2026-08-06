"""Tests for base parser validation utilities."""
import json

import pytest
from parsers.base import (
    validate_nz_mobile,
    validate_icp_number,
    validate_kwh_range,
    validate_cents_range,
    validate_c_per_kwh,
    validate_c_per_day,
    sanitize_date,
    ParserResult,
    parser_for_retailer,
    register_parser,
    BaseParser,
)


class TestValidateNZMobile:
    def test_accepts_valid_mobile_64_prefix(self):
        assert validate_nz_mobile("+64211234567") is True

    def test_accepts_valid_mobile_0_prefix(self):
        assert validate_nz_mobile("0211234567") is True

    def test_accepts_mobile_with_spaces(self):
        assert validate_nz_mobile("+64 21 123 4567") is True

    def test_accepts_mobile_with_hyphens(self):
        assert validate_nz_mobile("021-123-4567") is True

    def test_rejects_foreign_number(self):
        assert validate_nz_mobile("+61412345678") is False

    def test_rejects_landline(self):
        assert validate_nz_mobile("+64 9 123 4567") is False

    def test_rejects_empty_string(self):
        assert validate_nz_mobile("") is False

    def test_rejects_short_number(self):
        assert validate_nz_mobile("021") is False

    def test_rejects_missing_mobile_prefix(self):
        """Numbers not starting with +64 or 0 should be rejected."""
        assert validate_nz_mobile("211234567") is False

    def test_rejects_non_nz_mobile_with_64_prefix(self):
        """+64 prefix but not mobile (second digit not 2)."""
        assert validate_nz_mobile("+6431234567") is False


class TestValidateICPNumber:
    def test_accepts_valid_icp(self):
        assert validate_icp_number("1234567890ABCDE") is True

    def test_accepts_lowercase_icp(self):
        assert validate_icp_number("1234567890abcde") is True

    def test_rejects_short_icp(self):
        assert validate_icp_number("12345") is False

    def test_rejects_long_icp(self):
        assert validate_icp_number("1234567890ABCDEF") is False

    def test_rejects_empty(self):
        assert validate_icp_number("") is False

    def test_rejects_icp_with_special_chars(self):
        assert validate_icp_number("1234567890ABC-E") is False

    def test_rejects_whitespace_only(self):
        assert validate_icp_number("   ") is False

    def test_accepts_icp_with_whitespace(self):
        """ICP is stripped before validation."""
        assert validate_icp_number("  1234567890ABCDE  ") is True


class TestValidateKWhRange:
    def test_accepts_normal_usage(self):
        assert validate_kwh_range(500.0) is True

    def test_accepts_zero(self):
        assert validate_kwh_range(0.0) is True

    def test_accepts_high_usage(self):
        assert validate_kwh_range(5000.0) is True

    def test_accepts_max_boundary(self):
        assert validate_kwh_range(100_000.0) is True

    def test_rejects_negative(self):
        assert validate_kwh_range(-100.0) is False

    def test_rejects_excessive(self):
        assert validate_kwh_range(200_000.0) is False

    def test_rejects_just_above_max(self):
        assert validate_kwh_range(100_000.01) is False


class TestValidateCentsRange:
    def test_accepts_normal_bill(self):
        assert validate_cents_range(20000) is True  # $200

    def test_accepts_zero(self):
        assert validate_cents_range(0) is True

    def test_accepts_max_boundary(self):
        assert validate_cents_range(10_000_000) is True  # $100,000

    def test_rejects_negative(self):
        assert validate_cents_range(-100) is False

    def test_rejects_excessive(self):
        assert validate_cents_range(20_000_000) is False


class TestValidateCPerKWh:
    def test_accepts_normal_rate(self):
        assert validate_c_per_kwh(25.5) is True

    def test_accepts_low_boundary(self):
        assert validate_c_per_kwh(10.0) is True

    def test_accepts_high_boundary(self):
        assert validate_c_per_kwh(60.0) is True

    def test_rejects_too_low(self):
        assert validate_c_per_kwh(5.0) is False

    def test_rejects_too_high(self):
        assert validate_c_per_kwh(100.0) is False


class TestValidateCPerDay:
    def test_accepts_normal_daily_charge(self):
        assert validate_c_per_day(90.0) is True

    def test_accepts_zero_daily_charge(self):
        assert validate_c_per_day(0.0) is True

    def test_accepts_high_boundary(self):
        assert validate_c_per_day(500.0) is True

    def test_rejects_excessive_daily_charge(self):
        assert validate_c_per_day(1000.0) is False

    def test_rejects_negative_daily_charge(self):
        assert validate_c_per_day(-10.0) is False


class TestSanitizeDate:
    def test_parses_iso8601(self):
        assert sanitize_date("2026-05-14") == "2026-05-14"

    def test_parses_dmy_with_slashes(self):
        result = sanitize_date("14/05/2026")
        assert result == "2026-05-14"

    def test_parses_dmy_with_hyphens(self):
        result = sanitize_date("14-05-2026")
        assert result == "2026-05-14"

    def test_parses_month_abbreviation(self):
        result = sanitize_date("14 May 2026")
        assert result == "2026-05-14"

    def test_parses_full_month_name(self):
        result = sanitize_date("14 May 2026")
        assert result == "2026-05-14"

    def test_parses_us_date_format(self):
        result = sanitize_date("May 14, 2026")
        assert result == "2026-05-14"

    def test_parses_compact_format(self):
        result = sanitize_date("20260514")
        assert result == "2026-05-14"

    def test_raises_on_unparseable(self):
        with pytest.raises(ValueError):
            sanitize_date("not a date")

    def test_raises_on_empty_string(self):
        with pytest.raises(ValueError):
            sanitize_date("")

    def test_strips_whitespace(self):
        result = sanitize_date("  2026-05-14  ")
        assert result == "2026-05-14"

    def test_raises_on_datetime_with_time(self):
        """Parser only handles date formats, not datetime strings with time."""
        with pytest.raises(ValueError):
            sanitize_date("2026-05-14 09:30:00")


class TestParserResult:
    def test_creates_valid_parser_result(self):
        result = ParserResult(
            retailer="Test Energy",
            plan_name="Basic Plan",
            meter_type="standard",
            icp_number="1234567890ABCDE",
            period_start="2026-04-14T00:00:00",
            period_end="2026-05-14T00:00:00",
            days=30,
            usage_kwh=500.0,
            total_cents=15200,
            c_per_kwh=25.0,
            c_per_day=90.0,
            fixed_term_expiry=None,
            break_fee_cents=0,
            confidence=0.95,
            raw_json='{"test": true}',
        )
        assert result.retailer == "Test Energy"
        assert result.total_cents == 15200
        assert result.days == 30
        assert result.plan_name == "Basic Plan"
        assert result.meter_type == "standard"
        assert result.icp_number == "1234567890ABCDE"
        assert result.period_start == "2026-04-14T00:00:00"
        assert result.period_end == "2026-05-14T00:00:00"
        assert result.usage_kwh == 500.0
        assert result.c_per_kwh == 25.0
        assert result.c_per_day == 90.0
        assert result.fixed_term_expiry is None
        assert result.break_fee_cents == 0
        assert result.confidence == 0.95

    def test_allows_fixed_term_expiry(self):
        result = ParserResult(
            retailer="Test Energy",
            plan_name="Fixed Plan",
            meter_type="standard",
            icp_number="1234567890ABCDE",
            period_start="2026-04-14T00:00:00",
            period_end="2026-05-14T00:00:00",
            days=30,
            usage_kwh=500.0,
            total_cents=15200,
            c_per_kwh=25.0,
            c_per_day=90.0,
            fixed_term_expiry="2027-04-14T00:00:00",
            break_fee_cents=15000,
            confidence=0.95,
            raw_json="{}",
        )
        assert result.fixed_term_expiry == "2027-04-14T00:00:00"
        assert result.break_fee_cents == 15000

    def test_to_json_produces_valid_json(self):
        result = ParserResult(
            retailer="Test",
            plan_name="Plan",
            meter_type="standard",
            icp_number="1234567890ABCDE",
            period_start="2026-04-14T00:00:00",
            period_end="2026-05-14T00:00:00",
            days=30,
            usage_kwh=500.0,
            total_cents=15200,
            c_per_kwh=25.0,
            c_per_day=90.0,
            fixed_term_expiry=None,
            break_fee_cents=0,
            confidence=0.95,
            raw_json='{"internal": true}',
        )
        json_str = result.to_json()
        # Should be valid JSON
        parsed = json.loads(json_str)
        assert parsed["retailer"] == "Test"
        assert parsed["total_cents"] == 15200
        assert parsed["days"] == 30
        # raw_json is included as a field
        assert "raw_json" in parsed

    def test_valid_meter_types_accepted(self):
        """All valid meter types should work."""
        for meter_type in ("standard", "low_user", "day_night", "controlled"):
            result = ParserResult(
                retailer="Test Energy",
                plan_name="Plan",
                meter_type=meter_type,
                icp_number="1234567890ABCDE",
                period_start="2026-04-14T00:00:00",
                period_end="2026-05-14T00:00:00",
                days=30,
                usage_kwh=500.0,
                total_cents=15200,
                c_per_kwh=25.0,
                c_per_day=90.0,
                fixed_term_expiry=None,
                break_fee_cents=0,
                confidence=0.95,
                raw_json="{}",
            )
            assert result.meter_type == meter_type

    def test_high_usage_scenario(self):
        """Large household usage should be stored correctly."""
        result = ParserResult(
            retailer="Contact Energy",
            plan_name="Standard",
            meter_type="standard",
            icp_number="0001234567ABC00",
            period_start="2026-02-01T00:00:00",
            period_end="2026-03-01T00:00:00",
            days=28,
            usage_kwh=1200.0,
            total_cents=36000,  # $360
            c_per_kwh=25.0,
            c_per_day=90.0,
            fixed_term_expiry=None,
            break_fee_cents=0,
            confidence=0.98,
            raw_json="{}",
        )
        assert result.usage_kwh == 1200.0
        assert result.total_cents == 36000

    def test_low_user_scenario(self):
        """Low user plan should store correct meter type and rates."""
        result = ParserResult(
            retailer="Genesis Energy",
            plan_name="Low User",
            meter_type="low_user",
            icp_number="0001234567DEF99",
            period_start="2026-03-01T00:00:00",
            period_end="2026-03-31T00:00:00",
            days=30,
            usage_kwh=200.0,
            total_cents=8500,  # $85
            c_per_kwh=30.0,
            c_per_day=33.33,
            fixed_term_expiry=None,
            break_fee_cents=0,
            confidence=0.97,
            raw_json="{}",
        )
        assert result.meter_type == "low_user"
        assert result.c_per_day == 33.33


class TestParserForRetailer:
    def test_returns_none_for_unknown_retailer(self):
        result = parser_for_retailer("unknown_retailer")
        assert result is None

    def test_case_insensitive_lookup(self):
        # Register a test parser
        class TestParser(BaseParser):
            def parse(self, file_path: str):
                raise NotImplementedError

        register_parser("testco", TestParser)

        result = parser_for_retailer("TESTCO")
        assert result is not None
        assert isinstance(result, TestParser)

    def test_returns_instance_not_class(self):
        class InstanceParser(BaseParser):
            def parse(self, file_path: str):
                raise NotImplementedError

        register_parser("instancetest", InstanceParser)

        result1 = parser_for_retailer("instancetest")
        result2 = parser_for_retailer("instancetest")
        # Each call returns a new instance
        assert result1 is not None
        assert result2 is not None
        assert result1 is not result2


# ---------------------------------------------------------------------------
# Reconciliation gate (the correctness signal)
# ---------------------------------------------------------------------------
#
# `confidence` counts how many fields were FOUND, not whether they are RIGHT.
# A real Mercury bill scored 0.818 while its rate, daily charge and total were
# all wrong. These cover the check that closes that gap.

from parsers.base import (  # noqa: E402
    RECONCILE_FAIL_CONFIDENCE,
    RECONCILE_TOLERANCE,
    reconcile_total,
)


def _result(**overrides):
    """A self-consistent ParserResult: 500 kWh x 25c + 30 x 90c = $152.00."""
    kwargs = dict(
        retailer="Test", plan_name="P", meter_type="standard",
        icp_number="1234567890ABCDE", period_start="2026-04-01",
        period_end="2026-04-30", days=30, usage_kwh=500.0, total_cents=15200,
        c_per_kwh=25.0, c_per_day=90.0, fixed_term_expiry=None,
        break_fee_cents=0, confidence=0.95, raw_json="{}",
    )
    kwargs.update(overrides)
    return ParserResult(**kwargs)


class TestReconcileTotal:
    def test_none_when_bill_states_too_little(self):
        assert reconcile_total(None, 25.0, 30, 90.0, 15200) is None
        assert reconcile_total(500.0, 0, 30, 90.0, 15200) is None

    def test_zero_total_never_reconciles(self):
        # The real Mercury failure: line items present, total extracted as 0.
        assert reconcile_total(1113.88, 22.49, 32, 291.0, 0) == 1.0

    def test_gst_exclusive_rates_reconcile(self):
        # Items x 1.15 == total.
        assert reconcile_total(500.0, 25.0, 30, 90.0, round(15200 * 1.15)) < 0.01

    def test_gst_inclusive_rates_reconcile(self):
        assert reconcile_total(500.0, 25.0, 30, 90.0, 15200) < 0.01

    def test_real_mercury_correct_values_reconcile(self):
        assert reconcile_total(1113.88, 22.49, 32, 291.0, 39518) < 0.01

    def test_real_mercury_broken_values_are_caught(self):
        # The values the parser actually emitted before the fix.
        delta = reconcile_total(1113.88, 329.07, 32, 32.0, 39518)
        assert delta > RECONCILE_TOLERANCE

    def test_peak_only_rate_on_a_tou_bill_is_caught(self):
        # Electric Kiwi: peak 56.71 instead of the blended 43.71.
        assert reconcile_total(298.49, 56.71, 9, 110.0, 14036) > RECONCILE_TOLERANCE
        assert reconcile_total(298.49, 43.71, 9, 110.0, 14036) < 0.01


class TestReconciliationGate:
    def test_consistent_bill_keeps_its_confidence(self):
        r = _result()
        assert r.confidence == 0.95
        assert r.reconciliation_delta < RECONCILE_TOLERANCE

    def test_inconsistent_bill_is_capped_below_auto_accept(self):
        # Stated total is half what the line items produce.
        r = _result(total_cents=7600)
        assert r.confidence == RECONCILE_FAIL_CONFIDENCE
        assert r.confidence < 0.85, "must route to needs_review"

    def test_gate_never_raises_confidence(self):
        r = _result(confidence=0.2)
        assert r.confidence == 0.2

    def test_unverifiable_bill_is_left_alone(self):
        # Nothing to check against — must not be punished for it.
        r = _result(c_per_kwh=0.0, confidence=0.9)
        assert r.reconciliation_delta is None
        assert r.confidence == 0.9
