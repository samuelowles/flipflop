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
Daily charge: 90.00 c/day
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
        # Honest field-coverage scoring: one matched field (total) out of 11
        # scores low — a near-empty bill must not look confident.
        assert result.confidence < 0.2

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


# ---------------------------------------------------------------------------
# Issue #51 acceptance criteria: 5+ anonymized sample bill texts covering the
# required scenarios. All texts are synthetic (no real PII / ICPs / account
# numbers). Asserts detected fields and that the returned object matches the
# canonical ParserResult schema.
#
# Confidence contract (superseding #51's [0.5, 0.8) band): the generic parser
# is now the PRIMARY parser for all bill types, scoring honest field coverage
# (fields_found / 11, same formula as retailer parsers) — a rich bill can
# clear the 0.85 'parsed' threshold, and garbage scores near zero instead of
# being inflated to a 0.5 floor.
# ---------------------------------------------------------------------------

# Canonical schema fields every parser (retailer-specific or generic) returns.
_PARSER_RESULT_FIELDS = {
    "retailer", "plan_name", "meter_type", "icp_number", "period_start",
    "period_end", "days", "usage_kwh", "total_cents", "c_per_kwh",
    "c_per_day", "fixed_term_expiry", "break_fee_cents", "confidence",
    "raw_json", "parser_used", "address",
}


def _make_pdf_mock(text):
    """Build a pdfplumber.open mock returning *text* for a single page."""
    mock_page = MagicMock()
    mock_page.extract_text.return_value = text
    mock_pdf = MagicMock()
    mock_pdf.pages = [mock_page]
    mock_pdf.__enter__.return_value = mock_pdf
    mock_pdf.__exit__.return_value = None
    return mock_pdf


# (scenario_id, bill_text) — anonymized fixtures inline (no real customer data).
_SAMPLE_BILLS = [
    (
        "clean_full_bill",
        # All four target fields (total, usage, days via period, ICP) present.
        """Account statement
ICP: 0001234567ABC99
Billing period: 2026-04-01 to 2026-04-30
Usage: 650 kWh
Energy charge: 26.00 c/kWh
Daily charge: 90.00 c/day
Total amount due: $220.00
""",
    ),
    (
        "missing_icp",
        # Total, usage, period present; ICP absent (best-effort ICP -> "").
        """Electricity invoice
Billing period: 2026-05-01 to 2026-05-29
Usage: 580 kWh
Total due: $195.50
""",
    ),
    (
        "missing_usage",
        # Total, ICP, period present; usage line absent (usage_kwh -> 0.0).
        """Power bill
ICP: 0009876543XYZ12
Period: 2026-06-01 to 2026-06-30
Total amount due: $180.00
""",
    ),
    (
        "minimal_partial",
        # Only a total present; everything else missing.
        """Random retailer statement
Total: $88.40
""",
    ),
    (
        "unparseable_blob",
        # Text exists but no bill fields recognizable -> confidence floor (0.5).
        """lorem ipsum dolor sit amet consectetur adipiscing elit
sed do eiusmod tempor incididunt ut labore et dolore magna aliqua
ut enim ad minim veniam quis nostrud exercitation ullamco laboris
""",
    ),
]


@pytest.mark.parametrize("scenario_id,bill_text", _SAMPLE_BILLS)
@patch("pdfplumber.open")
def test_issue51_sample_bills(mock_open, parser, scenario_id, bill_text):
    """Issue #51 AC: 5+ sample PDFs covering clean / missing-ICP /
    missing-usage / minimal / unparseable scenarios."""
    mock_open.return_value = _make_pdf_mock(bill_text)

    result = parser.parse("sample.pdf")

    # --- Canonical schema (same shape as per-retailer parsers) ---
    result_dict = result.__dict__
    assert set(result_dict.keys()) == _PARSER_RESULT_FIELDS, (
        f"{scenario_id}: schema mismatch — generic parser must return the "
        f"canonical ParserResult fields"
    )

    # --- Confidence: honest field coverage — monotone in extracted fields,
    # near zero on garbage, high on rich bills.
    assert 0.0 <= result.confidence <= 1.0

    # --- Per-scenario field assertions ---
    if scenario_id == "clean_full_bill":
        assert result.icp_number == "0001234567ABC99"
        assert result.usage_kwh == 650.0
        assert result.total_cents == 22000
        assert result.days == 30
        assert result.confidence >= 0.7  # 8/11 fields
    elif scenario_id == "missing_icp":
        assert result.icp_number == ""
        assert result.usage_kwh == 580.0
        assert result.total_cents == 19550
        assert result.days > 0
        assert 0.3 <= result.confidence < 0.85  # partial bill must NOT parse
    elif scenario_id == "missing_usage":
        assert result.icp_number == "0009876543XYZ12"
        assert result.usage_kwh == 0.0
        assert result.total_cents == 18000
        assert result.days == 30
        assert 0.3 <= result.confidence < 0.85
    elif scenario_id == "minimal_partial":
        # Only total is reliably extractable.
        assert result.total_cents == 8840
        assert result.icp_number == ""
        assert result.confidence < 0.2
    elif scenario_id == "unparseable_blob":
        # No fields detected -> confidence 0.0, not an inflated floor.
        assert result.confidence == 0.0
        assert result.total_cents == 0
        assert result.usage_kwh == 0.0
        assert result.icp_number == ""


