"""Tests for EIEP14A record parser."""
import json

import pytest
from eiep14a.parser import (
    parse_eiep14a_records,
    _normalise_retailer,
    _retailer_name_to_id,
    _extract_region,
    _safe_float,
    _safe_int,
)


class TestParseEIEP14ARecords:
    def test_transforms_single_record(self):
        raw = [{
            "Retailer": "Contact Energy",
            "PlanName": "Standard User",
            "Region": "Auckland",
            "VariableRate": 25.50,
            "DailyCharge": 90.00,
            "PromptPaymentDiscount": 10.0,
            "PlanId": "CONTACT-STD-001",
        }]

        plans = parse_eiep14a_records(raw)

        assert len(plans) == 1
        plan = plans[0]
        assert plan["retailer_id"] == "contact"
        assert plan["name"] == "Standard User"
        assert plan["region"] == "Auckland"
        assert plan["c_per_kwh"] == 25.50
        assert plan["c_per_day"] == 90.00
        assert plan["prompt_payment_discount"] == 10.0
        assert plan["source"] == "eiep14a"
        assert plan["eiep14a_id"] == "CONTACT-STD-001"
        assert plan["id"] != ""

    def test_normalises_retailer_names(self):
        raw = [{
            "Retailer": "mercury",
            "PlanName": "Online",
            "PlanId": "MERC-001",
        }]

        plans = parse_eiep14a_records(raw)
        assert plans[0]["retailer_id"] == "mercury"

    def test_deduplicates_by_eiep14a_id(self):
        raw = [
            {"Retailer": "Contact", "PlanName": "A", "PlanId": "same-id"},
            {"Retailer": "Contact", "PlanName": "B", "PlanId": "same-id"},
        ]

        plans = parse_eiep14a_records(raw)
        assert len(plans) == 1

    def test_handles_tiered_pricing(self):
        raw = [{
            "Retailer": "Mercury",
            "PlanName": "Tiered Plan",
            "PlanId": "TIER-001",
            "Tiers": [
                {"Threshold": 500, "Rate": 30.0},
                {"Threshold": 0, "Rate": 25.0},
            ],
        }]

        plans = parse_eiep14a_records(raw)
        tiers = json.loads(plans[0]["tier_thresholds_json"])
        assert len(tiers) == 2

    def test_handles_conditions(self):
        raw = [{
            "Retailer": "Genesis",
            "PlanName": "Fixed Term",
            "PlanId": "FIXED-001",
            "FixedTermMonths": 12,
            "PaymentType": "direct_debit",
            "ExitFee": 15000,
        }]

        plans = parse_eiep14a_records(raw)
        conditions = json.loads(plans[0]["conditions_json"])
        assert conditions["fixed_term_months"] == 12
        assert conditions["payment_type"] == "direct_debit"
        assert conditions["exit_fee_cents"] == 15000

    def test_empty_input(self):
        plans = parse_eiep14a_records([])
        assert plans == []

    def test_skips_invalid_records(self, caplog):
        """Records that cause errors should be skipped with a warning."""
        raw = [
            {"Retailer": "Valid", "PlanName": "Good", "PlanId": "good-1"},
            None,  # This will cause an AttributeError when processed
        ]
        plans = parse_eiep14a_records([r for r in raw if r is not None])
        assert len(plans) == 1
        assert plans[0]["name"] == "Good"

    def test_handles_lowercase_keys(self):
        raw = [{
            "retailer": "Contact Energy",
            "plan_name": "Standard",
            "c_per_kwh": 28.0,
            "c_per_day": 33.33,
            "plan_id": "LOWER-001",
        }]

        plans = parse_eiep14a_records(raw)
        assert len(plans) == 1
        assert plans[0]["c_per_kwh"] == 28.0


class TestNormaliseRetailer:
    def test_normalises_known_name(self):
        assert _normalise_retailer("contact") == "Contact Energy"

    def test_normalises_genesis(self):
        assert _normalise_retailer("genesis energy") == "Genesis Energy"

    def test_passes_through_unknown(self):
        assert _normalise_retailer("SomeNewRetailer") == "SomeNewRetailer"


class TestRetailerNameToID:
    def test_converts_contact(self):
        assert _retailer_name_to_id("Contact Energy") == "contact"

    def test_converts_mercury(self):
        assert _retailer_name_to_id("Mercury") == "mercury"

    def test_slugifies_unknown(self):
        result = _retailer_name_to_id("Some New Retailer Ltd")
        assert result == "some_new_retailer_ltd"


class TestExtractRegion:
    def test_extracts_known_region(self):
        assert _extract_region({"Region": "Auckland"}) == "Auckland"

    def test_extracts_from_lowercase(self):
        assert _extract_region({"region": "canterbury"}) == "Canterbury"

    def test_defaults_to_input_for_unknown(self):
        assert _extract_region({"Region": "South Pacific"}) == "South Pacific"

    def test_defaults_to_national_for_empty(self):
        assert _extract_region({}) == "National"


class TestSafeConverters:
    def test_safe_float_returns_float(self):
        assert _safe_float("25.5") == 25.5

    def test_safe_float_defaults_zero(self):
        assert _safe_float(None) == 0.0
        assert _safe_float("abc") == 0.0

    def test_safe_int_returns_int(self):
        assert _safe_int("42") == 42

    def test_safe_int_defaults_zero(self):
        assert _safe_int(None) == 0
        assert _safe_int("abc") == 0
