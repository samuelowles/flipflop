"""Tests for Pulse Energy bill parser.

Fixtures are synthetic/anonymized — fake ICPs (15-char), fake names, fake
amounts — covering the AC's required sample spread:
  1. Canonical (standard residential user)
  2. Low-user variation
  3. Layout variation (different label phrasing / ordering)
  4. Edge / missing-field case
"""
from unittest.mock import patch, MagicMock

import pytest
from parsers.pulse_parser import PulseParser


@pytest.fixture
def parser():
    return PulseParser()


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
Pulse Energy

Account: 8877665
ICP: 000123456789PU4
Customer: Alex Sample
Supply address: 3 Pulse Lane, Dunedin

Plan: Online Plan

Billing period: 01 Apr 2026 to 30 Apr 2026

Total usage: 540 kWh

Charges:
Daily charge: 30 days @ 95.00 c/day = $28.50
Variable charge: 540 kWh @ 24.00 c/kWh = $129.60

Total amount due: $158.10

GST included: $20.62
"""

# 2. Low-user variation.
BILL_LOW_USER = """
Pulse Energy

Your electricity bill

Customer: Jordan Fictional
ICP: 000111222333PU1
Supply Address: 78 Crescent Road, Christchurch

Plan: Energy Flexi Low User Plan

Billing period: 01 May 2026 to 31 May 2026

Your electricity usage:
Total units: 290 kWh

Charges:
Daily charge: 31 days @ 150.00 c/day = $46.50
Variable charge: 290 kWh @ 28.00 c/kWh = $81.20

Total amount due: $127.70

GST included: $16.66
"""

# 3. Layout variation — different label phrasing / ordering.
BILL_LAYOUT_VARIATION = """
Pulse Energy Classic Plan

Account holder: Morgan Variant
Installation Control Point: 000444555666PU2
Supply address: 12 Demo Street, Auckland

Total electricity usage 610 kWh
Period 01 Jun 2026 - 30 Jun 2026

Fixed charge 90.000 c/day
Energy charge 25.50 c/kWh

Total amount due $188.55
"""

# 4. Edge / missing-field case — minimal text, no ICP, no dates.
BILL_EDGE_MISSING = """
Pulse Energy bill

Total: $81.25
"""


class TestPulseParser:
    def test_parser_registered(self):
        from parsers.base import parser_for_retailer

        p = parser_for_retailer("pulse")
        assert p is not None
        assert isinstance(p, PulseParser)

    def test_retailer_name(self, parser):
        assert parser.RETAILER_NAME == "Pulse Energy"
        assert parser.RETAILER_ID == "pulse"

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

        assert result.retailer == "Pulse Energy"
        assert result.icp_number == "000123456789PU4"
        assert len(result.icp_number) == 15
        assert result.usage_kwh == 540.0
        assert result.total_cents == 15810
        assert result.period_start == "2026-04-01"
        assert result.period_end == "2026-04-30"
        assert result.days == 30
        assert result.c_per_kwh == 24.00
        assert result.c_per_day == 95.0
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

        assert result.retailer == "Pulse Energy"
        assert result.icp_number == "000111222333PU1"
        assert len(result.icp_number) == 15
        assert result.meter_type == "low_user"
        assert result.usage_kwh == 290.0
        assert result.total_cents == 12770
        assert result.period_start == "2026-05-01"
        assert result.period_end == "2026-05-31"
        assert result.days == 31
        assert result.c_per_kwh == 28.00
        assert result.c_per_day == 150.0
        assert result.confidence >= 0.9

    # -----------------------------------------------------------------
    # AC: Layout variation (different label phrasing / ordering).
    # -----------------------------------------------------------------
    @patch("pdfplumber.open")
    def test_layout_variation(self, mock_open, parser):
        mock_open.return_value = _mock_pdf(BILL_LAYOUT_VARIATION)

        result = parser.parse("layout_variation.pdf")

        assert result.retailer == "Pulse Energy"
        assert result.icp_number == "000444555666PU2"
        assert len(result.icp_number) == 15
        assert result.usage_kwh == 610.0
        assert result.total_cents == 18855
        assert result.period_start == "2026-06-01"
        assert result.period_end == "2026-06-30"
        assert result.days == 30
        assert result.c_per_kwh == 25.50
        assert result.c_per_day == 90.0
        assert result.confidence >= 0.9

    # -----------------------------------------------------------------
    # AC: Edge / missing-field case.
    # -----------------------------------------------------------------
    @patch("pdfplumber.open")
    def test_handles_missing_fields(self, mock_open, parser):
        mock_open.return_value = _mock_pdf(BILL_EDGE_MISSING)

        result = parser.parse("minimal.pdf")

        assert result.retailer == "Pulse Energy"
        assert result.total_cents == 8125
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
