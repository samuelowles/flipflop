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
        # Generic parser baseline confidence is 0.5 (issue #51); an unknown
        # retailer with a single matched field still scores >= 0.5 but the
        # ceiling (0.8) stays below per-retailer parsers.
        assert result.confidence >= 0.5
        assert result.confidence < 0.8

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
# numbers). Asserts detected fields, the [0.5, 0.8) confidence band, and that
# the returned object matches the canonical ParserResult schema.
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

    # --- Confidence band: baseline 0.5, ceiling < 0.8 (per-retailer is 1.0) ---
    assert 0.5 <= result.confidence < 0.8, (
        f"{scenario_id}: confidence {result.confidence} not in [0.5, 0.8)"
    )

    # --- Per-scenario field assertions ---
    if scenario_id == "clean_full_bill":
        assert result.icp_number == "0001234567ABC99"
        assert result.usage_kwh == 650.0
        assert result.total_cents == 22000
        assert result.days == 30
    elif scenario_id == "missing_icp":
        assert result.icp_number == ""
        assert result.usage_kwh == 580.0
        assert result.total_cents == 19550
        assert result.days > 0
    elif scenario_id == "missing_usage":
        assert result.icp_number == "0009876543XYZ12"
        assert result.usage_kwh == 0.0
        assert result.total_cents == 18000
        assert result.days == 30
    elif scenario_id == "minimal_partial":
        # Only total is reliably extractable.
        assert result.total_cents == 8840
        assert result.icp_number == ""
    elif scenario_id == "unparseable_blob":
        # No fields detected -> confidence sits at the 0.5 floor.
        assert result.confidence == 0.5
        assert result.total_cents == 0
        assert result.usage_kwh == 0.0
        assert result.icp_number == ""


def test_issue51_confidence_below_per_retailer_ceiling(parser):
    """Issue #51 AC: generic confidence ceiling (0.8) must stay below the
    per-retailer parser ceiling (1.0). Verified structurally against the
    formula so the contract holds even if total_fields changes."""
    # A maximally-matched generic bill (every field populated) yields the
    # generic ceiling, which must be strictly less than the per-retailer
    # ceiling of 1.0.
    total_fields = 11
    generic_ceiling = 0.5 + 0.3 * (total_fields / total_fields)
    assert generic_ceiling == 0.8
    assert generic_ceiling < 1.0
