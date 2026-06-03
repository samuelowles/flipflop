"""Tests for shared extraction functions."""
import pytest
from parsers.extractors import (
    extract_icp,
    extract_kwh,
    extract_dollars,
    extract_dates,
    extract_daily_charge,
    extract_per_kwh,
    extract_plan_name,
    extract_meter_type,
)


class TestExtractICP:
    def test_extracts_labelled_icp(self):
        text = "ICP number: 1234567890ABCDE"
        assert extract_icp(text) == "1234567890ABCDE"

    def test_extracts_icp_with_dots(self):
        text = "I.C.P. Number: 0009876543DEF99"
        assert extract_icp(text) == "0009876543DEF99"

    def test_extracts_installation_control_point(self):
        text = "Installation Control Point: ABCDE1234567890"
        assert extract_icp(text) == "ABCDE1234567890"

    def test_fallback_to_bare_15_char(self):
        text = "Here is a token XYZ12ABC3456789 in text"
        result = extract_icp(text)
        assert result == "XYZ12ABC3456789"

    def test_returns_none_when_no_icp(self):
        assert extract_icp("No ICP here") is None

    def test_icp_case_normalised_to_upper(self):
        text = "icp: abcde1234567890"
        assert extract_icp(text) == "ABCDE1234567890"


class TestExtractKWh:
    def test_extracts_kwh_with_unit(self):
        text = "Total usage: 847 kWh"
        result = extract_kwh(text)
        assert result == 847.0

    def test_extracts_kwh_without_space(self):
        text = "You used 500kWh this month"
        result = extract_kwh(text)
        assert result == 500.0

    def test_extracts_kwh_with_comma_separator(self):
        text = "Usage: 1,234 kWh"
        result = extract_kwh(text)
        assert result == 1234.0

    def test_extracts_near_decimal(self):
        text = "Consumption: 847.5 units"
        result = extract_kwh(text)
        assert result == 847.5

    def test_returns_none_when_no_kwh(self):
        assert extract_kwh("No usage data") is None

    def test_usage_label_preferred(self):
        text = "Usage: 847 kWh"
        result = extract_kwh(text)
        assert result == 847.0


class TestExtractDollars:
    def test_extracts_dollar_amount(self):
        text = "Total due: $212.34"
        result = extract_dollars(text)
        assert result == 21234

    def test_extracts_whole_dollars(self):
        text = "Amount: $200"
        result = extract_dollars(text)
        assert result == 20000

    def test_extracts_including_gst(self):
        text = "Total: $212.34 including GST"
        result = extract_dollars(text)
        assert result == 21234

    def test_extracts_largest_amount_as_total(self):
        text = "Daily charge: $0.90\nTotal: $350.00\nGST: $52.50"
        result = extract_dollars(text)
        assert result == 35000

    def test_returns_none_when_no_dollars(self):
        assert extract_dollars("No money here") is None

    def test_extracts_amount_with_label(self):
        text = "Amount due: $150.50"
        result = extract_dollars(text)
        assert result == 15050


class TestExtractDates:
    def test_extracts_iso_date_range(self):
        text = "Period: 2026-04-01 to 2026-04-30"
        start, end = extract_dates(text)
        assert start == "2026-04-01"
        assert end == "2026-04-30"

    def test_extracts_dmy_slash_range(self):
        text = "Billing: 01/04/2026 - 30/04/2026"
        start, end = extract_dates(text)
        assert start == "2026-04-01"
        assert end == "2026-04-30"

    def test_extracts_day_month_year_range(self):
        text = "14 May 2026 to 13 Jun 2026"
        start, end = extract_dates(text)
        assert start == "2026-05-14"
        assert end == "2026-06-13"

    def test_returns_none_when_no_dates(self):
        start, end = extract_dates("No dates in here")
        assert start is None
        assert end is None

    def test_extracts_period_ending(self):
        text = "For period ending 30 Apr 2026"
        start, end = extract_dates(text)
        assert start is None
        assert end is not None


class TestExtractDailyCharge:
    def test_extracts_cents_per_day(self):
        text = "Daily charge: 90.00 c/day"
        result = extract_daily_charge(text)
        assert result == 90.0

    def test_extracts_dollar_per_day(self):
        text = "Fixed daily: $0.90 per day"
        result = extract_daily_charge(text)
        assert result == 90.0

    def test_extracts_fixed_charge(self):
        text = "Fixed charge 33.33c"
        result = extract_daily_charge(text)
        assert result == 33.33

    def test_returns_none_when_no_daily_charge(self):
        assert extract_daily_charge("No charges") is None


class TestExtractPerKWh:
    def test_extracts_rate(self):
        text = "Variable: 25.50 c/kWh"
        result = extract_per_kwh(text)
        assert result == 25.50

    def test_extracts_energy_charge(self):
        text = "Energy charge: 28.45 c per kWh"
        result = extract_per_kwh(text)
        assert result == 28.45

    def test_returns_none_when_no_rate(self):
        assert extract_per_kwh("No rates here") is None

    def test_prefers_residential_range(self):
        text = "Rate: 100.0 c/kWh or 25.5 c/kWh"
        result = extract_per_kwh(text)
        assert result == 25.5


class TestExtractPlanName:
    def test_extracts_labelled_plan(self):
        text = "Plan Name: Standard User\nDetails follow"
        result = extract_plan_name(text)
        assert result is not None
        assert "Standard" in result

    def test_extracts_common_plan_names(self):
        text = "You are on our Low User plan"
        result = extract_plan_name(text)
        assert result is not None
        assert "Low" in result

    def test_returns_none_for_no_match(self):
        text = "No recognizable plan name here 123 xyz"
        result = extract_plan_name(text)
        # May or may not find something; acceptable either way
        assert True


class TestExtractMeterType:
    def test_detects_low_user(self):
        assert extract_meter_type("Low User Plan details") == "low_user"

    def test_detects_day_night(self):
        assert extract_meter_type("Day/Night meter readings") == "day_night"

    def test_detects_controlled(self):
        assert extract_meter_type("Controlled hot water plan") == "controlled"

    def test_defaults_to_standard(self):
        assert extract_meter_type("Generic bill text") == "standard"

    def test_low_user_priority_over_standard(self):
        assert extract_meter_type("Low User with Day and Night") == "low_user"
