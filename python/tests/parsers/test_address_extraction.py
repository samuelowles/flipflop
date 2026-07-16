"""Per-retailer supply-address extraction tests (Gmail-flow address fix).

The address feeds Powerswitch's live autocomplete, so the contract is
asymmetric: a MISSING address is fine (seeded-plan fallback), a WRONG or
noisy address is not. Low-confidence candidates must come back None.
"""
import pytest

from parsers.extractors import extract_address

from tests.parsers.test_contact_parser import STANDARD_CANONICAL as CONTACT_TEXT
from tests.parsers.test_electric_kiwi_parser import BILL_CANONICAL as EK_TEXT
from tests.parsers.test_flick_parser import BILL_CANONICAL as FLICK_TEXT
from tests.parsers.test_genesis_parser import (
    SAMPLE_BILL_CANONICAL as GENESIS_TEXT,
    SAMPLE_BILL_LAYOUT_VARIATION as GENESIS_UNLABELLED_TEXT,
)
from tests.parsers.test_mercury_parser import BILL_ELECTRICITY_ONLY as MERCURY_TEXT
from tests.parsers.test_meridian_parser import (
    SAMPLE_BILL_1 as MERIDIAN_TEXT,
    SAMPLE_BILL_2 as MERIDIAN_UNLABELLED_TEXT,
)
from tests.parsers.test_nova_parser import CANONICAL_BILL as NOVA_TEXT
from tests.parsers.test_powershop_parser import BILL_CANONICAL as POWERSHOP_TEXT
from tests.parsers.test_pulse_parser import BILL_CANONICAL as PULSE_TEXT


# --- Per-retailer canonical bills (labelled address lines) -----------------

@pytest.mark.parametrize("retailer,text,expected", [
    ("contact", CONTACT_TEXT, "123 Main Street, Auckland"),
    ("electric_kiwi", EK_TEXT, "12 Kiwi Road, Auckland"),
    ("flick", FLICK_TEXT, "78 Flick Avenue, Christchurch"),
    ("genesis", GENESIS_TEXT, "789 Rural Road, Matangi, Hamilton 3284"),
    ("mercury", MERCURY_TEXT, "1 Queen Street, Auckland Central, Auckland 1010"),
    ("meridian", MERIDIAN_TEXT, "12 Kokiri Street, Hataitai, Wellington 6021"),
    ("nova", NOVA_TEXT, "12 Example Lane, Wellington"),
    ("powershop", POWERSHOP_TEXT, "45 Power Street, Wellington"),
    ("pulse", PULSE_TEXT, "3 Pulse Lane, Dunedin"),
])
def test_per_retailer_labelled_address(retailer, text, expected):
    assert extract_address(text) == expected


# --- Unlabelled header address (Meridian / Genesis layout variants) --------

def test_meridian_unlabelled_bare_line_fallback():
    assert extract_address(MERIDIAN_UNLABELLED_TEXT) == (
        "78 Seahorse Terrace, Sumner, Christchurch 8081"
    )


def test_genesis_unlabelled_bare_line_fallback():
    assert extract_address(GENESIS_UNLABELLED_TEXT) == (
        "200 Ridge Road, Howick, Auckland 2010"
    )


# --- Normalisation --------------------------------------------------------

def test_icp_glued_onto_address_line_is_truncated():
    # Real Meridian PDFs glue the ICP cell onto the address row.
    text = "82A Verran Rd, Birkdale, Auckland 0626 ICP 1000123456UN7C0\n"
    assert extract_address(text) == "82A Verran Rd, Birkdale, Auckland 0626"


def test_unit_prefix_is_stripped():
    text = "Supply Address: Unit 5, 10 High Street, Auckland 1010\n"
    assert extract_address(text) == "10 High Street, Auckland 1010"


def test_whitespace_collapsed_and_label_removed():
    text = "Supply   Address:   9  Example   Road,  Wellington \n"
    assert extract_address(text) == "9 Example Road, Wellington"


def test_midline_glued_prefix_and_comma_postcode():
    # Real Electric Kiwi layout: pdfplumber glues the "Tax Invoice" cell onto
    # the address row, and the postcode arrives comma-separated.
    text = "Tax Invoice 45 SAMPLE ROAD, BEACH HAVEN, AUCKLAND, 0626\n"
    assert extract_address(text) == "45 SAMPLE ROAD, BEACH HAVEN, AUCKLAND 0626"


# --- Low-confidence candidates must return None ---------------------------

@pytest.mark.parametrize("text", [
    "lorem ipsum dolor sit amet\nTotal: $88.40\n",                    # no address at all
    "Supply Address: Queen Street, Auckland\n",                        # no street number
    "Supply Address: 12 Nowhere Lane, Smallville\n",                   # no city token, no postcode
    "Supply Address: 12 Nowhere Lane\n",                               # no locality separator
    "Daily charge: 30 days @ 90.00 c/day = $27.00\n",                  # charge line noise
    "contact Utilities Disputes on 0800 22 33 40 or go www.udl.co.nz\n",  # phone-number line
    "45 SAMPLE ROAD Payment - Thank you 1st Jul $418.59 $0.00\n",      # address glued with txn row (no comma)
])
def test_low_confidence_returns_none(text):
    assert extract_address(text) is None