def test_generic_can_reach_parsed_threshold(parser):
    """One-parser goal: a fully-extractable bill through the GENERIC parser
    must be able to clear the worker's 0.85 'parsed' threshold — the old
    0.8 ceiling made generic-only parses dead-end at needs_review."""
    total_fields = 11
    generic_ceiling = min(1.0, total_fields / total_fields)
    assert generic_ceiling >= 0.85


# ---------------------------------------------------------------------------
# Real production layouts through the GENERIC parser (one-parser goal): both
# must clear the 0.85 'parsed' threshold with correct fields, no retailer
# hint needed. Texts are anonymized mirrors of real bills.
# ---------------------------------------------------------------------------

# Real Contact Energy layout quirks: no "Contact Energy" token anywhere
# (detection anchors on contact.co.nz / "choosing Contact"), an
# arrears-inclusive "Total amount due" that must LOSE to "Total current
# charges", "dollars per day" daily rate, and the address glued mid-line
# after "Energy used by".
CONTACT_REAL_LAYOUT = """
Support
Your bill for 17 Aug 2021 to 23 Aug 2021
To view and manage your account, use our app or sign
in to My Account at contact.co.nz/myaccount. Tax Invoice/Statement
Invoice number 9999999999
Statement date 24 Aug 2021
Mx S Sample
Flat 1/240 Sample Road
Birkenhead
Auckland 0626
Your account number
Previous activity Charges Credits
509999999 Previous balance $389.71
Thanks for choosing Contact Total previous charges $389.71
Summary of Current activity Charges Credits
Fixed daily charges $12.38
Account name(s) Variable charges $77.26
GST $13.45
Mx S Sample
Total current charges $103.09
Total amount due - please pay by 7 Sep 2021 $492.80
Energy used by Flat 1/240 Sample Road, Birkenhead, Auckland 0626 - installation connection point (ICP) 0000211257UN0BA from
17 Aug 21 to 23 Aug 21 (7 days)
Electricity 209999999:1 23 Aug 21 114444 114895 451 451kWh
Fixed daily charges
Daily Charge 7 days @ 1.768 dollars per day $12.38
Variable charges
All Day Economy 451 kWh @ 17.000 cents per kWh $76.67
Electricity Authority Levy 451 kWh @ 0.130 cent per kWh $0.59
"""


@patch("pdfplumber.open")
def test_real_contact_layout_via_generic(mock_open, parser):
    mock_open.return_value = _make_pdf_mock(CONTACT_REAL_LAYOUT)

    result = parser.parse("contact_real.pdf")

    assert result.confidence >= 0.85, f"got {result.confidence:.3f}"
    assert result.retailer == "Contact Energy"
    assert result.period_start == "2021-08-17"
    assert result.period_end == "2021-08-23"
    assert result.days == 7
    assert result.usage_kwh == 451.0
    # Current-period charges — NOT the arrears-inclusive $492.80.
    assert result.total_cents == 10309
    assert result.c_per_kwh == 17.0
    assert result.c_per_day == pytest.approx(176.8)
    assert result.icp_number == "0000211257UN0BA"
    assert result.address == "1/240 Sample Road, Birkenhead, Auckland 0626"


@patch("pdfplumber.open")
def test_real_electric_kiwi_layout_via_generic(mock_open, parser):
    from tests.parsers.test_electric_kiwi_parser import BILL_REAL_LAYOUT

    mock_open.return_value = _make_pdf_mock(BILL_REAL_LAYOUT)

    result = parser.parse("ek_real.pdf")

    assert result.confidence >= 0.85, f"got {result.confidence:.3f}"
    assert result.retailer == "Electric Kiwi"
    assert result.usage_kwh == pytest.approx(298.49)
    assert result.total_cents == 14036
    assert result.days == 9
    assert result.meter_type == "day_night"
    # The loose plan pattern must NOT surface footer prose as a plan name.
    assert result.plan_name == "Unknown"
    assert result.address == "45 SAMPLE ROAD, BEACH HAVEN, AUCKLAND 0626"
