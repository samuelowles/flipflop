"""Tests for Flick Electric bill parser.

Fixtures are synthetic/anonymized — fake ICPs (15-char), fake names, fake
amounts — covering the AC's required sample spread:
  1. Canonical (standard residential user, variable spot-price)
  2. Low-user variation
  3. Layout variation (different label phrasing / ordering)
  4. Edge / missing-field case
"""
from unittest.mock import patch, MagicMock

import pytest
from parsers.flick_parser import FlickParser


@pytest.fixture
def parser():
    return FlickParser()


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

# 1. Canonical — standard residential user (variable spot-price retailer).
BILL_CANONICAL = """
Flick Electric

Account: 3322556
ICP: 000777888999FL3
Customer: Alex Sample
Supply address: 78 Flick Avenue, Christchurch

Plan: Flat Plan

Billing period: 01 May 2026 to 31 May 2026

Total usage: 600 kWh

Charges:
Fixed daily charge: 31 days @ 200.00 c/day = $62.00
Variable usage: 600 kWh @ 26.00 c/kWh = $156.00

Total amount due: $218.00

GST included: $28.43
"""

# 2. Low-user variation.
BILL_LOW_USER = """
Flick Electric

Your electricity bill

Customer: Jordan Fictional
ICP: 000111222333FL1
Supply Address: 12 Low User Road, Auckland

Plan: Freestyle Low User Plan

Billing period: 01 Jun 2026 to 30 Jun 2026

Your electricity usage:
Total units: 270 kWh

Charges:
Daily charge: 30 days @ 150.00 c/day = $45.00
Variable charge: 270 kWh @ 29.50 c/kWh = $79.65

Total amount due: $124.65

GST included: $16.26
"""

# 3. Layout variation — different label phrasing / ordering.
BILL_LAYOUT_VARIATION = """
Flick Off Peak Plan

Account holder: Morgan Variant
Installation Control Point: 000123456789FL2
Supply address: 3 Demo Lane, Dunedin

Total electricity usage 520 kWh
Period 01 Apr 2026 - 30 Apr 2026

Fixed charge 90.000 c/day
Energy charge 25.00 c/kWh

Total amount due $164.50
"""

# 4. Edge / missing-field case — minimal text, no ICP, no dates.
BILL_EDGE_MISSING = """
Flick bill

Total: $92.10
"""


class TestFlickParser:
    def test_parser_registered(self):
        from parsers.base import parser_for_retailer

        p = parser_for_retailer("flick")
        assert p is not None
        assert isinstance(p, FlickParser)

    def test_retailer_name(self, parser):
        assert parser.RETAILER_NAME == "Flick Electric"
        assert parser.RETAILER_ID == "flick"

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

        assert result.retailer == "Flick Electric"
        assert result.icp_number == "000777888999FL3"
        assert len(result.icp_number) == 15
        assert result.usage_kwh == 600.0
        assert result.total_cents == 21800
        assert result.period_start == "2026-05-01"
        assert result.period_end == "2026-05-31"
        assert result.days == 31
        assert result.c_per_kwh == 26.00
        assert result.c_per_day == 200.0
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

        assert result.retailer == "Flick Electric"
        assert result.icp_number == "000111222333FL1"
        assert len(result.icp_number) == 15
        assert result.meter_type == "low_user"
        assert result.usage_kwh == 270.0
        assert result.total_cents == 12465
        assert result.period_start == "2026-06-01"
        assert result.period_end == "2026-06-30"
        assert result.days == 30
        assert result.c_per_kwh == 29.50
        assert result.c_per_day == 150.0
        assert result.confidence >= 0.9

    # -----------------------------------------------------------------
    # AC: Layout variation (different label phrasing / ordering).
    # -----------------------------------------------------------------
    @patch("pdfplumber.open")
    def test_layout_variation(self, mock_open, parser):
        mock_open.return_value = _mock_pdf(BILL_LAYOUT_VARIATION)

        result = parser.parse("layout_variation.pdf")

        assert result.retailer == "Flick Electric"
        assert result.icp_number == "000123456789FL2"
        assert len(result.icp_number) == 15
        assert result.usage_kwh == 520.0
        assert result.total_cents == 16450
        assert result.period_start == "2026-04-01"
        assert result.period_end == "2026-04-30"
        assert result.days == 30
        assert result.c_per_kwh == 25.00
        assert result.c_per_day == 90.0
        assert result.confidence >= 0.9

    # -----------------------------------------------------------------
    # AC: Edge / missing-field case.
    # -----------------------------------------------------------------
    @patch("pdfplumber.open")
    def test_handles_missing_fields(self, mock_open, parser):
        mock_open.return_value = _mock_pdf(BILL_EDGE_MISSING)

        result = parser.parse("minimal.pdf")

        assert result.retailer == "Flick Electric"
        assert result.total_cents == 9210
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
