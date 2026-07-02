"""Tests for Nova Energy bill parser."""
from unittest.mock import patch, MagicMock

import pytest
from parsers.nova_parser import NovaParser


@pytest.fixture
def parser():
    return NovaParser()


# ---------------------------------------------------------------------------
# Sample bill texts (anonymized — fake ICPs, names, amounts)
# ---------------------------------------------------------------------------

CANONICAL_BILL = """
Nova Energy

Account: 12345678
Customer: A. Ratepayer
Supply Address: 12 Example Lane, Wellington

Nova Stay Ahead Plan

ICP: 000111222333ABC

Billing period: 14 May 2026 to 13 Jun 2026

Total energy used: 480 kWh

Charges:
Daily charge: 30 days @ 95.00 c/day = $28.50
Day Rate: 300 kWh @ 28.10 c/kWh = $84.30
Night Rate: 180 kWh @ 18.40 c/kWh = $33.12
Variable charge: 480 kWh @ 26.50 c/kWh = $127.20

Amount to pay: $155.70

GST included: $20.30
"""

BILL_LOW_USER = """
Nova Energy

Account: 87654321
Customer: B. Saver
Supply Address: 88 Test Street, Auckland

Nova Saver Plan (Low User)

ICP: 000444555666XYZ

Billing period: 01 May 2026 to 31 May 2026

Total energy used: 210 kWh

Daily charge: 31 days @ 150.00 c/day = $46.50
Variable charge: 210 kWh @ 22.10 c/kWh = $46.41

Total amount due: $92.91

GST included: $12.12
"""

BILL_DAY_NIGHT = """
Nova Energy

Account: 55500011
Customer: C. Nightowl
Supply Address: 3 Sample Road, Christchurch

Nova Standard Plan

ICP: 000777888999QQQ

Billing period: 01 April 2026 to 30 April 2026

Total energy used: 620 kWh

Day Rate: 400 kWh @ 28.90 c/kWh = $115.60
Night Rate: 220 kWh @ 14.50 c/kWh = $31.90
Daily charge: 30 days @ 85.00 c/day = $25.50

Amount to pay: $173.00
"""

BILL_MINIMAL = """
Nova Energy
Account: 99
Customer: D. Minimal
Nova Flex Plan
ICP: 000123456789AAA
Billing period: 01 May 2026 to 31 May 2026
Total energy used: 350 kWh
Daily charge: 90.00 c/day
Variable charge: 25.00 c/kWh
Amount to pay: $180.00
"""

BILL_NO_PLAN = """
Nova Energy
Account: 7788
Customer: E. Noplan
ICP: 000987654321ZZZ
Billing period: 01 Mar 2026 to 31 Mar 2026
Total energy used: 410 kWh
Daily charge: 100.00 c/day
Variable charge: 27.30 c/kWh
Total amount due: $211.43
"""

