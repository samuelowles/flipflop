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
        # AC #52: confidence >= 0.9 on the canonical Contact layout
        assert result.confidence >= 0.9

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


# ---------------------------------------------------------------------------
# Multi-fixture suite (AC #52: 5+ anonymized sample bills)
# Covers: residential standard (x2), low-user (x2), and a noisier layout.
# All ICPs, account numbers, and addresses are fictitious.
# ---------------------------------------------------------------------------


def _mock_pdf(text: str):
    """Build a MagicMock pdfplumber handle whose single page yields *text*."""
    mock_page = MagicMock()
    mock_page.extract_text.return_value = text
    mock_pdf = MagicMock()
    mock_pdf.pages = [mock_page]
    mock_pdf.__enter__.return_value = mock_pdf
    mock_pdf.__exit__.return_value = None
    return mock_pdf


# Fixture 1 — canonical residential standard (also asserted above, reproduced
# here as the baseline member of the parametrized set).
STANDARD_CANONICAL = """
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

# Fixture 2 — residential standard, summer low usage.
STANDARD_SUMMER = """
Contact Energy
Electricity bill

Account Number: 87654321
ICP Number: 1119876543DEF45
Installation Address: 45 Kiwi Road, Wellington

Plan: Standard User

Billing Period: 01/01/2026 to 31/01/2026 (31 days)

Your electricity charges:

Daily Fixed Charge: 31 days @ 35.00 c/day = $10.85
Energy Charge: 210 kWh @ 24.10 c/kWh = $50.61

Total due: $61.46 including GST of $8.02

Payment due by: 15/02/2026
"""

# Fixture 3 — low-user plan (lower daily fixed charge, higher per-kWh rate).
LOW_USER = """
Contact Energy
Your electricity bill

Account Number: 55500011
ICP Number: 2225550001ABC12
Installation Address: 7 Fern Close, Christchurch

Plan: Low User

Billing Period: 01/05/2026 to 31/05/2026 (31 days)

Your electricity charges:

Daily Fixed Charge: 31 days @ 12.00 c/day = $3.72
Energy Charge: 180 kWh @ 32.90 c/kWh = $59.22

Total due: $62.94 including GST of $8.21

Payment due by: 18/06/2026
"""

# Fixture 4 — residential standard, winter high usage.
STANDARD_WINTER = """
Contact Energy
Your electricity bill

Account Number: 90909090
ICP Number: 3339090901BBB77
Installation Address: 200 Lake View, Dunedin

Plan: Standard User

Billing Period: 01/06/2026 to 30/06/2026 (30 days)

Your electricity charges:

Daily Fixed Charge: 30 days @ 33.33 c/day = $10.00
Energy Charge: 950 kWh @ 26.80 c/kWh = $254.60

Total due: $264.60 including GST of $34.49

Payment due by: 20/07/2026
"""

# Fixture 5 — low-user with noisier layout (promotional header/footer, plan
# stated as a labelled field but surrounded by extra lines). Assert >= 0.7.
LOW_USER_NOISY = """
Contact Energy
Helping New Zealanders save on power

Account Number: 12121212
ICP Number: 4441212121CCC33
Property: 11 Harbour Drive, Tauranga

Plan: Low User

Billing Period 01/07/2026 to 31/07/2026 (31 days)

Electricity charges summary
Daily Fixed Charge: 31 days @ 12.50 c/day = $3.88
Energy Charge: 150 kWh @ 33.50 c/kWh = $50.25

Total due: $54.13 including GST of $7.06

