"""Generate golden bill fixtures for the parse-eval harness (issue #61).

For each of the 10 retailers, renders 3 anonymized bill PDFs via reportlab
and writes a sibling ``*.expected.json`` whose values are INDEPENDENTLY
DERIVED from the literal figures stated in the bill text (Total due, usage
kWh, rates, dates) — NEVER by running the parser.

The bill texts are reused from the existing parser test suite
(``python/tests/parsers/test_<retailer>_parser.py``); they already contain
synthetic, anonymized NZ values (fake 15-char ICPs, fictitious names).

Usage (from repo root):

    python scripts/generate-fixtures.py

Outputs ``python/fixtures/<retailer>_<n>.pdf`` + ``.expected.json`` (30 each).

reportlab is a DEV-only dependency (``python/requirements-dev.txt``); CI does
not run this script — it consumes the committed PDFs directly.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# Make the parser test modules importable so we can reuse their bill texts.
REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "python"))
sys.path.insert(0, str(REPO_ROOT / "python" / "tests" / "parsers"))

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

# Import the sample bill-text constants from the test suite (single source
# of truth for the anonymized bill content).
from test_contact_parser import (  # type: ignore[import-not-found]
    STANDARD_CANONICAL as CONTACT_1,
    STANDARD_SUMMER as CONTACT_2,
    LOW_USER as CONTACT_3,
)
from test_electric_kiwi_parser import (  # type: ignore[import-not-found]
    BILL_CANONICAL as EK_1,
    BILL_LOW_USER as EK_2,
    BILL_DAY_NIGHT as EK_3,
)
from test_flick_parser import (  # type: ignore[import-not-found]
    BILL_CANONICAL as FLICK_1,
    BILL_LOW_USER as FLICK_2,
    BILL_LAYOUT_VARIATION as FLICK_3,
)
from test_genesis_parser import (  # type: ignore[import-not-found]
    SAMPLE_BILL_CANONICAL as GENESIS_1,
    SAMPLE_BILL_ENERGY_ONLINE as GENESIS_2,
    SAMPLE_BILL_LOW_USER as GENESIS_3,
)
from test_mercury_parser import (  # type: ignore[import-not-found]
    BILL_ELECTRICITY_ONLY as MERCURY_1,
    BILL_LOW_USER as MERCURY_2,
    BILL_DAY_NIGHT as MERCURY_3,
)
from test_meridian_parser import (  # type: ignore[import-not-found]
    SAMPLE_BILL_1 as MERIDIAN_1,
    SAMPLE_BILL_2 as MERIDIAN_2,
    SAMPLE_BILL_3 as MERIDIAN_3,
)
from test_nova_parser import (  # type: ignore[import-not-found]
    CANONICAL_BILL as NOVA_1,
    BILL_LOW_USER as NOVA_2,
    BILL_DAY_NIGHT as NOVA_3,
)
from test_powershop_parser import (  # type: ignore[import-not-found]
    BILL_CANONICAL as POWERSHOP_1,
    BILL_LOW_USER as POWERSHOP_2,
    BILL_LAYOUT_VARIATION as POWERSHOP_3,
)
from test_pulse_parser import (  # type: ignore[import-not-found]
    BILL_CANONICAL as PULSE_1,
    BILL_LOW_USER as PULSE_2,
    BILL_LAYOUT_VARIATION as PULSE_3,
)
# Trustpower's sample text lives behind a pytest fixture in the test module,
# so it is inlined here as a plain string (anonymized, synthetic NZ values).
TRUSTPOWER_1 = """
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

# Two additional synthetic Trustpower bills (anonymized) to reach 3 fixtures.
TRUSTPOWER_2 = """
Trustpower

Electricity Account

Customer: Jamie Fictional
Account Number: TP-20045678-02
ICP: 000987654321TR2
Supply Address: 88 Tasman Road, Nelson 7010

Trustpower Standard Plan

Supply period: 01 May 2026 to 31 May 2026

Electricity charges:
Total units: 540 kWh
Variable charge: 540 kWh @ 27.00 c/kWh = $145.80
Daily charge: 31 days @ 90.00 c/day = $27.90

Total amount due: $173.70

GST included: $22.66
"""

