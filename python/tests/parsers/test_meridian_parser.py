"""Tests for Meridian Energy bill parser."""
from unittest.mock import patch, MagicMock

import pytest
from parsers.meridian_parser import MeridianParser
from parsers.base import parser_for_retailer


@pytest.fixture
def parser():
    return MeridianParser()


def _mock_pdf(text):
    """Build a pdfplumber.open MagicMock yielding *text*."""
    mock_page = MagicMock()
    mock_page.extract_text.return_value = text
    mock_pdf = MagicMock()
    mock_pdf.pages = [mock_page]
    mock_pdf.__enter__.return_value = mock_pdf
    mock_pdf.__exit__.return_value = None
    return mock_pdf


# ---------------------------------------------------------------------------
# Sample bill fixtures (anonymized, synthetic data)
# ---------------------------------------------------------------------------


SAMPLE_BILL_1 = """
Meridian Energy Limited

Account: 12345678-9
Customer: A. Ratepayer
Supply Address: 12 Kokiri Street, Hataitai, Wellington 6021
ICP: 000123456789ABC

Energy Online Plan

Billing period: 14 May 2026 to 13 Jun 2026

Your electricity usage
Total units: 612 kWh

Charges
Daily charge: 30 days @ 152.00 c/day = $228.00
Variable charge: 612 kWh @ 28.500 c/kWh = $174.42

Total to pay: $402.42
Includes GST of $52.40
"""


SAMPLE_BILL_2 = """
Meridian Energy

Account 99887766-5
J. Consumer
78 Seahorse Terrace, Sumner, Christchurch 8081
ICP 0000987654321XY

Good Energy

14 Apr 2026 - 13 May 2026

Usage summary
Total usage 450 kWh

Charges
Fixed daily charge 30 days @ 130.00 c/day = $156.00
Variable usage charge 450 kWh @ 25.40 c/kWh = $114.30

Total to pay: $270.30
GST $35.26
"""


SAMPLE_BILL_3 = """
Meridian Energy Limited

Account: 55443322-1
K. Watts
3 Pohutukawa Drive, Mission Bay, Auckland 1071
I.C.P.: 0000456789012QR

SimpleSaver

Billing period 14 Mar 2026 to 13 Apr 2026

Electricity used: 380 kWh

Charges
Daily charge 31 days @ 90.00 c/day = $89.10
Variable usage 380 kWh @ 26.30 c/kWh = $99.94

Total amount due: $189.04
GST included: $24.66
"""


SAMPLE_BILL_4 = """
Meridian

Account 11223344-5
B. Bright
200 Ridge Road, Howick, Auckland 2010
ICP: 0000789012345LM

NEO Plan

Period: 14 Feb 2026 to 13 Mar 2026

Your usage
Total units: 825 kWh

Your charges
Daily charge 28 days @ 200.000 c/day = $280.00
Variable usage charge 825 kWh @ 30.10 c/kWh = $248.33

Total to pay: $528.33
GST $68.87
"""


SAMPLE_BILL_5 = """
Meridian Energy Limited

Account: 66554433-2
T. Sunny
5 Beach Road, Devonport, Auckland 0624
ICP: 0000345678901ST

Energy Online Plan

14 Jan 2026 to 13 Feb 2026

Usage
Consumption: 290 kWh

Charges
Daily charge 31 days @ 150.00 c/day = $186.00
Variable charge 290 kWh @ 27.800 c/kWh = $80.62

Total to pay: $266.62
GST $34.78
"""


