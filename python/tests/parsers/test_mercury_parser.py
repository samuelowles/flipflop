"""Tests for Mercury bill parser."""
from unittest.mock import patch, MagicMock

import pytest
from parsers.mercury_parser import MercuryParser


@pytest.fixture
def parser():
    return MercuryParser()


@pytest.fixture
def sample_mercury_text():
    return """
Mercury

Your electricity bill

Customer: Jane Doe
ICP: 0009876543DEF99
Supply Address: 456 Queen Street, Auckland

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
    def test_parses_mercury_bill(self, mock_open, parser, sample_mercury_text):
        mock_page = MagicMock()
        mock_page.extract_text.return_value = sample_mercury_text
        mock_pdf = MagicMock()
        mock_pdf.pages = [mock_page]
        mock_pdf.__enter__.return_value = mock_pdf
        mock_pdf.__exit__.return_value = None
        mock_open.return_value = mock_pdf

        result = parser.parse("fake_mercury_bill.pdf")

        assert result.retailer == "Mercury"
        assert result.icp_number == "0009876543DEF99"
        assert result.usage_kwh == 520.0
        assert result.total_cents == 15596
        assert result.period_start == "2026-05-14"
        assert result.period_end == "2026-06-13"
        assert result.c_per_kwh == 24.80
        assert result.c_per_day == 90.0
        assert "Mercury" in result.plan_name
        assert result.confidence > 0.5

    @patch("pdfplumber.open")
    def test_raises_on_empty_pdf(self, mock_open, parser):
        mock_page = MagicMock()
        mock_page.extract_text.return_value = ""
        mock_pdf = MagicMock()
        mock_pdf.pages = [mock_page]
        mock_pdf.__enter__.return_value = mock_pdf
        mock_pdf.__exit__.return_value = None
        mock_open.return_value = mock_pdf

        with pytest.raises(ValueError, match="No extractable text"):
            parser.parse("empty.pdf")

    @patch("pdfplumber.open")
    def test_mercury_plan_name_extraction(self, mock_open, parser):
        text = "Mercury Classic Plan\nTotal: $100.00"
        mock_page = MagicMock()
        mock_page.extract_text.return_value = text
        mock_pdf = MagicMock()
        mock_pdf.pages = [mock_page]
        mock_pdf.__enter__.return_value = mock_pdf
        mock_pdf.__exit__.return_value = None
        mock_open.return_value = mock_pdf

        result = parser.parse("plan.pdf")
        assert "Classic" in result.plan_name

    @patch("pdfplumber.open")
    def test_handles_missing_fields(self, mock_open, parser):
        mock_page = MagicMock()
        mock_page.extract_text.return_value = "Mercury bill\nTotal: $75.00"
        mock_pdf = MagicMock()
        mock_pdf.pages = [mock_page]
        mock_pdf.__enter__.return_value = mock_pdf
        mock_pdf.__exit__.return_value = None
        mock_open.return_value = mock_pdf

        result = parser.parse("minimal.pdf")
        assert result.retailer == "Mercury"
        assert result.total_cents == 7500
        assert result.confidence < 0.4
