"""Tests for Trustpower bill parser."""
from unittest.mock import patch, MagicMock

import pytest
from parsers.trustpower_parser import TrustpowerParser


@pytest.fixture
def parser():
    return TrustpowerParser()


@pytest.fixture
def sample_trustpower_text():
    # Canonical Trustpower layout — all key fields present incl. meter signal.
    return """
Trustpower

Your Electricity Bill

Customer: Alex Sample
Account Number: TP-10023456-01
ICP: 000123456789ABC
Supply Address: 12 Korimako Lane, Wellington

Trustpower Energy Online Plan

Supply period: 14 May 2026 to 13 Jun 2026

Electricity charges (Day/Night meter):
Total units: 610 kWh
Variable charge: 610 kWh @ 26.50 c/kWh = $161.65
Daily charge: 31 days @ 95.00 c/day = $29.45

Total amount due: $191.10

GST included: $24.93
"""


def _mock_pdf(text):
    mock_page = MagicMock()
    mock_page.extract_text.return_value = text
    mock_pdf = MagicMock()
    mock_pdf.pages = [mock_page]
    mock_pdf.__enter__.return_value = mock_pdf
    mock_pdf.__exit__.return_value = None
    return mock_pdf


class TestTrustpowerParser:
    def test_parser_registered(self):
        from parsers.base import parser_for_retailer

        p = parser_for_retailer("trustpower")
        assert p is not None
        assert isinstance(p, TrustpowerParser)

    def test_retailer_name(self, parser):
        assert parser.RETAILER_NAME == "Trustpower"
        assert parser.RETAILER_ID == "trustpower"

    @patch("pdfplumber.open")
    def test_parses_canonical_bill(self, mock_open, parser, sample_trustpower_text):
        mock_open.return_value = _mock_pdf(sample_trustpower_text)

        result = parser.parse("fake_trustpower_bill.pdf")

        assert result.retailer == "Trustpower"
        assert result.icp_number == "000123456789ABC"
        assert result.usage_kwh == 610.0
        assert result.total_cents == 19110
        assert result.period_start == "2026-05-14"
        assert result.period_end == "2026-06-13"
        assert result.c_per_kwh == 26.50
        assert result.c_per_day == 95.0
        assert "Trustpower" in result.plan_name
        assert result.days == 31
        # AC: confidence >= 0.9 on canonical Trustpower layout
        assert result.confidence >= 0.9

    @patch("pdfplumber.open")
    def test_low_user_bill(self, mock_open, parser):
        text = """
Trustpower

Your Electricity Bill

Customer: Jamie Example
ICP: 000987654321XYZ
Supply Address: 8 Tui Street, Christchurch

Trustpower Standard Plan

Supply period: 01 Apr 2026 to 30 Apr 2026

Low User electricity charges:
Total units: 540 kWh
Variable charge: 540 kWh @ 22.10 c/kWh = $119.34
Daily charge: 30 days @ 65.00 c/day = $19.50

Total amount due: $138.84
"""
        mock_open.return_value = _mock_pdf(text)

        result = parser.parse("low_user.pdf")

        assert result.icp_number == "000987654321XYZ"
        assert result.usage_kwh == 540.0
        assert result.total_cents == 13884
        assert result.period_start == "2026-04-01"
        assert result.period_end == "2026-04-30"
        assert result.c_per_kwh == 22.10
        assert result.c_per_day == 65.0
        assert result.days == 30
        assert result.confidence >= 0.9

    @patch("pdfplumber.open")
    def test_day_night_bill(self, mock_open, parser):
        text = """
Trustpower

Account: TP-558822-09
ICP: 000111222333CCC

Trustpower Stay On Plan

Billing period: 15 Mar 2026 to 14 Apr 2026

Electricity (Day/Night):
Total units: 600 kWh
Day units: 320 kWh @ 28.90 c/kWh
Night units: 280 kWh

Daily charge: 31 days @ 120.00 c/day

Total amount due: $215.40
"""
        mock_open.return_value = _mock_pdf(text)

        result = parser.parse("day_night.pdf")

        assert result.meter_type == "day_night"
        assert result.usage_kwh == 600.0
        assert result.total_cents == 21540
        assert result.c_per_day == 120.0
        assert result.days == 31
        assert result.confidence >= 0.5

    @patch("pdfplumber.open")
    def test_controlled_meter_bill(self, mock_open, parser):
        text = """
Trustpower

Customer: Pat Sample
ICP: 000444555666DDD

Trustpower Everyday Plan

Supply period: 01 Jun 2026 to 30 Jun 2026

Controlled load:
Total units: 450 kWh
Variable charge: 450 kWh @ 19.95 c/kWh = $89.78
Daily charge: 30 days @ 85.00 c/day = $25.50

Amount due: $115.28
"""
        mock_open.return_value = _mock_pdf(text)

        result = parser.parse("controlled.pdf")

        assert result.meter_type == "controlled"
        assert result.usage_kwh == 450.0
        assert result.total_cents == 11528
        assert result.days == 30
        assert result.confidence >= 0.5

    @patch("pdfplumber.open")
    def test_iso_date_format_bill(self, mock_open, parser):
        text = """
Trustpower

ICP: 000777888999EEE

Trustpower Energy Plan

Billing period: 2026-05-01 to 2026-05-31

Electricity (Day/Night meter):
Total units: 720 kWh
Variable charge: 720 kWh @ 25.00 c/kWh = $180.00
Daily charge: 31 days @ 90.00 c/day = $27.90

Total amount due: $207.90
"""
        mock_open.return_value = _mock_pdf(text)

        result = parser.parse("iso_dates.pdf")

        assert result.period_start == "2026-05-01"
        assert result.period_end == "2026-05-31"
        assert result.usage_kwh == 720.0
        assert result.total_cents == 20790
        assert result.days == 31
        assert result.confidence >= 0.9

    @patch("pdfplumber.open")
    def test_trustpower_plan_name_extraction(self, mock_open, parser):
        text = "Trustpower Online Plan\nTotal: $100.00"
        mock_open.return_value = _mock_pdf(text)

        result = parser.parse("plan.pdf")
        assert "Trustpower" in result.plan_name

    @patch("pdfplumber.open")
    def test_raises_on_empty_pdf(self, mock_open, parser):
        mock_open.return_value = _mock_pdf("")

        with pytest.raises(ValueError, match="No extractable text"):
            parser.parse("empty.pdf")

    @patch("pdfplumber.open")
    def test_raises_on_garbage_pdf(self, mock_open, parser):
        mock_open.return_value = _mock_pdf("\x00\x01garbage\x02no bill data here\x03")

        result = parser.parse("garbage.pdf")
        assert result.retailer == "Trustpower"
        assert result.confidence < 0.4

    @patch("pdfplumber.open")
    def test_handles_missing_fields(self, mock_open, parser):
        mock_open.return_value = _mock_pdf("Trustpower bill\nTotal: $75.00")

        result = parser.parse("minimal.pdf")
        assert result.retailer == "Trustpower"
        assert result.total_cents == 7500
        assert result.confidence < 0.4

    @patch("pdfplumber.open")
    def test_break_fee_extraction(self, mock_open, parser):
        text = """
Trustpower

ICP: 000123456789ABC
Supply period: 14 May 2026 to 13 Jun 2026

Total units: 610 kWh
Variable charge: 610 kWh @ 26.50 c/kWh = $161.65
Daily charge: 31 days @ 95.00 c/day = $29.45

Total amount due: $191.10

Break fee: $150.00
"""
        mock_open.return_value = _mock_pdf(text)

        result = parser.parse("break_fee.pdf")
        assert result.break_fee_cents == 15000
