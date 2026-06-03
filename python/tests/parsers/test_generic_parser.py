"""Tests for generic fallback bill parser."""
from unittest.mock import patch, MagicMock

import pytest
from parsers.generic_parser import GenericParser


@pytest.fixture
def parser():
    return GenericParser()


@pytest.fixture
def sample_generic_text():
    return """
Electricity Bill

ICP: 1234567890ABCDE
Period: 2026-04-01 to 2026-04-30
Usage: 600 kWh

Charges:
Daily fixed: $0.90 per day
Energy: 25.50 c/kWh

Total due: $170.00
"""


class TestGenericParser:
    @patch("pdfplumber.open")
    def test_parses_generic_bill(self, mock_open, parser, sample_generic_text):
        mock_page = MagicMock()
        mock_page.extract_text.return_value = sample_generic_text
        mock_pdf = MagicMock()
        mock_pdf.pages = [mock_page]
        mock_pdf.__enter__.return_value = mock_pdf
        mock_pdf.__exit__.return_value = None
        mock_open.return_value = mock_pdf

        result = parser.parse("generic_bill.pdf")

        assert result.icp_number == "1234567890ABCDE"
        assert result.usage_kwh == 600.0
        assert result.total_cents == 17000
        assert result.period_start == "2026-04-01"
        assert result.period_end == "2026-04-30"
        assert result.c_per_kwh == 25.50
        assert result.c_per_day == 90.0
        assert result.confidence > 0.3

    @patch("pdfplumber.open")
    def test_detects_retailer(self, mock_open, parser):
        text = """
Contact Energy bill
ICP: 0001234567ABC99
Total: $100.00
"""
        mock_page = MagicMock()
        mock_page.extract_text.return_value = text
        mock_pdf = MagicMock()
        mock_pdf.pages = [mock_page]
        mock_pdf.__enter__.return_value = mock_pdf
        mock_pdf.__exit__.return_value = None
        mock_open.return_value = mock_pdf

        result = parser.parse("contact_bill.pdf")
        assert result.retailer == "Contact Energy"

    @patch("pdfplumber.open")
    def test_detects_mercury_retailer(self, mock_open, parser):
        text = """
Mercury bill
Total: $150.00
"""
        mock_page = MagicMock()
        mock_page.extract_text.return_value = text
        mock_pdf = MagicMock()
        mock_pdf.pages = [mock_page]
        mock_pdf.__enter__.return_value = mock_pdf
        mock_pdf.__exit__.return_value = None
        mock_open.return_value = mock_pdf

        result = parser.parse("mercury_bill.pdf")
        assert result.retailer == "Mercury"

    @patch("pdfplumber.open")
    def test_detects_genesis_retailer(self, mock_open, parser):
        text = """
Genesis Energy bill
Total: $200.00
"""
        mock_page = MagicMock()
        mock_page.extract_text.return_value = text
        mock_pdf = MagicMock()
        mock_pdf.pages = [mock_page]
        mock_pdf.__enter__.return_value = mock_pdf
        mock_pdf.__exit__.return_value = None
        mock_open.return_value = mock_pdf

        result = parser.parse("genesis_bill.pdf")
        assert result.retailer == "Genesis Energy"

    @patch("pdfplumber.open")
    def test_unknown_retailer_default(self, mock_open, parser):
        text = """
Some unknown electricity company
Total: $50.00
"""
        mock_page = MagicMock()
        mock_page.extract_text.return_value = text
        mock_pdf = MagicMock()
        mock_pdf.pages = [mock_page]
        mock_pdf.__enter__.return_value = mock_pdf
        mock_pdf.__exit__.return_value = None
        mock_open.return_value = mock_pdf

        result = parser.parse("unknown.pdf")
        assert result.retailer == "Unknown"
        # Generic parser penalizes confidence for unknown retailer
        assert result.confidence < 0.5

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

    # Parametrised test covering all 25 known NZ residential electricity retailers
    _ALL_RETAILERS = [
        # Major retailers (dedicated parsers)
        ("Contact Energy", "Your Contact Energy bill is ready"),
        ("Genesis Energy", "Genesis Energy — monthly statement"),
        ("Mercury", "Mercury invoice summary"),
        # Major retailers (generic parser only)
        ("Meridian Energy", "Meridian Energy power bill"),
        ("Nova Energy", "Nova Energy account statement"),
        ("Trustpower", "Trustpower electricity charges"),
        ("Electric Kiwi", "Electric Kiwi invoice"),
        ("Powershop", "Powershop monthly statement"),
        ("Flick Electric", "Flick Electric bill summary"),
        ("Pulse Energy", "Pulse Energy charges this month"),
        # Additional retailers (Powerswitch + EA registry)
        ("Ecotricity", "Ecotricity — carbon zero power"),
        ("Globug", "Your Globug prepay summary"),
        ("Hanergy", "Hanergy bill for this month"),
        ("Megatel", "Megatel energy statement"),
        ("Octopus Energy", "Octopus Energy — your bill"),
        ("Tensor", "Tensor electricity invoice"),
        ("Toast Electric", "Toast Electric community power"),
        ("2degrees", "2degrees power and broadband"),
        ("Slingshot", "Slingshot energy charges"),
        ("Grey Power Electricity", "Grey Power Electricity seniors plan"),
        ("Black Box Power", "Black Box Power statement"),
        ("Just Energy", "Just Energy monthly bill"),
        ("Nau Mai Rā", "Nau Mai Rā power invoice"),
        ("Wise Prepay Energy", "Wise Prepay Energy top-up receipt"),
        # Legacy / rebranded
        ("Manawa Energy", "Manawa Energy generation statement"),
    ]

    @pytest.mark.parametrize("expected_name,text", _ALL_RETAILERS)
    def test_detect_retailer_all(self, parser, expected_name, text):
        result = parser._detect_retailer(text)
        assert result == expected_name, f"Expected '{expected_name}' but got '{result}' for text: {text}"

    def test_detect_retailer_unknown(self, parser):
        result = parser._detect_retailer("Random text with no retailer name")
        assert result == "Unknown"

    def test_detect_retailer_case_insensitive(self, parser):
        result = parser._detect_retailer("contact energy")
        assert result == "Contact Energy"

    def test_detect_retailer_spacing_variant(self, parser):
        result = parser._detect_retailer("Contact  Energy")  # extra space
        assert result == "Contact Energy"
