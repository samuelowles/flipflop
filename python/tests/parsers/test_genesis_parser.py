"""Tests for Genesis Energy bill parser.

Covers the canonical Genesis Energy layout, the legacy Energy Online
variant (Genesis acquired Energy Online - older bills carry that
branding), low-user bills, layout variations, and an edge case with
missing fields. All sample data is synthetic/anonymized.
"""
from unittest.mock import patch, MagicMock

import pytest
from parsers.base import parser_for_retailer
from parsers.genesis_parser import GenesisParser


@pytest.fixture
def parser():
    return GenesisParser()


def _mock_pdf(text):
    """Build a pdfplumber.open MagicMock yielding *text*."""
    mock_page = MagicMock()
    mock_page.extract_text.return_value = text
    mock_pdf = MagicMock()
    mock_pdf.pages = [mock_page]
    mock_pdf.__enter__.return_value = mock_pdf
    mock_pdf.__exit__.return_value = None
    return mock_pdf


# ---------------------------------------------------------------------------
# Sample bill fixtures (anonymized, synthetic data)
# ---------------------------------------------------------------------------

# 1. Canonical current Genesis Energy residential bill (standard meter).
SAMPLE_BILL_CANONICAL = """
Genesis Energy

Your Energy bill

Account: 8842001-7
Customer: A. Ratepayer
ICP Number: 0005555666GST77
Supply at: 789 Rural Road, Waikato

Genesis Everyday Plan

Period: 01/04/2026 - 30/04/2026

Your electricity:
Consumption: 320 kWh

Charges:
Daily Fixed Charge: 30 days @ 33.33 c/day = $10.00
Energy Charge: 320 kWh @ 28.45 c/kWh = $91.04

Total: $101.04
GST: $13.18
"""

# 2. Legacy Energy Online variant (pre-acquisition branding, no Genesis
# prefix; different label phrasing for the variable rate).
SAMPLE_BILL_ENERGY_ONLINE = """
Energy Online

Electricity Account

Customer: J. Consumer
ICP: 0000111222333AB
Supply Address: 12 Kokiri Street, Hataitai, Wellington 6021

Energy Online Plan

Billing period: 14 May 2026 to 13 Jun 2026

Electricity used: 612 kWh

Charges
Daily charge 31 days @ 152.00 c/day = $228.00
Variable usage 612 kWh @ 28.500 cents per kWh = $174.42

Total amount due: $402.42
Includes GST of $52.40
"""

# 3. Low-user bill (explicit Low User plan, small daily charge).
SAMPLE_BILL_LOW_USER = """
Genesis Energy

Your Energy bill

Account: 5544332-8
Customer: K. Watts
ICP: 0000998877665XY
Supply at: 3 Pohutukawa Drive, Mission Bay, Auckland 1071

Genesis Saver Plan (Low User)

Period: 14 Mar 2026 - 13 Apr 2026

Your electricity:
Usage: 180 kWh

Charges:
Daily Fixed Charge: 31 days @ 90.00 c/day = $27.90
Energy Charge: 180 kWh @ 26.30 c/kWh = $47.34

Total: $75.24
GST: $9.81
"""

# 4. Layout variation: ISO dates and "Energy Charge N.NNN cents per kWh"
# phrasing, Classic plan.
SAMPLE_BILL_LAYOUT_VARIATION = """
Genesis Energy Limited

Account 1122334-5
B. Bright
200 Ridge Road, Howick, Auckland 2010
ICP Number: 0000789012345LM

Genesis Classic Plan

Period: 2026-02-14 to 2026-03-13

Your usage
Total units: 425 kWh

Your charges
Daily charge 28 days @ 200.000 c/day = $280.00
Energy Charge 30.100 cents per kWh

Total charges: $407.93
GST $53.12
"""

