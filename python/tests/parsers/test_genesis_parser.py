"""Tests for Genesis Energy bill parser."""
from unittest.mock import patch, MagicMock

import pytest
from parsers.genesis_parser import GenesisParser


@pytest.fixture
def parser():
    return GenesisParser()


@pytest.fixture
def sample_genesis_text():
    return """
Genesis Energy

Your Energy bill

Customer: Bob Smith
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


class TestGenesisParser:
    def test_parser_registered(self):
        from parsers.base import parser_for_retailer

        p = parser_for_retailer("genesis")
        assert p is not None
        assert isinstance(p, GenesisParser)

    def test_retailer_name(self, parser):
        assert parser.RETAILER_NAME == "Genesis Energy"
        assert parser.RETAILER_ID == "genesis"

    @patch("pdfplumber.open")
    def test_parses_genesis_bill(self, mock_open, parser, sample_genesis_text):
        mock_page = MagicMock()
        mock_page.extract_text.return_value = sample_genesis_text
        mock_pdf = MagicMock()
        mock_pdf.pages = [mock_page]
        mock_pdf.__enter__.return_value = mock_pdf
        mock_pdf.__exit__.return_value = None
        mock_open.return_value = mock_pdf

        result = parser.parse("fake_genesis_bill.pdf")

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
    def test_genesis_plan_name_extraction(self, mock_open, parser):
        text = "Genesis Energy Saver Plan\nTotal: $95.00"
        mock_page = MagicMock()
        mock_page.extract_text.return_value = text
        mock_pdf = MagicMock()
        mock_pdf.pages = [mock_page]
        mock_pdf.__enter__.return_value = mock_pdf
        mock_pdf.__exit__.return_value = None
        mock_open.return_value = mock_pdf

        result = parser.parse("plan.pdf")
        assert "Saver" in result.plan_name

    @patch("pdfplumber.open")
    def test_genesis_energy_charge_pattern(self, mock_open, parser):
        """Genesis-specific energy charge extraction."""
        text = """
Genesis Energy
Energy Charge 26.500 cents per kWh
Total: $80.00
"""
        mock_page = MagicMock()
        mock_page.extract_text.return_value = text
        mock_pdf = MagicMock()
        mock_pdf.pages = [mock_page]
        mock_pdf.__enter__.return_value = mock_pdf
        mock_pdf.__exit__.return_value = None
        mock_open.return_value = mock_pdf

        result = parser.parse("genesis_energy.pdf")
        assert result.c_per_kwh == 26.50

    @patch("pdfplumber.open")
    def test_handles_missing_fields(self, mock_open, parser):
        mock_page = MagicMock()
        mock_page.extract_text.return_value = "Genesis Energy bill\nTotal: $65.00"
        mock_pdf = MagicMock()
        mock_pdf.pages = [mock_page]
        mock_pdf.__enter__.return_value = mock_pdf
        mock_pdf.__exit__.return_value = None
        mock_open.return_value = mock_pdf

        result = parser.parse("minimal.pdf")
        assert result.retailer == "Genesis Energy"
        assert result.total_cents == 6500
