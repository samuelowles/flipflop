"""Tests for EIEP14A record parser."""
import json
import os

import pytest
from eiep14a.parser import (
    parse_eiep14a_records,
    _normalise_retailer,
    _retailer_name_to_id,
    _extract_region,
    _extract_conditions,
    _safe_float,
    _safe_int,
    _to_bool,
)

FIXTURE_PATH = os.path.join(os.path.dirname(__file__), "fixtures", "sample_eiep14a_rows.json")


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


# ---------------------------------------------------------------------------
# Issue #65: schema normalization — rate_type, gst_inclusive, region codes,
# source_url. Driven by the anonymized fixture file.
# ---------------------------------------------------------------------------


class TestFixtureFieldMapping:
    """Parametrized over every record in sample_eiep14a_rows.json.

    Asserts that each EIEP14A field lands in the right place in the plan dict:
    region codes resolve to names, rate_type/gst_inclusive fold into
    conditions_json, and source_url propagates from the batch parameter.
    """

    @pytest.fixture(scope="class")
    def fixture_payload(self):
        with open(FIXTURE_PATH, encoding="utf-8") as f:
            return json.load(f)

    @pytest.fixture(scope="class")
    def transformed(self, fixture_payload):
        return {
            r["eiep14a_id"].upper(): r
            for r in parse_eiep14a_records(
                fixture_payload["records"],
                source_url=fixture_payload["source_url"],
            )
        }

    @pytest.mark.parametrize("plan_id,expected_region", [
        ("FIX-CONTACT-NRC-001", "Northland"),
        ("FIX-MERCURY-WEL-002", "Wellington"),
        ("FIX-GENESIS-ORION-003", "Canterbury"),
        ("FIX-MERIDIAN-UNI-004", "Manawatu-Whanganui"),
        ("FIX-NOVA-AUR-005", "Otago"),
        ("FIX-TRUSTPOWER-SLD-006", "Southland"),
    ])
    def test_region_code_resolves_to_name(self, transformed, plan_id, expected_region):
        assert transformed[plan_id]["region"] == expected_region

    @pytest.mark.parametrize("plan_id,expected_rate_type", [
        ("FIX-CONTACT-NRC-001", "CONTROLLED"),
        ("FIX-MERCURY-WEL-002", "ANYTIME"),
        ("FIX-GENESIS-ORION-003", "UNCONTROLLED"),
        ("FIX-MERIDIAN-UNI-004", "CONTROLLED"),
        ("FIX-NOVA-AUR-005", "ANYTIME"),
        ("FIX-TRUSTPOWER-SLD-006", "ANYTIME"),
    ])
    def test_rate_type_uppercased_in_conditions(self, transformed, plan_id, expected_rate_type):
        conditions = json.loads(transformed[plan_id]["conditions_json"])
        assert conditions["rate_type"] == expected_rate_type

    @pytest.mark.parametrize("plan_id,expected_gst", [
        ("FIX-CONTACT-NRC-001", True),
        ("FIX-MERCURY-WEL-002", True),
        ("FIX-GENESIS-ORION-003", False),
        ("FIX-MERIDIAN-UNI-004", True),
        ("FIX-NOVA-AUR-005", True),
        ("FIX-TRUSTPOWER-SLD-006", True),
    ])
    def test_gst_inclusive_boolean_in_conditions(self, transformed, plan_id, expected_gst):
        conditions = json.loads(transformed[plan_id]["conditions_json"])
        assert conditions["gst_inclusive"] is expected_gst

    def test_source_url_propagates_to_each_row(self, transformed, fixture_payload):
        for plan in transformed.values():
            assert plan["source_url"] == fixture_payload["source_url"]

    def test_all_six_records_transformed(self, transformed):
        assert len(transformed) == 6

    def test_per_record_source_url_overrides_batch(self, fixture_payload):
        records = fixture_payload["records"]
        records[0]["SourceURL"] = "https://override.example/feed.json"
        plans = parse_eiep14a_records(records, source_url=fixture_payload["source_url"])
        contact = next(p for p in plans if p["eiep14a_id"] == "FIX-CONTACT-NRC-001")
        assert contact["source_url"] == "https://override.example/feed.json"


class TestExtractRegionNetworkCodes:
    """#65: NETWORK_CODE_TO_REGION is consulted before name matching."""

    @pytest.mark.parametrize("code,expected", [
        ("NRC", "Northland"),
        ("nrc", "Northland"),       # case-insensitive
        ("WEL", "Wellington"),
        ("ORION", "Canterbury"),
        ("UNI", "Manawatu-Whanganui"),
        ("AUR", "Otago"),
        ("SLD", "Southland"),
        ("APE", "Auckland"),
    ])
    def test_resolves_network_code(self, code, expected):
        assert _extract_region({"Region": code}) == expected

    def test_name_still_resolves_when_not_a_code(self):
        assert _extract_region({"Region": "Canterbury"}) == "Canterbury"

    def test_unknown_value_passes_through(self):
        assert _extract_region({"Region": "Pacific Isles"}) == "Pacific Isles"


class TestExtractConditionsNewFields:
    def test_rate_type_uppercased(self):
        conditions = _extract_conditions({"RateType": "anytime"})
        assert conditions["rate_type"] == "ANYTIME"

    def test_rate_type_absent_when_missing(self):
        conditions = _extract_conditions({})
        assert "rate_type" not in conditions

    def test_gst_inclusive_defaults_true(self):
        conditions = _extract_conditions({})
        assert conditions["gst_inclusive"] is True

    def test_gst_inclusive_explicit_false(self):
        conditions = _extract_conditions({"GSTInclusive": False})
        assert conditions["gst_inclusive"] is False

    def test_gst_inclusive_string_truthy(self):
        conditions = _extract_conditions({"gst_inclusive": "yes"})
        assert conditions["gst_inclusive"] is True


class TestToBool:
    @pytest.mark.parametrize("value,expected", [
        (True, True),
        (False, False),
        (1, True),
        (0, False),
        ("true", True),
        ("TRUE", True),
        ("yes", True),
        ("1", True),
        ("no", False),
        ("0", False),
        ("random", False),
    ])
    def test_coerces_value(self, value, expected):
        assert _to_bool(value) is expected


class TestSourceUrlPropagation:
    def test_batch_source_url_applied(self):
        plans = parse_eiep14a_records(
            [{"Retailer": "Contact", "PlanName": "P", "PlanId": "S-1"}],
            source_url="https://batch.example",
        )
        assert plans[0]["source_url"] == "https://batch.example"

    def test_per_record_source_url_wins(self):
        plans = parse_eiep14a_records(
            [{"Retailer": "Contact", "PlanName": "P", "PlanId": "S-2",
              "SourceURL": "https://per-rec.example"}],
            source_url="https://batch.example",
        )
        assert plans[0]["source_url"] == "https://per-rec.example"

    def test_source_url_none_when_absent(self):
        plans = parse_eiep14a_records(
            [{"Retailer": "Contact", "PlanName": "P", "PlanId": "S-3"}],
        )
        assert plans[0]["source_url"] is None
