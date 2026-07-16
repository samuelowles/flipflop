"""Tests for Mercury bill parser.

Fixtures are synthetic/anonymized — fake ICPs (15-char), fake names, fake
amounts — covering the AC's required sample spread:
  1. Electricity-only canonical (standard user)
  2. Dual-fuel (electricity + gas bundled — extract ELECTRICITY portion)
  3. Low-user electricity
  4. Layout variation (different label phrasing / ordering)
  5. Edge / missing-field case
"""
from unittest.mock import patch, MagicMock

import pytest
from parsers.mercury_parser import MercuryParser


@pytest.fixture
def parser():
    return MercuryParser()


def _mock_pdf(text: str) -> MagicMock:
    """Build a fake pdfplumber handle whose single page yields *text*."""
    mock_page = MagicMock()
    mock_page.extract_text.return_value = text
    mock_pdf = MagicMock()
    mock_pdf.pages = [mock_page]
    mock_pdf.__enter__.return_value = mock_pdf
    mock_pdf.__exit__.return_value = None
    return mock_pdf


# ---------------------------------------------------------------------------
# Anonymized sample bill fixtures (AC: 5+ sample bills)
# ---------------------------------------------------------------------------

# 1. Electricity-only canonical — standard residential user.
BILL_ELECTRICITY_ONLY = """
Mercury

Your electricity bill

Customer: Alex Sample
ICP: 0009876543DEF99
Supply Address: 1 Queen Street, Auckland Central, Auckland 1010

Mercury Online Plan

Billing period: 14 May 2026 to 13 Jun 2026

Your electricity usage:
Total units: 520 kWh

Charges:
Daily charge: 30 days @ 90.00 c/day = $27.00
Variable charge: 520 kWh @ 24.80 c/kWh = $128.96

Total amount due: $155.96

GST included: $20.34
"""

# 2. Dual-fuel — electricity + gas bundled. The parser must extract the
#    ELECTRICITY total ($155.96) and ELECTRICITY usage (520 kWh), NOT the
#    combined total ($219.45) or gas usage (150 kWh).
BILL_DUAL_FUEL = """
Mercury

Your energy bill (electricity + gas)

Customer: Jordan Fictional
ICP: 000111222333AB5
Gas ID: 9998877
Supply Address: 12 Fake Street, Wellington

Mercury Classic Plan

Billing period: 01 Jun 2026 to 30 Jun 2026

Electricity usage:
Electricity total units: 480 kWh

Gas usage:
Gas total units: 150 kWh

Electricity charges:
Daily charge: 30 days @ 85.00 c/day = $25.50
Variable charge: 480 kWh @ 25.00 c/kWh = $120.00
Total electricity charge: $145.50

Gas charges:
Gas fixed charge: $12.00
Gas variable charge: 150 kWh @ 4.13 c/kWh = $61.95
Total gas charge: $73.95

Total amount due: $219.45

GST included: $28.62
"""

# 3. Low-user electricity bill.
BILL_LOW_USER = """
Mercury

Your electricity bill

Customer: Taylor Test
ICP: 000444555666XY7
Supply Address: 1 Queen Street, Auckland Central, Auckland 1010

Mercury Everyday Plan (Low User)

Billing period: 01 May 2026 to 31 May 2026

Your electricity usage:
Total units: 280 kWh

Charges:
Daily charge: 31 days @ 150.00 c/day = $46.50
Variable charge: 280 kWh @ 28.50 c/kWh = $79.80

Total amount due: $126.30

GST included: $16.48
"""

# 4. Layout variation — different label phrasing / ordering.
BILL_LAYOUT_VARIATION = """
Mercury Classic Plan

Account holder: Morgan Variant
Installation Control Point: 000123456789QR0
Supply address: 3 Demo Lane, Dunedin

Total electricity usage 610 kWh
Period 01 Apr 2026 - 30 Apr 2026

Fixed charge 90.000 c/day
Energy charge 24.00 c/kWh

Electricity total due $186.30
"""