# 5. Edge / missing-field case: a bare bill with a total and a plan name but
# no ICP, dates, or rates. Must parse without raising but with low confidence.
SAMPLE_BILL_MISSING_FIELDS = "Genesis Energy bill\nGenesis Saver Plan\nTotal: $65.00\n"


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestGenesisParser:
    def test_parser_registered(self):
        p = parser_for_retailer("genesis")
        assert p is not None
        assert isinstance(p, GenesisParser)

    def test_retailer_name(self, parser):
        assert parser.RETAILER_NAME == "Genesis Energy"
        assert parser.RETAILER_ID == "genesis"

    @patch("pdfplumber.open")
    def test_canonical_bill_full_schema_and_confidence(self, mock_open, parser):
        """Canonical Genesis bill: all ParserResult fields, confidence >=0.9."""
        mock_open.return_value = _mock_pdf(SAMPLE_BILL_CANONICAL)

        result = parser.parse("genesis_canonical.pdf")

        assert result.retailer == "Genesis Energy"
        assert result.icp_number == "0005555666GST77"
        assert result.usage_kwh == 320.0
        assert result.total_cents == 10104
        assert result.period_start == "2026-04-01"
        assert result.period_end == "2026-04-30"
        assert result.days == 30
        assert result.c_per_kwh == 28.45
        assert result.c_per_day == 33.33
        assert "Everyday" in result.plan_name
        assert result.confidence >= 0.9

    @patch("pdfplumber.open")
    def test_energy_online_legacy_variant(self, mock_open, parser):
        """Legacy Energy Online branding must parse and reach confidence >=0.9."""
        mock_open.return_value = _mock_pdf(SAMPLE_BILL_ENERGY_ONLINE)

        result = parser.parse("energy_online_legacy.pdf")

        assert result.retailer == "Genesis Energy"
        assert result.icp_number == "0000111222333AB"
        assert result.usage_kwh == 612.0
        assert result.total_cents == 40242
        assert result.period_start == "2026-05-14"
        assert result.period_end == "2026-06-13"
        assert result.days == 31
        assert result.c_per_kwh == 28.50
        assert result.c_per_day == 152.0
        assert "Energy Online" in result.plan_name
        assert result.confidence >= 0.9

    @patch("pdfplumber.open")
    def test_low_user_bill(self, mock_open, parser):
        """Low-user bill: meter_type=low_user, confidence >=0.9."""
        mock_open.return_value = _mock_pdf(SAMPLE_BILL_LOW_USER)

        result = parser.parse("genesis_low_user.pdf")

        assert result.icp_number == "0000998877665XY"
        assert result.usage_kwh == 180.0
        assert result.total_cents == 7524
        assert result.period_start == "2026-03-14"
        assert result.period_end == "2026-04-13"
        assert result.days == 31
        assert result.c_per_kwh == 26.30
        assert result.c_per_day == 90.0
        assert result.meter_type == "low_user"
        assert "Saver" in result.plan_name
        assert result.confidence >= 0.9

    @patch("pdfplumber.open")
    def test_layout_variation_iso_dates_and_rate_phrasing(self, mock_open, parser):
        """Layout variation: ISO dates, cents-per-kWh phrasing, Classic plan."""
        mock_open.return_value = _mock_pdf(SAMPLE_BILL_LAYOUT_VARIATION)

        result = parser.parse("genesis_layout_variation.pdf")

        assert result.icp_number == "0000789012345LM"
        assert result.usage_kwh == 425.0
        assert result.period_start == "2026-02-14"
        assert result.period_end == "2026-03-13"
        assert result.c_per_kwh == 30.10
        assert result.c_per_day == 200.0
        assert "Classic" in result.plan_name
        assert result.confidence >= 0.9

    @patch("pdfplumber.open")
    def test_missing_fields_low_confidence(self, mock_open, parser):
        """Bare bill with no ICP/dates/rates parses but yields low confidence."""
        mock_open.return_value = _mock_pdf(SAMPLE_BILL_MISSING_FIELDS)

        result = parser.parse("genesis_missing_fields.pdf")

        assert result.retailer == "Genesis Energy"
        assert result.total_cents == 6500
        assert result.usage_kwh == 0.0
        assert result.icp_number == ""
        assert result.confidence < 0.5

    @patch("pdfplumber.open")
    def test_raises_on_empty_pdf(self, mock_open, parser):
        mock_open.return_value = _mock_pdf("")

        with pytest.raises(ValueError, match="No extractable text"):
            parser.parse("empty.pdf")

    @patch("pdfplumber.open")
    def test_genesis_plan_name_extraction(self, mock_open, parser):
        text = "Genesis Energy Saver Plan\nTotal: $95.00"
        mock_open.return_value = _mock_pdf(text)

        result = parser.parse("plan.pdf")
        assert "Saver" in result.plan_name

    @patch("pdfplumber.open")
    def test_genesis_energy_charge_pattern(self, mock_open, parser):
        """Genesis-specific Energy Charge N.NNN cents per kWh extraction."""
        text = """
Genesis Energy
Energy Charge 26.500 cents per kWh
Total: $80.00
"""
        mock_open.return_value = _mock_pdf(text)

        result = parser.parse("genesis_energy.pdf")
        assert result.c_per_kwh == 26.50

    @patch("pdfplumber.open")
    def test_break_fee_extraction(self, mock_open, parser):
        """Genesis break fee is captured in cents."""
        text = (
            "Genesis Energy\n"
            "ICP: 0005555666GST77\n"
            "Genesis Everyday Plan\n"
            "Period: 01/04/2026 - 30/04/2026\n"
            "Consumption: 320 kWh\n"
            "Daily Fixed Charge: 30 days @ 33.33 c/day\n"
            "Energy Charge: 320 kWh @ 28.45 c/kWh\n"
            "Total: $101.04\n"
            "Break fee: $150.00\n"
        )
        mock_open.return_value = _mock_pdf(text)

        result = parser.parse("break_fee.pdf")
        assert result.break_fee_cents == 15000