SAMPLE_BILL_DAY_NIGHT = """
Meridian Energy

Account 77889900-4
D. Shiftworker
41 Nightingale Lane, Karori, Wellington 6012
ICP: 0000210987654UV

Energy Online Day/Night

Billing period: 14 Dec 2025 to 13 Jan 2026

Day units: 410 kWh
Night units: 195 kWh
Total units: 605 kWh

Charges
Daily charge 31 days @ 180.00 c/day = $223.20
Day rate 410 kWh @ 29.500 c/kWh = $240.95
Night rate 195 kWh @ 14.200 c/kWh = $55.42

Total to pay: $519.57
GST $67.71
"""


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestMeridianParser:
    def test_parser_registered(self):
        # Importing parsers.meridian_parser triggers register_parser('meridian').
        import importlib

        importlib.import_module("parsers.meridian_parser")
        p = parser_for_retailer("meridian")
        assert p is not None
        assert isinstance(p, MeridianParser)

    def test_retailer_name(self, parser):
        assert parser.RETAILER_NAME == "Meridian Energy"
        assert parser.RETAILER_ID == "meridian"

    @patch("pdfplumber.open")
    def test_parses_canonical_bill_1(self, mock_open, parser):
        mock_open.return_value = _mock_pdf(SAMPLE_BILL_1)

        result = parser.parse("fake_meridian_bill_1.pdf")

        assert result.retailer == "Meridian Energy"
        assert result.icp_number == "000123456789ABC"
        assert result.usage_kwh == 612.0
        assert result.total_cents == 40242
        assert result.period_start == "2026-05-14"
        assert result.period_end == "2026-06-13"
        assert result.days == 31
        assert result.c_per_kwh == 28.50
        assert result.c_per_day == 152.0
        assert "Energy Online" in result.plan_name
        assert result.confidence >= 0.9

    @patch("pdfplumber.open")
    def test_parses_bill_2(self, mock_open, parser):
        mock_open.return_value = _mock_pdf(SAMPLE_BILL_2)

        result = parser.parse("fake_meridian_bill_2.pdf")

        assert result.retailer == "Meridian Energy"
        assert result.icp_number == "0000987654321XY"
        assert result.usage_kwh == 450.0
        assert result.total_cents == 27030
        assert result.period_start == "2026-04-14"
        assert result.period_end == "2026-05-13"
        assert result.c_per_kwh == 25.40
        assert result.c_per_day == 130.0
        assert "Good Energy" in result.plan_name
        assert result.confidence >= 0.9

    @patch("pdfplumber.open")
    def test_parses_bill_3_amount_due(self, mock_open, parser):
        """Bill uses 'Total amount due' rather than 'Total to pay'."""
        mock_open.return_value = _mock_pdf(SAMPLE_BILL_3)

        result = parser.parse("fake_meridian_bill_3.pdf")

        assert result.icp_number == "0000456789012QR"
        assert result.usage_kwh == 380.0
        assert result.total_cents == 18904
        assert result.period_end == "2026-04-13"
        assert result.c_per_kwh == 26.30
        assert result.c_per_day == 90.0
        assert "SimpleSaver" in result.plan_name
        assert result.confidence >= 0.9

    @patch("pdfplumber.open")
    def test_parses_bill_4(self, mock_open, parser):
        mock_open.return_value = _mock_pdf(SAMPLE_BILL_4)

        result = parser.parse("fake_meridian_bill_4.pdf")

        assert result.icp_number == "0000789012345LM"
        assert result.usage_kwh == 825.0
        assert result.total_cents == 52833
        assert result.period_start == "2026-02-14"
        assert result.period_end == "2026-03-13"
        assert result.c_per_kwh == 30.10
        assert result.c_per_day == 200.0
        assert "NEO" in result.plan_name
        assert result.confidence >= 0.9

    @patch("pdfplumber.open")
    def test_parses_bill_5(self, mock_open, parser):
        mock_open.return_value = _mock_pdf(SAMPLE_BILL_5)

        result = parser.parse("fake_meridian_bill_5.pdf")

        assert result.icp_number == "0000345678901ST"
        assert result.usage_kwh == 290.0
        assert result.total_cents == 26662
        assert result.period_start == "2026-01-14"
        assert result.period_end == "2026-02-13"
        assert result.c_per_kwh == 27.80
        assert result.c_per_day == 150.0
        assert "Energy Online" in result.plan_name
        assert result.confidence >= 0.9

    @patch("pdfplumber.open")
    def test_parses_day_night_bill(self, mock_open, parser):
        """Day/Night meter bill — meter_type should be 'day_night'."""
        mock_open.return_value = _mock_pdf(SAMPLE_BILL_DAY_NIGHT)

        result = parser.parse("fake_meridian_day_night.pdf")

        assert result.icp_number == "0000210987654UV"
        assert result.usage_kwh == 605.0
        assert result.total_cents == 51957
        assert result.period_end == "2026-01-13"
        assert result.c_per_day == 180.0
        assert result.meter_type == "day_night"
        assert result.confidence >= 0.9

    @patch("pdfplumber.open")
    def test_raises_on_empty_pdf(self, mock_open, parser):
        mock_open.return_value = _mock_pdf("")

        with pytest.raises(ValueError, match="No extractable text"):
            parser.parse("empty.pdf")

    @patch("pdfplumber.open")
    def test_handles_missing_fields_low_confidence(self, mock_open, parser):
        """A bare minimum bill with no ICP, dates, rates, or plan should
        parse without raising but produce low confidence."""
        mock_open.return_value = _mock_pdf(
            "Meridian Energy bill\nTotal to pay: $88.00\n"
        )

        result = parser.parse("minimal.pdf")

        assert result.retailer == "Meridian Energy"
        assert result.total_cents == 8800
        assert result.usage_kwh == 0.0
        assert result.confidence < 0.4

    @patch("pdfplumber.open")
    def test_break_fee_extraction(self, mock_open, parser):
        text = (
            "Meridian Energy\n"
            "ICP: 000123456789ABC\n"
            "Energy Online\n"
            "14 May 2026 to 13 Jun 2026\n"
            "Total units: 612 kWh\n"
            "Daily charge: 30 days @ 152.00 c/day\n"
            "Variable: 612 kWh @ 28.50 c/kWh\n"
            "Total to pay: $402.42\n"
            "Break fee: $199.00\n"
        )
        mock_open.return_value = _mock_pdf(text)

        result = parser.parse("break_fee.pdf")
        assert result.break_fee_cents == 19900