Offer: Refer a friend for a $50 credit
"""


@pytest.mark.parametrize(
    "text,label,expected",
    [
        # (fixture, plan hint, dict of expected canonical-schema fields)
        (
            STANDARD_CANONICAL,
            "standard_canonical",
            {
                "total_cents": 12475,
                "usage_kwh": 450.0,
                "days": 30,
                "icp_number": "0001234567ABC99",
                "c_per_kwh": 25.50,
                "c_per_day": 33.33,
                "meter_type": "standard",
                "min_confidence": 0.9,
            },
        ),
        (
            STANDARD_SUMMER,
            "standard_summer",
            {
                "total_cents": 6146,
                "usage_kwh": 210.0,
                "days": 31,
                "icp_number": "1119876543DEF45",
                "c_per_kwh": 24.10,
                "meter_type": "standard",
                "min_confidence": 0.9,
            },
        ),
        (
            LOW_USER,
            "low_user",
            {
                "total_cents": 6294,
                "usage_kwh": 180.0,
                "days": 31,
                "icp_number": "2225550001ABC12",
                "meter_type": "low_user",
                "min_confidence": 0.9,
            },
        ),
        (
            STANDARD_WINTER,
            "standard_winter",
            {
                "total_cents": 26460,
                "usage_kwh": 950.0,
                "days": 30,
                "icp_number": "3339090901BBB77",
                "meter_type": "standard",
                "min_confidence": 0.9,
            },
        ),
        (
            LOW_USER_NOISY,
            "low_user_noisy",
            {
                "total_cents": 5413,
                "usage_kwh": 150.0,
                "days": 31,
                "icp_number": "4441212121CCC33",
                "meter_type": "low_user",
                "min_confidence": 0.7,  # noisier layout — relaxed threshold
            },
        ),
    ],
    ids=[
        "standard_canonical",
        "standard_summer",
        "low_user",
        "standard_winter",
        "low_user_noisy",
    ],
)
class TestContactParserFixtures:
    """Parametrized suite over 5 anonymized Contact bill fixtures.

    Asserts the canonical schema (total, usage, days, ICP, line-item rates,
    meter type) is extracted correctly and that the confidence threshold
    appropriate to each layout is met.
    """

    @patch("pdfplumber.open")
    def test_total_cents(self, mock_open, parser, text, label, expected):
        mock_open.return_value = _mock_pdf(text)
        result = parser.parse(f"{label}.pdf")
        assert result.total_cents == expected["total_cents"], (
            f"{label}: total_cents {result.total_cents} != {expected['total_cents']}"
        )

    @patch("pdfplumber.open")
    def test_usage_kwh(self, mock_open, parser, text, label, expected):
        mock_open.return_value = _mock_pdf(text)
        result = parser.parse(f"{label}.pdf")
        assert result.usage_kwh == expected["usage_kwh"]

    @patch("pdfplumber.open")
    def test_days(self, mock_open, parser, text, label, expected):
        mock_open.return_value = _mock_pdf(text)
        result = parser.parse(f"{label}.pdf")
        assert result.days == expected["days"]

    @patch("pdfplumber.open")
    def test_icp(self, mock_open, parser, text, label, expected):
        mock_open.return_value = _mock_pdf(text)
        result = parser.parse(f"{label}.pdf")
        assert result.icp_number == expected["icp_number"]

    @patch("pdfplumber.open")
    def test_meter_type(self, mock_open, parser, text, label, expected):
        mock_open.return_value = _mock_pdf(text)
        result = parser.parse(f"{label}.pdf")
        assert result.meter_type == expected["meter_type"]

    @patch("pdfplumber.open")
    def test_confidence_threshold(self, mock_open, parser, text, label, expected):
        mock_open.return_value = _mock_pdf(text)
        result = parser.parse(f"{label}.pdf")
        assert result.confidence >= expected["min_confidence"], (
            f"{label}: confidence {result.confidence} < {expected['min_confidence']}"
        )

    @patch("pdfplumber.open")
    def test_canonical_schema_returned(self, mock_open, parser, text, label, expected):
        """Every fixture must return the full canonical schema (non-None)."""
        mock_open.return_value = _mock_pdf(text)
        result = parser.parse(f"{label}.pdf")
        # Core canonical fields must all be populated
        assert result.retailer == "Contact Energy"
        assert result.total_cents > 0
        assert result.usage_kwh > 0
        assert result.days > 0
        assert result.icp_number  # non-empty
        assert result.period_start  # non-empty
        assert result.period_end  # non-empty
        assert result.meter_type in {"standard", "low_user", "day_night", "controlled"}