# 5. Edge / missing-field case — minimal text, no ICP, no dates.
BILL_EDGE_MISSING = """
Mercury bill

Total: $75.00
"""

# 6. Day/night meter variation (extra coverage distinct from above).
BILL_DAY_NIGHT = """
Mercury

Your electricity bill

Customer: Casey Nightuser
ICP: 000777888999TU2
Supply Address: 1 Queen Street, Auckland Central, Auckland 1010

Mercury Saver Plan (Day/Night)

Billing period: 01 Jul 2026 to 31 Jul 2026

Day rate usage: 350 kWh
Night rate usage: 180 kWh
Total units: 530 kWh

Charges:
Daily charge: 31 days @ 95.00 c/day = $29.45
Variable charge: 530 kWh @ 23.50 c/kWh = $124.55

Total amount due: $154.00

GST included: $20.09
"""


class TestMercuryParser:
    def test_parser_registered(self):
        from parsers.base import parser_for_retailer

        p = parser_for_retailer("mercury")
        assert p is not None
        assert isinstance(p, MercuryParser)

    def test_retailer_name(self, parser):
        assert parser.RETAILER_NAME == "Mercury"
        assert parser.RETAILER_ID == "mercury"

    @patch("pdfplumber.open")
    def test_raises_on_empty_pdf(self, mock_open, parser):
        mock_open.return_value = _mock_pdf("")

        with pytest.raises(ValueError, match="No extractable text"):
            parser.parse("empty.pdf")

    @patch("pdfplumber.open")
    def test_mercury_plan_name_extraction(self, mock_open, parser):
        mock_open.return_value = _mock_pdf("Mercury Classic Plan\nTotal: $100.00")

        result = parser.parse("plan.pdf")
        assert "Classic" in result.plan_name

    # -----------------------------------------------------------------
    # AC: Confidence >=0.9 on canonical Mercury layout.
    # Canonical electricity-only bill must hit the >=0.9 target.
    # -----------------------------------------------------------------
    @patch("pdfplumber.open")
    def test_electricity_only_canonical_confidence(self, mock_open, parser):
        mock_open.return_value = _mock_pdf(BILL_ELECTRICITY_ONLY)

        result = parser.parse("electricity_only.pdf")

        assert result.retailer == "Mercury"
        # ICP is 15 alphanumeric chars.
        assert result.icp_number == "0009876543DEF99"
        assert len(result.icp_number) == 15
        # Canonical schema fields.
        assert result.usage_kwh == 520.0
        assert result.total_cents == 15596
        assert result.period_start == "2026-05-14"
        assert result.period_end == "2026-06-13"
        assert result.days == 31
        assert result.c_per_kwh == 24.80
        assert result.c_per_day == 90.0
        assert "Mercury" in result.plan_name
        # AC: confidence >= 0.9 on canonical layout.
        assert result.confidence >= 0.9, (
            f"canonical confidence {result.confidence:.3f} below 0.9"
        )

    # -----------------------------------------------------------------
    # AC: Handles dual-fuel bills — extract ELECTRICITY portion only.
    # -----------------------------------------------------------------
    @patch("pdfplumber.open")
    def test_dual_fuel_extracts_electricity_only(self, mock_open, parser):
        mock_open.return_value = _mock_pdf(BILL_DUAL_FUEL)

        result = parser.parse("dual_fuel.pdf")

        assert result.retailer == "Mercury"
        assert result.icp_number == "000111222333AB5"
        # Electricity usage — NOT gas (150) or combined.
        assert result.usage_kwh == 480.0
        # Electricity total ($145.50 = 14550c) — NOT combined $219.45.
        assert result.total_cents == 14550, (
            f"dual-fuel total {result.total_cents}c should be electricity-only "
            f"(14550c), not combined (21945c)"
        )
        assert result.c_per_kwh == 25.00
        assert result.c_per_day == 85.0
        assert result.period_start == "2026-06-01"
        assert result.period_end == "2026-06-30"
        assert result.days == 30
        # Gas must NOT leak into the electricity total.
        assert result.total_cents != 21945
        assert result.usage_kwh != 150.0

    # -----------------------------------------------------------------
    # AC: Low-user electricity bill.
    # -----------------------------------------------------------------
    @patch("pdfplumber.open")
    def test_low_user_bill(self, mock_open, parser):
        mock_open.return_value = _mock_pdf(BILL_LOW_USER)

        result = parser.parse("low_user.pdf")

        assert result.retailer == "Mercury"
        assert result.icp_number == "000444555666XY7"
        assert len(result.icp_number) == 15
        assert result.meter_type == "low_user"
        assert result.usage_kwh == 280.0
        assert result.total_cents == 12630
        assert result.period_start == "2026-05-01"
        assert result.period_end == "2026-05-31"
        assert result.days == 31
        assert result.c_per_kwh == 28.50
        assert result.c_per_day == 150.0
        assert result.confidence >= 0.9

    # -----------------------------------------------------------------
    # AC: Layout variation (different label phrasing / ordering).
    # -----------------------------------------------------------------
    @patch("pdfplumber.open")
    def test_layout_variation(self, mock_open, parser):
        mock_open.return_value = _mock_pdf(BILL_LAYOUT_VARIATION)

        result = parser.parse("layout_variation.pdf")

        assert result.retailer == "Mercury"
        assert result.icp_number == "000123456789QR0"
        assert len(result.icp_number) == 15
        assert result.usage_kwh == 610.0
        assert result.total_cents == 18630
        assert result.period_start == "2026-04-01"
        assert result.period_end == "2026-04-30"
        assert result.days == 30
        assert result.c_per_kwh == 24.00
        assert result.c_per_day == 90.0
        assert result.confidence >= 0.9

    # -----------------------------------------------------------------
    # AC: Edge / missing-field case.
    # -----------------------------------------------------------------
    @patch("pdfplumber.open")
    def test_handles_missing_fields(self, mock_open, parser):
        mock_open.return_value = _mock_pdf(BILL_EDGE_MISSING)

        result = parser.parse("minimal.pdf")

        assert result.retailer == "Mercury"
        assert result.total_cents == 7500
        # No ICP, no dates, no usage — confidence must be low.
        assert result.icp_number == ""
        assert result.usage_kwh == 0.0
        assert result.confidence < 0.4

    # -----------------------------------------------------------------
    # Day/night meter variation (extra distinct coverage).
    # -----------------------------------------------------------------
    @patch("pdfplumber.open")
    def test_day_night_meter(self, mock_open, parser):
        mock_open.return_value = _mock_pdf(BILL_DAY_NIGHT)

        result = parser.parse("day_night.pdf")

        assert result.retailer == "Mercury"
        assert result.icp_number == "000777888999TU2"
        assert len(result.icp_number) == 15
        assert result.meter_type == "day_night"
        # Total units line is preferred over day/night components.
        assert result.usage_kwh == 530.0
        assert result.total_cents == 15400
        assert result.c_per_kwh == 23.50
        assert result.c_per_day == 95.0
        assert result.period_start == "2026-07-01"
        assert result.period_end == "2026-07-31"
        assert result.confidence >= 0.9

    # -----------------------------------------------------------------
    # Sanity: canonical bills return the full ParserResult schema.
    # -----------------------------------------------------------------
    @patch("pdfplumber.open")
    def test_canonical_schema_complete(self, mock_open, parser):
        from parsers.base import ParserResult

        mock_open.return_value = _mock_pdf(BILL_ELECTRICITY_ONLY)

        result = parser.parse("schema.pdf")

        assert isinstance(result, ParserResult)
        # Every canonical field is populated for a canonical bill.
        for field in (
            "retailer",
            "plan_name",
            "meter_type",
            "icp_number",
            "period_start",
            "period_end",
            "days",
            "usage_kwh",
            "total_cents",
            "c_per_kwh",
            "c_per_day",
            "confidence",
            "raw_json",
        ):
            assert hasattr(result, field), f"missing schema field: {field}"