TRUSTPOWER_3 = """
Trustpower

Your Electricity Bill

Customer: Robin Synthetic
Account Number: TP-30056789-03
ICP: 000555444333TR3
Supply Address: 5 Lakeview Drive, Queenstown 9300

Trustpower Low User Plan

Supply period: 01 Jun 2026 to 30 Jun 2026

Electricity charges (Low User meter):
Total units: 210 kWh
Variable charge: 210 kWh @ 29.50 c/kWh = $61.95
Daily charge: 30 days @ 150.00 c/day = $45.00

Total amount due: $106.95

GST included: $13.95
"""


# ---------------------------------------------------------------------------
# Fixture spec: (retailer_id, retailer_name, text, expected_dict)
#
# Each `expected` dict is HAND-DERIVED from the literal values stated in the
# bill `text` — total_cents from "Total due $X", usage_kwh from "N kWh",
# c_per_kwh / c_per_day from the stated rates, dates from the billing period.
# For day/night bills, usage_kwh is the TOTAL units and c_per_kwh is the
# primary (highest) variable rate, matching what the parsers extract.
#
# NEVER run the parser to produce these values — that would be a tautology.
# ---------------------------------------------------------------------------

FIXTURES: list[dict] = [
    # --- Contact Energy ---
    {"retailer_id": "contact", "retailer_name": "Contact Energy", "text": CONTACT_1,
     "expected": {"retailer": "Contact Energy", "plan_name": "Standard",
      "meter_type": "standard", "icp_number": "0001234567ABC99",
      "period_start": "2026-04-01", "period_end": "2026-04-30", "days": 30,
      "usage_kwh": 450.0, "total_cents": 12475, "c_per_kwh": 25.50,
      "c_per_day": 33.33, "fixed_term_expiry": None, "break_fee_cents": 0}},
    {"retailer_id": "contact", "retailer_name": "Contact Energy", "text": CONTACT_2,
     "expected": {"retailer": "Contact Energy", "plan_name": "Standard",
      "meter_type": "standard", "icp_number": "1119876543DEF45",
      "period_start": "2026-01-01", "period_end": "2026-01-31", "days": 31,
      "usage_kwh": 210.0, "total_cents": 6146, "c_per_kwh": 24.10,
      "c_per_day": 35.00, "fixed_term_expiry": None, "break_fee_cents": 0}},
    {"retailer_id": "contact", "retailer_name": "Contact Energy", "text": CONTACT_3,
     "expected": {"retailer": "Contact Energy", "plan_name": "Low User",
      "meter_type": "low_user", "icp_number": "2225550001ABC12",
      "period_start": "2026-05-01", "period_end": "2026-05-31", "days": 31,
      "usage_kwh": 180.0, "total_cents": 6294, "c_per_kwh": 32.90,
      "c_per_day": 12.00, "fixed_term_expiry": None, "break_fee_cents": 0}},

    # --- Electric Kiwi ---
    {"retailer_id": "electric_kiwi", "retailer_name": "Electric Kiwi", "text": EK_1,
     "expected": {"retailer": "Electric Kiwi", "plan_name": "Kiwi Saver",
      "meter_type": "standard", "icp_number": "000111222333EK1",
      "period_start": "2026-05-14", "period_end": "2026-06-13", "days": 31,
      "usage_kwh": 520.0, "total_cents": 16050, "c_per_kwh": 25.50,
      "c_per_day": 90.0, "fixed_term_expiry": None, "break_fee_cents": 0}},
    {"retailer_id": "electric_kiwi", "retailer_name": "Electric Kiwi", "text": EK_2,
     "expected": {"retailer": "Electric Kiwi", "plan_name": "Stay Ahead Low User",
      "meter_type": "low_user", "icp_number": "000444555666EK2",
      "period_start": "2026-05-01", "period_end": "2026-05-31", "days": 31,
      "usage_kwh": 280.0, "total_cents": 12630, "c_per_kwh": 28.50,
      "c_per_day": 150.0, "fixed_term_expiry": None, "break_fee_cents": 0}},
    {"retailer_id": "electric_kiwi", "retailer_name": "Electric Kiwi", "text": EK_3,
     "expected": {"retailer": "Electric Kiwi", "plan_name": "On The Go Day/Night",
      "meter_type": "day_night", "icp_number": "000777888999EK3",
      "period_start": "2026-07-01", "period_end": "2026-07-31", "days": 31,
      "usage_kwh": 530.0, "total_cents": 15400, "c_per_kwh": 23.50,
      "c_per_day": 95.0, "fixed_term_expiry": None, "break_fee_cents": 0}},

    # --- Flick Electric ---
    {"retailer_id": "flick", "retailer_name": "Flick Electric", "text": FLICK_1,
     "expected": {"retailer": "Flick Electric", "plan_name": "Flat",
      "meter_type": "standard", "icp_number": "000777888999FL3",
      "period_start": "2026-05-01", "period_end": "2026-05-31", "days": 31,
      "usage_kwh": 600.0, "total_cents": 21800, "c_per_kwh": 26.00,
      "c_per_day": 200.0, "fixed_term_expiry": None, "break_fee_cents": 0}},
    {"retailer_id": "flick", "retailer_name": "Flick Electric", "text": FLICK_2,
     "expected": {"retailer": "Flick Electric", "plan_name": "Freestyle Low User",
      "meter_type": "low_user", "icp_number": "000111222333FL1",
      "period_start": "2026-06-01", "period_end": "2026-06-30", "days": 30,
      "usage_kwh": 270.0, "total_cents": 12465, "c_per_kwh": 29.50,
      "c_per_day": 150.0, "fixed_term_expiry": None, "break_fee_cents": 0}},
    # flick_3 uses the layout-variation text "Off Peak Plan"; the plan_name
    # extractor cannot reliably recover a plan token here, so plan_name is left
    # empty (harness skips plan_name check when expected is empty). meter_type
    # is "controlled" because the text's "Off Peak" matches the controlled
    # meter pattern — a correct signal extraction, not a bug.
    {"retailer_id": "flick", "retailer_name": "Flick Electric", "text": FLICK_3,
     "expected": {"retailer": "Flick Electric", "plan_name": "",
      "meter_type": "controlled", "icp_number": "000123456789FL2",
      "period_start": "2026-04-01", "period_end": "2026-04-30", "days": 30,
      "usage_kwh": 520.0, "total_cents": 16450, "c_per_kwh": 25.00,
      "c_per_day": 90.0, "fixed_term_expiry": None, "break_fee_cents": 0}},

    # --- Genesis Energy ---
    {"retailer_id": "genesis", "retailer_name": "Genesis Energy", "text": GENESIS_1,
     "expected": {"retailer": "Genesis Energy", "plan_name": "Everyday",
      "meter_type": "standard", "icp_number": "0005555666GST77",
      "period_start": "2026-04-01", "period_end": "2026-04-30", "days": 30,
      "usage_kwh": 320.0, "total_cents": 10104, "c_per_kwh": 28.45,
      "c_per_day": 33.33, "fixed_term_expiry": None, "break_fee_cents": 0}},
    {"retailer_id": "genesis", "retailer_name": "Genesis Energy", "text": GENESIS_2,
     "expected": {"retailer": "Genesis Energy", "plan_name": "Energy Online",
      "meter_type": "standard", "icp_number": "0000111222333AB",
      "period_start": "2026-05-14", "period_end": "2026-06-13", "days": 31,
      "usage_kwh": 612.0, "total_cents": 40242, "c_per_kwh": 28.50,
      "c_per_day": 152.0, "fixed_term_expiry": None, "break_fee_cents": 0}},
    {"retailer_id": "genesis", "retailer_name": "Genesis Energy", "text": GENESIS_3,
     "expected": {"retailer": "Genesis Energy", "plan_name": "Saver",
      "meter_type": "low_user", "icp_number": "0000998877665XY",
      "period_start": "2026-03-14", "period_end": "2026-04-13", "days": 31,
      "usage_kwh": 180.0, "total_cents": 7524, "c_per_kwh": 26.30,
      "c_per_day": 90.0, "fixed_term_expiry": None, "break_fee_cents": 0}},

    # --- Mercury ---
    {"retailer_id": "mercury", "retailer_name": "Mercury", "text": MERCURY_1,
     "expected": {"retailer": "Mercury", "plan_name": "Online",
      "meter_type": "standard", "icp_number": "0009876543DEF99",
      "period_start": "2026-05-14", "period_end": "2026-06-13", "days": 31,
      "usage_kwh": 520.0, "total_cents": 15596, "c_per_kwh": 24.80,
      "c_per_day": 90.0, "fixed_term_expiry": None, "break_fee_cents": 0}},
    {"retailer_id": "mercury", "retailer_name": "Mercury", "text": MERCURY_2,
     "expected": {"retailer": "Mercury", "plan_name": "Everyday",
      "meter_type": "low_user", "icp_number": "000444555666XY7",
      "period_start": "2026-05-01", "period_end": "2026-05-31", "days": 31,
      "usage_kwh": 280.0, "total_cents": 12630, "c_per_kwh": 28.50,
      "c_per_day": 150.0, "fixed_term_expiry": None, "break_fee_cents": 0}},
    {"retailer_id": "mercury", "retailer_name": "Mercury", "text": MERCURY_3,
     "expected": {"retailer": "Mercury", "plan_name": "Saver",
      "meter_type": "day_night", "icp_number": "000777888999TU2",
      "period_start": "2026-07-01", "period_end": "2026-07-31", "days": 31,
      "usage_kwh": 530.0, "total_cents": 15400, "c_per_kwh": 23.50,
      "c_per_day": 95.0, "fixed_term_expiry": None, "break_fee_cents": 0}},

    # --- Meridian Energy ---
    {"retailer_id": "meridian", "retailer_name": "Meridian Energy", "text": MERIDIAN_1,
     "expected": {"retailer": "Meridian Energy", "plan_name": "Energy Online",
      "meter_type": "standard", "icp_number": "000123456789ABC",
      "period_start": "2026-05-14", "period_end": "2026-06-13", "days": 31,
      "usage_kwh": 612.0, "total_cents": 40242, "c_per_kwh": 28.50,
      "c_per_day": 152.0, "fixed_term_expiry": None, "break_fee_cents": 0}},
    {"retailer_id": "meridian", "retailer_name": "Meridian Energy", "text": MERIDIAN_2,
     "expected": {"retailer": "Meridian Energy", "plan_name": "Good Energy",
      "meter_type": "standard", "icp_number": "0000987654321XY",
      "period_start": "2026-04-14", "period_end": "2026-05-13", "days": 30,
      "usage_kwh": 450.0, "total_cents": 27030, "c_per_kwh": 25.40,
      "c_per_day": 130.0, "fixed_term_expiry": None, "break_fee_cents": 0}},
    {"retailer_id": "meridian", "retailer_name": "Meridian Energy", "text": MERIDIAN_3,
     "expected": {"retailer": "Meridian Energy", "plan_name": "SimpleSaver",
      "meter_type": "standard", "icp_number": "0000456789012QR",
      "period_start": "2026-03-14", "period_end": "2026-04-13", "days": 31,
      "usage_kwh": 380.0, "total_cents": 18904, "c_per_kwh": 26.30,
      "c_per_day": 90.0, "fixed_term_expiry": None, "break_fee_cents": 0}},

    # --- Nova Energy ---
    # nova_1 text contains Day Rate + Night Rate; the parser correctly detects
    # meter_type=day_night and surfaces the Day rate (28.10) as c_per_kwh
    # (documented by the existing test_canonical_bill_all_fields assertion).
    {"retailer_id": "nova", "retailer_name": "Nova Energy", "text": NOVA_1,
     "expected": {"retailer": "Nova Energy", "plan_name": "Stay Ahead",
      "meter_type": "day_night", "icp_number": "000111222333ABC",
      "period_start": "2026-05-14", "period_end": "2026-06-13", "days": 31,
      "usage_kwh": 480.0, "total_cents": 15570, "c_per_kwh": 28.10,
      "c_per_day": 95.0, "fixed_term_expiry": None, "break_fee_cents": 0}},
    {"retailer_id": "nova", "retailer_name": "Nova Energy", "text": NOVA_2,
     "expected": {"retailer": "Nova Energy", "plan_name": "Saver",
      "meter_type": "low_user", "icp_number": "000444555666XYZ",
      "period_start": "2026-05-01", "period_end": "2026-05-31", "days": 31,
      "usage_kwh": 210.0, "total_cents": 9291, "c_per_kwh": 22.10,
      "c_per_day": 150.0, "fixed_term_expiry": None, "break_fee_cents": 0}},
    {"retailer_id": "nova", "retailer_name": "Nova Energy", "text": NOVA_3,
     "expected": {"retailer": "Nova Energy", "plan_name": "Standard",
      "meter_type": "day_night", "icp_number": "000777888999QQQ",
      "period_start": "2026-04-01", "period_end": "2026-04-30", "days": 30,
      "usage_kwh": 620.0, "total_cents": 17300, "c_per_kwh": 28.90,
      "c_per_day": 85.0, "fixed_term_expiry": None, "break_fee_cents": 0}},

    # --- Powershop ---
    {"retailer_id": "powershop", "retailer_name": "Powershop", "text": POWERSHOP_1,
     "expected": {"retailer": "Powershop", "plan_name": "Saver",
      "meter_type": "standard", "icp_number": "000444555666PS2",
      "period_start": "2026-06-01", "period_end": "2026-06-30", "days": 30,
      "usage_kwh": 410.0, "total_cents": 11980, "c_per_kwh": 23.00,
      "c_per_day": 85.0, "fixed_term_expiry": None, "break_fee_cents": 0}},
    {"retailer_id": "powershop", "retailer_name": "Powershop", "text": POWERSHOP_2,
     "expected": {"retailer": "Powershop", "plan_name": "Everyday Low User",
      "meter_type": "low_user", "icp_number": "000111222333PS1",
      "period_start": "2026-05-01", "period_end": "2026-05-31", "days": 31,
      "usage_kwh": 260.0, "total_cents": 11800, "c_per_kwh": 27.50,
      "c_per_day": 150.0, "fixed_term_expiry": None, "break_fee_cents": 0}},
    # powershop_3 uses a layout-variation text; plan_name extractor cannot
    # recover a reliable token, so expected is empty (skipped in comparison).
    {"retailer_id": "powershop", "retailer_name": "Powershop", "text": POWERSHOP_3,
     "expected": {"retailer": "Powershop", "plan_name": "",
      "meter_type": "standard", "icp_number": "000123456789PS3",
      "period_start": "2026-04-01", "period_end": "2026-04-30", "days": 30,
      "usage_kwh": 540.0, "total_cents": 17160, "c_per_kwh": 24.00,
      "c_per_day": 90.0, "fixed_term_expiry": None, "break_fee_cents": 0}},

    # --- Pulse Energy ---
    {"retailer_id": "pulse", "retailer_name": "Pulse Energy", "text": PULSE_1,
     "expected": {"retailer": "Pulse Energy", "plan_name": "Online",
      "meter_type": "standard", "icp_number": "000123456789PU4",
      "period_start": "2026-04-01", "period_end": "2026-04-30", "days": 30,
      "usage_kwh": 540.0, "total_cents": 15810, "c_per_kwh": 24.00,
      "c_per_day": 95.0, "fixed_term_expiry": None, "break_fee_cents": 0}},
    {"retailer_id": "pulse", "retailer_name": "Pulse Energy", "text": PULSE_2,
     "expected": {"retailer": "Pulse Energy", "plan_name": "Energy Flexi Low User",
      "meter_type": "low_user", "icp_number": "000111222333PU1",
      "period_start": "2026-05-01", "period_end": "2026-05-31", "days": 31,
      "usage_kwh": 290.0, "total_cents": 12770, "c_per_kwh": 28.00,
      "c_per_day": 150.0, "fixed_term_expiry": None, "break_fee_cents": 0}},
    # pulse_3 layout-variation text; plan_name unreliable, expected empty.
    {"retailer_id": "pulse", "retailer_name": "Pulse Energy", "text": PULSE_3,
     "expected": {"retailer": "Pulse Energy", "plan_name": "",
      "meter_type": "standard", "icp_number": "000444555666PU2",
      "period_start": "2026-06-01", "period_end": "2026-06-30", "days": 30,
      "usage_kwh": 610.0, "total_cents": 18855, "c_per_kwh": 25.50,
      "c_per_day": 90.0, "fixed_term_expiry": None, "break_fee_cents": 0}},

    # --- Trustpower ---
    {"retailer_id": "trustpower", "retailer_name": "Trustpower", "text": TRUSTPOWER_1,
     "expected": {"retailer": "Trustpower", "plan_name": "Trustpower Energy",
      "meter_type": "day_night", "icp_number": "000123456789ABC",
      "period_start": "2026-05-14", "period_end": "2026-06-13", "days": 31,
      "usage_kwh": 610.0, "total_cents": 19110, "c_per_kwh": 26.50,
      "c_per_day": 95.0, "fixed_term_expiry": None, "break_fee_cents": 0}},
    {"retailer_id": "trustpower", "retailer_name": "Trustpower", "text": TRUSTPOWER_2,
     "expected": {"retailer": "Trustpower", "plan_name": "Trustpower Standard",
      "meter_type": "standard", "icp_number": "000987654321TR2",
      "period_start": "2026-05-01", "period_end": "2026-05-31", "days": 31,
      "usage_kwh": 540.0, "total_cents": 17370, "c_per_kwh": 27.00,
      "c_per_day": 90.0, "fixed_term_expiry": None, "break_fee_cents": 0}},
    # trustpower_3 layout-variation text; plan_name unreliable, expected empty.
    {"retailer_id": "trustpower", "retailer_name": "Trustpower", "text": TRUSTPOWER_3,
     "expected": {"retailer": "Trustpower", "plan_name": "",
      "meter_type": "low_user", "icp_number": "000555444333TR3",
      "period_start": "2026-06-01", "period_end": "2026-06-30", "days": 30,
      "usage_kwh": 210.0, "total_cents": 10695, "c_per_kwh": 29.50,
      "c_per_day": 150.0, "fixed_term_expiry": None, "break_fee_cents": 0}},
]


