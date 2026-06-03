"""Tests for Contact Energy bill parser."""
import os
from unittest.mock import patch, MagicMock

import pytest
from parsers.contact_parser import ContactParser


@pytest.fixture
def parser():
    return ContactParser()


@pytest.fixture
def sample_contact_text():
    return """
Contact Energy
Your electricity bill

Account Number: 12345678
ICP Number: 0001234567ABC99
Installation Address: 123 Main Street, Auckland

Plan: Standard User

Billing Period: 01/04/2026 to 30/04/2026 (30 days)

Your electricity charges:

Daily Fixed Charge: 30 days @ 33.33 c/day = $10.00
Energy Charge: 450 kWh @ 25.50 c/kWh = $114.75

Total due: $124.75 including GST of $16.27

Payment due by: 20/05/2026
"""


class TestContactParser:
    def test_parser_registered(self):
        """Contact parser should be registered for 'contact' retailer."""
        from parsers.base import parser_for_retailer

        p = parser_for_retailer("contact")
        assert p is not None
        assert isinstance(p, ContactParser)

    def test_retailer_name(self, parser):
        assert parser.RETAILER_NAME == "Contact Energy"
        assert parser.RETAILER_ID == "contact"

    @patch("pdfplumber.open")
    def test_parses_contact_bill(self, mock_open, parser, sample_contact_text):
        mock_page = MagicMock()
        mock_page.extract_text.return_value = sample_contact_text
        mock_pdf = MagicMock()
        mock_pdf.pages = [mock_page]
        mock_pdf.__enter__.return_value = mock_pdf
        mock_pdf.__exit__.return_value = None
        mock_open.return_value = mock_pdf

        result = parser.parse("fake_contact_bill.pdf")

        assert result.retailer == "Contact Energy"
        assert result.icp_number == "0001234567ABC99"
        assert result.usage_kwh == 450.0
        assert result.total_cents == 12475
        assert result.period_start == "2026-04-01"
        assert result.period_end == "2026-04-30"
        assert result.days == 30
        assert result.c_per_kwh == 25.50
        assert result.c_per_day == 33.33
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
    def test_handles_missing_fields(self, mock_open, parser):
        """Parser should return defaults for fields it cannot extract."""
        mock_page = MagicMock()
        mock_page.extract_text.return_value = "Some random bill without clear structure\nTotal: $50.00"
        mock_pdf = MagicMock()
        mock_pdf.pages = [mock_page]
        mock_pdf.__enter__.return_value = mock_pdf
        mock_pdf.__exit__.return_value = None
        mock_open.return_value = mock_pdf

        result = parser.parse("minimal.pdf")

        assert result.retailer == "Contact Energy"
        assert result.total_cents == 5000
        assert result.confidence < 0.5  # Low confidence for minimal data

    @patch("pdfplumber.open")
    def test_extracts_fixed_term_expiry(self, mock_open, parser):
        """Contact bills rarely have fixed terms, but test the pattern."""
        text = """
Contact Energy
Fixed Term ends 15 Jun 2027
Total: $100.00
"""
        mock_page = MagicMock()
        mock_page.extract_text.return_value = text
        mock_pdf = MagicMock()
        mock_pdf.pages = [mock_page]
        mock_pdf.__enter__.return_value = mock_pdf
        mock_pdf.__exit__.return_value = None
        mock_open.return_value = mock_pdf

        result = parser.parse("fixed_term.pdf")
        assert result.fixed_term_expiry == "2027-06-15"

    @patch("pdfplumber.open")
    def test_extracts_break_fee(self, mock_open, parser):
        text = """
Contact Energy
Early Termination Fee: $150.00
Total: $200.00
"""
        mock_page = MagicMock()
        mock_page.extract_text.return_value = text
        mock_pdf = MagicMock()
        mock_pdf.pages = [mock_page]
        mock_pdf.__enter__.return_value = mock_pdf
        mock_pdf.__exit__.return_value = None
        mock_open.return_value = mock_pdf

        result = parser.parse("break_fee.pdf")
        assert result.break_fee_cents == 15000
