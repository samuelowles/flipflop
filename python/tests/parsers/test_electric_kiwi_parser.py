"""Tests for Electric Kiwi bill parser.

Fixtures are synthetic/anonymized — fake ICPs (15-char), fake names, fake
amounts — covering the AC's required sample spread:
  1. Canonical (standard residential user)
  2. Low-user variation
  3. Day/night meter variation
  4. Edge / missing-field case
"""
from unittest.mock import patch, MagicMock

import pytest
from parsers.electric_kiwi_parser import ElectricKiwiParser


@pytest.fixture
def parser():
    return ElectricKiwiParser()


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
Electric Kiwi

Account number: 9876543
ICP: 000111222333EK1
Customer: Alex Sample
Supply Address: 12 Kiwi Road, Auckland

Plan: Kiwi Saver Plan

Billing period: 14 May 2026 to 13 Jun 2026

Your usage:
520 kWh

Charges:
Daily charge: 31 days @ 90.00 c/day = $27.90
Variable charge: 520 kWh @ 25.50 c/kWh = $132.60

Total amount due: $160.50

GST included: $20.94
"""

# 2. Low-user variation.
BILL_LOW_USER = """
Electric Kiwi

Your electricity bill

Customer: Jordan Fictional
ICP: 000444555666EK2
Supply Address: 78 Crescent Road, Christchurch

Plan: Stay Ahead Low User Plan

Billing period: 01 May 2026 to 31 May 2026

Your electricity usage:
Total units: 280 kWh

Charges:
Daily charge: 31 days @ 150.00 c/day = $46.50
Variable charge: 280 kWh @ 28.50 c/kWh = $79.80

Total amount due: $126.30

GST included: $16.48
"""

# 3. Day/night meter variation.
BILL_DAY_NIGHT = """
Electric Kiwi

Your electricity bill

Customer: Casey Nightuser
ICP: 000777888999EK3
Supply Address: 5 Dark Alley, Hamilton

Plan: On The Go Day/Night Plan

Billing period: 01 Jul 2026 to 31 Jul 2026

Day rate usage: 350 kWh
Night rate usage: 180 kWh
Total units: 530 kWh

Charges:
Daily charge: 31 days @ 95.00 c/day = $29.45
Variable charge: 530 kWh @ 23.50 c/kWh = $124.55

Total amount due: $154.00

GST included: $20.09
"""

# 4. Edge / missing-field case — minimal text, no ICP, no dates.
BILL_EDGE_MISSING = """
Electric Kiwi bill

