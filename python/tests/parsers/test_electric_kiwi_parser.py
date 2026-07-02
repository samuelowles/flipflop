"""Tests for Electric Kiwi bill parser.

Fixtures are synthetic/anonymized — fake ICPs (15-char), fake names, fake
amounts — covering the AC's required sample spread:
  1. Canonical (standard residential user)
  2. Low-user variation
  3. Day/night meter variation
  4. Edge / missing-field case
"""
from unittest.mock import patch, MagicMock

import pytest
from parsers.electric_kiwi_parser import ElectricKiwiParser


@pytest.fixture
def parser():
    return ElectricKiwiParser()


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
# Anonymized sample bill fixtures (AC: 3+ sample bills)
# ---------------------------------------------------------------------------

# 1. Canonical — standard residential user.
BILL_CANONICAL = """
Electric Kiwi

Account number: 9876543
ICP: 000111222333EK1
Customer: Alex Sample
Supply Address: 12 Kiwi Road, Auckland

Plan: Kiwi Saver Plan

Billing period: 14 May 2026 to 13 Jun 2026

Your usage:
520 kWh

Charges:
Daily charge: 31 days @ 90.00 c/day = $27.90
Variable charge: 520 kWh @ 25.50 c/kWh = $132.60

Total amount due: $160.50

GST included: $20.94
"""

# 2. Low-user variation.
BILL_LOW_USER = """
Electric Kiwi

Your electricity bill

Customer: Jordan Fictional
ICP: 000444555666EK2
Supply Address: 78 Crescent Road, Christchurch

Plan: Stay Ahead Low User Plan

Billing period: 01 May 2026 to 31 May 2026

Your electricity usage:
Total units: 280 kWh

Charges:
Daily charge: 31 days @ 150.00 c/day = $46.50
Variable charge: 280 kWh @ 28.50 c/kWh = $79.80

Total amount due: $126.30

GST included: $16.48
"""

# 3. Day/night meter variation.
BILL_DAY_NIGHT = """
Electric Kiwi

Your electricity bill

Customer: Casey Nightuser
ICP: 000777888999EK3
Supply Address: 5 Dark Alley, Hamilton

Plan: On The Go Day/Night Plan

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

# 4. Edge / missing-field case — minimal text, no ICP, no dates.
BILL_EDGE_MISSING = """
Electric Kiwi bill

Total: $75.00
"""


class TestElectricKiwiParser:
    def test_parser_registered(self):
        from parsers.base import parser_for_retailer

        p = parser_for_retailer("electric_kiwi")
        assert p is not None
        assert isinstance(p, ElectricKiwiParser)

    def test_retailer_name(self, parser):
        assert parser.RETAILER_NAME == "Electric Kiwi"
        assert parser.RETAILER_ID == "electric_kiwi"

    @patch("pdfplumber.open")
    def test_raises_on_empty_pdf(self, mock_open, parser):
        mock_open.return_value = _mock_pdf("")

        with pytest.raises(ValueError, match="No extractable text"):
            parser.parse("empty.pdf")

    # -----------------------------------------------------------------
    # AC: Confidence >=0.9 on canonical layout.
    # -----------------------------------------------------------------
    @patch("pdfplumber.open")
    def test_canonical_confidence(self, mock_open, parser):
        mock_open.return_value = _mock_pdf(BILL_CANONICAL)

        result = parser.parse("canonical.pdf")

        assert result.retailer == "Electric Kiwi"
        assert result.icp_number == "000111222333EK1"
        assert len(result.icp_number) == 15
        assert result.usage_kwh == 520.0
        assert result.total_cents == 16050
        assert result.period_start == "2026-05-14"
        assert result.period_end == "2026-06-13"
        assert result.days == 31
        assert result.c_per_kwh == 25.50
        assert result.c_per_day == 90.0
        # AC: confidence >= 0.9 on canonical layout.
        assert result.confidence >= 0.9, (
            f"canonical confidence {result.confidence:.3f} below 0.9"
        )

    # -----------------------------------------------------------------
    # AC: Low-user variation.
    # -----------------------------------------------------------------
    @patch("pdfplumber.open")
    def test_low_user_bill(self, mock_open, parser):
        mock_open.return_value = _mock_pdf(BILL_LOW_USER)

        result = parser.parse("low_user.pdf")

        assert result.retailer == "Electric Kiwi"
        assert result.icp_number == "000444555666EK2"
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
    # AC: Day/night meter variation.
    # -----------------------------------------------------------------
    @patch("pdfplumber.open")
    def test_day_night_meter(self, mock_open, parser):
        mock_open.return_value = _mock_pdf(BILL_DAY_NIGHT)

        result = parser.parse("day_night.pdf")

        assert result.retailer == "Electric Kiwi"
        assert result.icp_number == "000777888999EK3"
        assert len(result.icp_number) == 15
        assert result.meter_type == "day_night"
        # Total units line preferred over day/night components.
        assert result.usage_kwh == 530.0
        assert result.total_cents == 15400
        assert result.c_per_kwh == 23.50
        assert result.c_per_day == 95.0
        assert result.period_start == "2026-07-01"
        assert result.period_end == "2026-07-31"
        assert result.confidence >= 0.9

    # -----------------------------------------------------------------
    # AC: Edge / missing-field case.
    # -----------------------------------------------------------------
    @patch("pdfplumber.open")
    def test_handles_missing_fields(self, mock_open, parser):
        mock_open.return_value = _mock_pdf(BILL_EDGE_MISSING)

        result = parser.parse("minimal.pdf")

        assert result.retailer == "Electric Kiwi"
        assert result.total_cents == 7500
        # No ICP, no dates, no usage — confidence must be low.
        assert result.icp_number == ""
        assert result.usage_kwh == 0.0
        assert result.confidence < 0.4

    # -----------------------------------------------------------------
    # Sanity: canonical bills return the full ParserResult schema.
    # -----------------------------------------------------------------
    @patch("pdfplumber.open")
    def test_canonical_schema_complete(self, mock_open, parser):
        from parsers.base import ParserResult

        mock_open.return_value = _mock_pdf(BILL_CANONICAL)

        result = parser.parse("schema.pdf")

        assert isinstance(result, ParserResult)
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