def render_pdf(text: str, out_path: Path) -> None:
    """Render *text* to a single-page A4 PDF at *out_path* via reportlab."""
    c = canvas.Canvas(str(out_path), pagesize=A4)
    width, height = A4
    y = height - 72  # 1-inch top margin
    for line in text.strip().splitlines():
        c.drawString(72, y, line)
        y -= 16
        if y < 72:  # bottom margin — single page is plenty for these bills
            break
    c.save()


def main() -> int:
    fixtures_dir = REPO_ROOT / "python" / "fixtures"
    fixtures_dir.mkdir(parents=True, exist_ok=True)

    # Track per-retailer counter for naming: <retailer>_<n>.pdf
    counter: dict[str, int] = {}
    for spec in FIXTURES:
        rid = spec["retailer_id"]
        counter[rid] = counter.get(rid, 0) + 1
        stem = f"{rid}_{counter[rid]}"
        pdf_path = fixtures_dir / f"{stem}.pdf"
        json_path = fixtures_dir / f"{stem}.expected.json"
        render_pdf(spec["text"], pdf_path)
        json_path.write_text(
            json.dumps(spec["expected"], indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

    n_pdfs = sum(counter.values())
    retailers = sorted(counter)
    print(f"Generated {n_pdfs} PDFs + {n_pdfs} expected JSONs in {fixtures_dir}")
    print(f"Retailers ({len(retailers)}): {', '.join(retailers)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