Total: $75.00
"""

# 5. REAL production layout (anonymized, 2026-07 regression): statement page +
# tax-invoice page. Quirks that broke extraction on a real user's bill:
# ordinal dates with 2-digit years, $-denominated rates, no plan name, no
# "Total units" line (Peak/Off-peak/Hour of Power components only), and
# pdfplumber gluing left-column cells onto table rows — the address arrives
# as "Tax Invoice <addr>" and the Peak row as "<city> <postcode> Peak ...".
BILL_REAL_LAYOUT = """
Statement
OPENING BALANCE $418.59
Description Date Credit Debit Balance
Sam Sample
45 SAMPLE ROAD Payment - Thank you 1st Jul $418.59 $0.00
BEACH HAVEN
AUCKLAND 0626
New Power Charges $140.36 $140.36
Customer #:
12345678 Credit Card Surcharge $1.05 $141.41
Date:
TOTAL TO PAY $141.41
8th July 2026
Electric Kiwi Limited
GST #: 113-618-701
Tax Invoice 45 SAMPLE ROAD, BEACH HAVEN, AUCKLAND, 0626
Invoice #: 1234567890 ICP 000123456789EK9
POWER USAGE 24th Jun 26 - 2nd Jul 26 inclusive
Sam Sample
45 SAMPLE ROAD Description Usage Rate (incl GST) Total
BEACH HAVEN
AUCKLAND 0626 Peak Charges 98.31 kWh $0.5671/kWh $55.75
Off-peak Charges 175.62 kWh $0.4254/kWh $74.71
Customer #:
12345678 Hour of Power Savings 24.56 kWh FREE $0.00
Date:
Supply Charges 9 days $1.1000/day $9.90
8th July 2026
New Power Charges (Incl GST) $140.36
TOTAL NEW USAGE CHARGES - All Services $140.36
See statement on page 1 for final total due
"""


class TestElectricKiwiParser:
    def test_parser_registered(self):
        from parsers.base import parser_for_retailer

        p = parser_for_retailer("electric_kiwi")
        assert p is not None
        assert isinstance(p, ElectricKiwiParser)

    def test_retailer_name(self, parser):
        assert parser.RETAILER_NAME == "Electric Kiwi"
        assert parser.RETAILER_ID == "electric_kiwi"

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

        assert result.retailer == "Electric Kiwi"
        assert result.icp_number == "000111222333EK1"
        assert len(result.icp_number) == 15
        assert result.usage_kwh == 520.0
        assert result.total_cents == 16050
        assert result.period_start == "2026-05-14"
        assert result.period_end == "2026-06-13"
        assert result.days == 31
        assert result.c_per_kwh == 25.50
        assert result.c_per_day == 90.0
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

        assert result.retailer == "Electric Kiwi"
        assert result.icp_number == "000444555666EK2"
        assert len(result.icp_number) == 15
        assert result.meter_type == "low_user"
        assert result.usage_kwh == 280.0
        assert result.total_cents == 12630
        assert result.period_start == "2026-05-01"
        assert result.period_end == "2026-05-31"
        assert result.days == 31
        assert result.c_per_kwh == 28.50
        assert result.c_per_day == 150.0
        assert result.confidence >= 0.9

    # -----------------------------------------------------------------
    # AC: Day/night meter variation.
    # -----------------------------------------------------------------
    @patch("pdfplumber.open")
    def test_day_night_meter(self, mock_open, parser):
        mock_open.return_value = _mock_pdf(BILL_DAY_NIGHT)

        result = parser.parse("day_night.pdf")

        assert result.retailer == "Electric Kiwi"
        assert result.icp_number == "000777888999EK3"
        assert len(result.icp_number) == 15
        assert result.meter_type == "day_night"
        # Total units line preferred over day/night components.
        assert result.usage_kwh == 530.0
        assert result.total_cents == 15400
        assert result.c_per_kwh == 23.50
        assert result.c_per_day == 95.0
        assert result.period_start == "2026-07-01"
        assert result.period_end == "2026-07-31"
        assert result.confidence >= 0.9

    # -----------------------------------------------------------------
    # AC: Edge / missing-field case.
    # -----------------------------------------------------------------
    @patch("pdfplumber.open")
    def test_handles_missing_fields(self, mock_open, parser):
        mock_open.return_value = _mock_pdf(BILL_EDGE_MISSING)

        result = parser.parse("minimal.pdf")

        assert result.retailer == "Electric Kiwi"
        assert result.total_cents == 7500
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

    # -----------------------------------------------------------------
    # Real production layout regression (2026-07): the bill must clear
    # the 0.85 parsed threshold and yield pipeline-usable fields.
    # -----------------------------------------------------------------
    @patch("pdfplumber.open")
    def test_real_layout_regression(self, mock_open, parser):
        mock_open.return_value = _mock_pdf(BILL_REAL_LAYOUT)

        result = parser.parse("real_layout.pdf")

        # Confidence: must reach 'parsed' (this exact layout previously
        # scored 0.545 and stalled the pipeline at needs_review).
        assert result.confidence >= 0.85

        # Ordinal + 2-digit-year date range: "24th Jun 26 - 2nd Jul 26".
        assert result.period_start == "2026-06-24"
        assert result.period_end == "2026-07-02"
        assert result.days == 9

        # Usage = Peak + Off-peak + Hour of Power (free kWh is consumption).
        assert result.usage_kwh == pytest.approx(298.49)

        # $-denominated peak rate -> cents.
        assert result.c_per_kwh == pytest.approx(56.71)
        assert result.c_per_day == pytest.approx(110.0)

        # Power charges, not the card-surcharge-inflated statement total.
        assert result.total_cents == 14036

        # Peak/Off-peak TOU is day_night — NOT controlled ("Off Peak" would
        # otherwise false-match the controlled-load pattern).
        assert result.meter_type == "day_night"

        # Address recovered from the glued "Tax Invoice <addr>" line, with
        # the comma-before-postcode normalised away.
        assert result.address == "45 SAMPLE ROAD, BEACH HAVEN, AUCKLAND 0626"

        assert result.icp_number == "000123456789EK9"
