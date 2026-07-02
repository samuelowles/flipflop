"""Tests for Powershop bill parser.

Fixtures are synthetic/anonymized — fake ICPs (15-char), fake names, fake
amounts — covering the AC's required sample spread:
  1. Canonical (standard residential user, prepaid-style)
  2. Low-user variation
  3. Layout variation (different label phrasing / ordering)
  4. Edge / missing-field case
"""
from unittest.mock import patch, MagicMock

import pytest
from parsers.powershop_parser import PowershopParser


@pytest.fixture
def parser():
    return PowershopParser()


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

# 1. Canonical — standard residential user (prepaid-style).
BILL_CANONICAL = """
Powershop

Account: 5544332
ICP: 000444555666PS2
Account holder: Alex Sample
Supply address: 45 Power Street, Wellington

Plan: Saver Plan

Billing period: 01 Jun 2026 to 30 Jun 2026

Total energy used: 410 kWh

Charges:
Daily charge: 30 days @ 85.00 c/day = $25.50
Variable rate: 410 kWh @ 23.00 c/kWh = $94.30

Total payable: $119.80

GST included: $15.62
"""

# 2. Low-user variation.
BILL_LOW_USER = """
Powershop

Your electricity bill

Customer: Jordan Fictional
ICP: 000111222333PS1
Supply Address: 78 Crescent Road, Christchurch

Plan: Everyday Low User Plan

Billing period: 01 May 2026 to 31 May 2026

Your electricity usage:
Total units: 260 kWh

Charges:
Daily charge: 31 days @ 150.00 c/day = $46.50
Variable charge: 260 kWh @ 27.50 c/kWh = $71.50

Amount due: $118.00

GST included: $15.39
"""

# 3. Layout variation — different label phrasing / ordering.
BILL_LAYOUT_VARIATION = """
Powershop Classic Plan

Account holder: Morgan Variant
Installation Control Point: 000123456789PS3
Supply address: 3 Demo Lane, Dunedin

Total electricity usage 540 kWh
Period 01 Apr 2026 - 30 Apr 2026

Fixed charge 90.000 c/day
Energy charge 24.00 c/kWh

Total amount due $171.60
"""

# 4. Edge / missing-field case — minimal text, no ICP, no dates.
BILL_EDGE_MISSING = """
Powershop bill

Total: $68.50
"""


class TestPowershopParser:
    def test_parser_registered(self):
        from parsers.base import parser_for_retailer

        p = parser_for_retailer("powershop")
        assert p is not None
        assert isinstance(p, PowershopParser)

    def test_retailer_name(self, parser):
        assert parser.RETAILER_NAME == "Powershop"
        assert parser.RETAILER_ID == "powershop"

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

        assert result.retailer == "Powershop"
        assert result.icp_number == "000444555666PS2"
        assert len(result.icp_number) == 15
        assert result.usage_kwh == 410.0
        assert result.total_cents == 11980
        assert result.period_start == "2026-06-01"
        assert result.period_end == "2026-06-30"
        assert result.days == 30
        assert result.c_per_kwh == 23.00
        assert result.c_per_day == 85.0
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

        assert result.retailer == "Powershop"
        assert result.icp_number == "000111222333PS1"
        assert len(result.icp_number) == 15
        assert result.meter_type == "low_user"
        assert result.usage_kwh == 260.0
        assert result.total_cents == 11800
        assert result.period_start == "2026-05-01"
        assert result.period_end == "2026-05-31"
        assert result.days == 31
        assert result.c_per_kwh == 27.50
        assert result.c_per_day == 150.0
        assert result.confidence >= 0.9

    # -----------------------------------------------------------------
    # AC: Layout variation (different label phrasing / ordering).
    # -----------------------------------------------------------------
    @patch("pdfplumber.open")
    def test_layout_variation(self, mock_open, parser):
        mock_open.return_value = _mock_pdf(BILL_LAYOUT_VARIATION)

        result = parser.parse("layout_variation.pdf")

        assert result.retailer == "Powershop"
        assert result.icp_number == "000123456789PS3"
        assert len(result.icp_number) == 15
        assert result.usage_kwh == 540.0
        assert result.total_cents == 17160
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

        assert result.retailer == "Powershop"
        assert result.total_cents == 6850
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