BILL_GARBAGE = "Nova Energy\nTotal: $50.00\nsome random text without structure"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _mock_pdf(text: str) -> MagicMock:
    mock_page = MagicMock()
    mock_page.extract_text.return_value = text
    mock_pdf = MagicMock()
    mock_pdf.pages = [mock_page]
    mock_pdf.__enter__.return_value = mock_pdf
    mock_pdf.__exit__.return_value = None
    return mock_pdf


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestNovaParser:
    def test_parser_registered(self):
        """Importing nova_parser registers it for retailer 'nova'."""
        import parsers.nova_parser  # noqa: F401  (ensure registration side-effect)
        from parsers.base import parser_for_retailer

        p = parser_for_retailer("nova")
        assert p is not None
        assert isinstance(p, NovaParser)

    def test_retailer_name(self, parser):
        assert parser.RETAILER_NAME == "Nova Energy"
        assert parser.RETAILER_ID == "nova"

    @patch("pdfplumber.open")
    def test_canonical_bill_all_fields(self, mock_open, parser):
        """Canonical Nova layout → all key ParserResult fields, confidence >= 0.9."""
        mock_open.return_value = _mock_pdf(CANONICAL_BILL)

        result = parser.parse("fake_nova_canonical.pdf")

        assert result.retailer == "Nova Energy"
        # ICP 15-digit
        assert result.icp_number == "000111222333ABC"
        assert len(result.icp_number) == 15
        # Usage
        assert result.usage_kwh == 480.0
        # Total (Nova "Amount to pay")
        assert result.total_cents == 15570
        # Period dates (ISO 8601)
        assert result.period_start == "2026-05-14"
        assert result.period_end == "2026-06-13"
        assert result.days == 31  # inclusive May 14 -> Jun 13
        # Rates (day rate surfaces as the headline c_per_kwh on a day/night bill)
        assert result.c_per_kwh == 28.10
        assert result.c_per_day == 95.0
        # Plan
        assert "Stay Ahead" in result.plan_name
        # Meter type detected from Day/Night rate lines
        assert result.meter_type == "day_night"
        # Confidence ≥ 0.9 on canonical layout
        assert result.confidence >= 0.9, f"confidence {result.confidence} < 0.9"

    @patch("pdfplumber.open")
    def test_low_user_bill(self, mock_open, parser):
        mock_open.return_value = _mock_pdf(BILL_LOW_USER)

        result = parser.parse("nova_low_user.pdf")

        assert result.icp_number == "000444555666XYZ"
        assert result.usage_kwh == 210.0
        assert result.total_cents == 9291
        assert result.period_start == "2026-05-01"
        assert result.period_end == "2026-05-31"
        assert result.days == 31
        assert result.c_per_kwh == 22.10
        assert result.c_per_day == 150.0
        assert "Saver" in result.plan_name
        assert result.meter_type == "low_user"
        assert result.confidence >= 0.9

    @patch("pdfplumber.open")
    def test_day_night_meter_type(self, mock_open, parser):
        mock_open.return_value = _mock_pdf(BILL_DAY_NIGHT)

        result = parser.parse("nova_day_night.pdf")

        assert result.meter_type == "day_night"
        assert result.usage_kwh == 620.0
        assert result.total_cents == 17300
        assert result.days == 30
        assert "Standard" in result.plan_name
        assert result.confidence >= 0.9

    @patch("pdfplumber.open")
    def test_minimal_bill(self, mock_open, parser):
        mock_open.return_value = _mock_pdf(BILL_MINIMAL)

        result = parser.parse("nova_minimal.pdf")

        assert result.retailer == "Nova Energy"
        assert result.icp_number == "000123456789AAA"
        assert result.usage_kwh == 350.0
        assert result.total_cents == 18000
        assert result.period_start == "2026-05-01"
        assert result.period_end == "2026-05-31"
        assert "Flex" in result.plan_name

    @patch("pdfplumber.open")
    def test_no_plan_falls_back(self, mock_open, parser):
        mock_open.return_value = _mock_pdf(BILL_NO_PLAN)

        result = parser.parse("nova_no_plan.pdf")

        assert result.total_cents == 21143
        assert result.usage_kwh == 410.0
        assert result.icp_number == "000987654321ZZZ"
        # Plan falls back to "Unknown" when no Nova plan keyword present
        assert result.plan_name == "Unknown"

    @patch("pdfplumber.open")
    def test_raises_on_empty_pdf(self, mock_open, parser):
        mock_open.return_value = _mock_pdf("")

        with pytest.raises(ValueError, match="No extractable text"):
            parser.parse("empty.pdf")

    @patch("pdfplumber.open")
    def test_garbage_pdf_low_confidence(self, mock_open, parser):
        mock_open.return_value = _mock_pdf(BILL_GARBAGE)

        result = parser.parse("garbage.pdf")

        assert result.retailer == "Nova Energy"
        assert result.confidence < 0.5

    @patch("pdfplumber.open")
    def test_amount_to_pay_preferred_over_total(self, mock_open, parser):
        """Nova 'Amount to pay' must win over a stray 'Total' line."""
        text = (
            "Nova Energy\n"
            "ICP: 000111222333ABC\n"
            "Billing period: 01 May 2026 to 31 May 2026\n"
            "Total energy used: 300 kWh\n"
            "Previous balance: $50.00\n"
            "Amount to pay: $99.99\n"
        )
        mock_open.return_value = _mock_pdf(text)

        result = parser.parse("nova_priority.pdf")

        assert result.total_cents == 9999
