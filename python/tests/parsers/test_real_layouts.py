"""Regression tests against REAL bill layouts.

Both constants below are verbatim pdfplumber text extractions of real customer
bills that the parsers got wrong in production. Names, street numbers, ICPs,
account/invoice numbers and phone numbers are anonymised; every figure, label
and line break is preserved, because the layout IS the test.

Each wrong value is called out inline so a future regression is recognisable.
"""

from __future__ import annotations

import pytest

from parsers.base import RECONCILE_TOLERANCE, reconcile_total
from parsers.extractors import (
    extract_address,
    extract_daily_charge,
    extract_dates,
    extract_dollars,
    extract_icp,
    extract_kwh,
    extract_meter_type,
    extract_per_kwh,
    extract_plan_name,
    extract_tou_blended_rate,
    extract_tou_usage,
    has_tou_charges,
)
from parsers.meridian_parser import MeridianParser

# ---------------------------------------------------------------------------
# Mercury — bundled electricity + mobile invoice
# ---------------------------------------------------------------------------

MERCURY_REAL_LAYOUT = """Tax Invoice 5000000001
GST Number 71-048-870
Tax Invoice Date 29 July 2026
JANE SMITH
14 KOWHAI STREET
Access your account online at:
BIRKDALE
myaccount.mercury.co.nz
AUCKLAND
NEW ZEALAND 0626 Chat to us on weekdays between 8am-6.30pm
Webchat mercury.co.nz
Freephone enquiries 0800 10 18 10
Your account number 800000001
Hi there, here's your latest bill due 17 August 2026.
Opening balance Current bill Amount due
+ =
$0.00 $414.18 $414.18
includes GST
of $54.03
Current bill charges
Electricity $395.18
Mobile $19.00
OPENING BALANCE SUMMARY
Previous bill $326.46
15 Jul 2026 Direct Debit Credit Card Variable $329.07 credit
15 Jul 2026 Credit Card Surcharge Fee $2.61
Opening balance total $0.00
ELECTRICITY
Location 14 KOWHAI STREET, BIRKDALE,
AUCKLAND
ICP 0001234567UN03B
Billing period 26 Jun 2026 - 27 Jul 2026
Next approximate read date 25 Aug 2026
Your total usage for the last 365 days is 8250 units (kWh).
CHARGE TYPE
Inclusive 1113.88 kWh x 22.49 cents $250.51
Daily Fixed Charge 32 Days x 291.00 cents $93.12
Subtotal $343.63
GST $51.55
ELECTRICITY TOTAL $395.18
Meter number Previous reading Latest reading Multiplier
RD10164247 057968 (actual) 059082 (actual) 1
The meter readings shown above may not match the billed usage exactly. This does not impact your charges.
MOBILE
Phone number 0210000000
CHARGE TYPE BILLING PERIOD
Call Charges 1 Jun 2026 - 30 Jun 2026 $0.00
1.25GB Data/250 Mins/Unlimited Text 1 Jul 2026 - 31 Jul 2026 $16.52
Subtotal $16.52
GST $2.48
MOBILE TOTAL $19.00
SUMMARY OF CALL CHARGES
MOBILE PREMIUM MESSAGES
Phone number 0210000000
Date Time Call type Place called Number Min:Sec Call discount Total
21 Jun 26 7:28 am Message Premium Message 04183 1 Calls $0.00 $0.00
TOTAL $0.00
If you have any concerns about our service, please visit In the unlikely event we can't resolve your complaint, for free and independent advice
mercury.co.nz/complaint or call 0800 10 18 10. on electricity and gas, contact: Utilities Disputes on 0800 22 33 40 or udl.co.nz and for
phone or internet, contact: Telecommunications Dispute Resolution on 0508 98 98 98
or tdr.org.nz. Could you save money on another plan? Compare plans at the free and
independent site billy.govt.nz.
DIRECT DEBIT
Thank you for choosing to pay by Direct Debit.
Account name JANE SMITH
The total due of $414.18 less any payments received since the PRIVATE BAG 12023
Account number 800000001 date of this invoice, will be deducted on 17 Aug 2026. TAURANGA 3143
MERCURY NZ LTD
Pay by internet banking: 01-1839-0329105-01
"""


def test_mercury_icp():
    assert extract_icp(MERCURY_REAL_LAYOUT) == "0001234567UN03B", "icp_number"


def test_mercury_dates():
    assert extract_dates(MERCURY_REAL_LAYOUT) == ("2026-06-26", "2026-07-27"), "period"


def test_mercury_usage():
    assert extract_kwh(MERCURY_REAL_LAYOUT) == 1113.88, "usage_kwh"


def test_mercury_total_is_the_electricity_total_not_zero():
    # Was 0: "Opening balance total $0.00" and the mobile "TOTAL $0.00" both
    # scored as totals and out-weighed the real figure.
    assert extract_dollars(MERCURY_REAL_LAYOUT) == 39518, "total_cents"


def test_mercury_per_kwh_reads_the_usage_times_rate_line():
    # Was 329.07 — matched "Variable $329.07 credit", a customer PAYMENT.
    assert extract_per_kwh(MERCURY_REAL_LAYOUT) == 22.49, "c_per_kwh"


def test_mercury_daily_charge_reads_the_rate_not_the_day_count():
    # Was 32.0 — matched the day count in "32 Days x 291.00 cents".
    assert extract_daily_charge(MERCURY_REAL_LAYOUT) == 291.0, "c_per_day"


def test_mercury_address_comes_from_the_location_label():
    # Was "0800 10 18 10. on electricity and gas, contact: Utilities Disputes
    # on 0800" — a phone number harvested from the complaints footer. This is
    # the value that made the Powerswitch lookup return zero completions.
    assert (
        extract_address(MERCURY_REAL_LAYOUT) == "14 KOWHAI STREET, BIRKDALE, AUCKLAND"
    ), "address"


def test_mercury_has_no_plan_name():
    # Was "online" — from "Access your account online at:".
    assert extract_plan_name(MERCURY_REAL_LAYOUT) is None, "plan_name"


def test_mercury_meter_type():
    assert extract_meter_type(MERCURY_REAL_LAYOUT) == "standard", "meter_type"


# ---------------------------------------------------------------------------
# Electric Kiwi — time-of-use invoice
# ---------------------------------------------------------------------------
#
# The doubled characters are genuine pdfplumber output from Electric Kiwi's
# bold font. Do not "fix" them — the parser has to cope with them.

EK_REAL_LAYOUT = """Statement
OPENING BALANCE $418.59
Description Date Credit Debit Balance
JOHN DOE
129 B RANGATIRA ROAD Payment - Thank you 1st Jul $418.59 $0.00
BEACH HAVEN
AUCKLAND 0626
New Power Charges $140.36 $140.36
CCuussttoommeerr ##::
50000001 Credit Card Surcharge $1.05 $141.41
DDaattee::
TOTAL TO PAY $141.41
8th July 2026
EElleeccttrriicc KKiiwwii LLiimmiitteedd Electric Kiwi will automatically process $141.41 against your credit/debit card on
GGSSTT ##:: 113-618-701 13th July 2026, unless you notify us at least one day in advance.
For options on payments and billing info see here.
See following page/s for details of your usage
Tax Invoice 129 B RANGATIRA ROAD, BEACH HAVEN, AUCKLAND, 0626
IInnvvooiiccee ##:: 1600000001 ICP 1001250179UNDB4
POWER USAGE 24th Jun 26 - 2nd Jul 26 inclusive
JOHN DOE
129 B RANGATIRA ROAD Description Usage Rate (incl GST) Total
BEACH HAVEN
AUCKLAND 0626 Peak Charges 98.31 kWh $0.5671/kWh $55.75
Off-peak Charges 175.62 kWh $0.4254/kWh $74.71
CCuussttoommeerr ##::
50000001 Hour of Power Savings 24.56 kWh FREE $0.00
DDaattee::
Supply Charges 9 days $1.1000/day $9.90
8th July 2026
EElleeccttrriicc KKiiwwii LLiimmiitteedd
GGSSTT ##:: 113-618-701
New Power Charges (Incl GST) $140.36
TOTAL NEW USAGE CHARGES - All Services $140.36
See statement on page 1 for final total due
Billy is a free and independent energy comparison site created by the Electricity Authority. Visit www.billy.govt.nz to check you are on the right plan for your needs.
"""


def test_ek_icp():
    assert extract_icp(EK_REAL_LAYOUT) == "1001250179UNDB4", "icp_number"


def test_ek_dates():
    assert extract_dates(EK_REAL_LAYOUT) == ("2026-06-24", "2026-07-02"), "period"


def test_ek_total():
    assert extract_dollars(EK_REAL_LAYOUT) == 14036, "total_cents"


def test_ek_daily_charge():
    assert extract_daily_charge(EK_REAL_LAYOUT) == 110.0, "c_per_day"


def test_ek_tou_usage_includes_free_kwh():
    assert extract_tou_usage(EK_REAL_LAYOUT) == 298.49, "usage_kwh"


def test_ek_is_time_of_use():
    assert has_tou_charges(EK_REAL_LAYOUT) is True
    assert extract_meter_type(EK_REAL_LAYOUT) == "day_night", "meter_type"


def test_ek_address_attaches_the_detached_unit_letter():
    # The bill prints "129 B RANGATIRA ROAD"; NZ addressing (and the
    # Powerswitch autocomplete) wants "129B". Submitting the detached form
    # returned ZERO completions in production.
    assert (
        extract_address(EK_REAL_LAYOUT)
        == "129B RANGATIRA ROAD, BEACH HAVEN, AUCKLAND 0626"
    ), "address"


def test_ek_blended_rate_is_not_the_peak_rate():
    # ($55.75 + $74.71 + $0.00) / 298.49 kWh. extract_per_kwh alone returns the
    # peak rate 56.71, which overstates the customer's real cost by ~30%.
    assert extract_tou_blended_rate(EK_REAL_LAYOUT) == 43.71, "c_per_kwh (blended)"


# ---------------------------------------------------------------------------
# Meridian — split-period bills (re-rate / 1 April price change)
# ---------------------------------------------------------------------------
#
# Meridian splits the billing period into two charge segments when the tariff
# changes mid-period or the account is re-rated. The meter identifier is
# anonymised to <METER>; treat it as an opaque token. Every figure, label and
# line break is preserved from the real bills — the layout IS the test.
#
# Both bills were stuck in needs_review because the parser read only the first
# segment and the headline amount due (which folds in any unpaid prior balance).

MERIDIAN_SPLIT_A = """Your bill: $489.15
Total amount due by 08 Jan 2026 $489.15
Charges Period Rate (incl GST) Quantity Total
<METER>:1 Anytime 18 Nov - 28 Nov 24.46 c/kWh 232.0 kWh $56.74
Daily Charge (267.79 c/day x 11 days) $29.45
<METER>:1 Anytime 29 Nov - 17 Dec 24.46 c/kWh 384.0 kWh $93.92
Daily Charge (267.79 c/day x 19 days) $50.88
Property charges for this period 616.0 kWh $231.01
Total charges $231.01
Net cost (excluding GST) $200.88
"""

MERIDIAN_SPLIT_B = """Your bill: $256.32
Total amount due by 05 May 2026 $256.32
Charges Period Rate (incl GST) Quantity Total
<METER>:1 Anytime 18 Mar - 31 Mar 24.46 c/kWh 305.7 kWh $74.78
Daily Charge (267.79 c/day x 14 days) $37.49
<METER>:1 Anytime 01 Apr - 17 Apr 26.83 c/kWh 354.4 kWh $95.09
Daily Charge (288.11 c/day x 17 days) $48.98
Property charges for this period 660.1 kWh $256.32
Total charges $256.32
Net cost (excluding GST) $222.89
"""

# Same Meridian layout style but a SINGLE segment — proves the blend does not
# engage and the shared extractors return the lone rate unchanged.
MERIDIAN_SINGLE_SEGMENT = """Your bill: $127.12
Total amount due by 13 Feb 2026 $127.12
Charges Period Rate (incl GST) Quantity Total
<METER>:1 Anytime 14 Jan - 13 Feb 27.80 c/kWh 290.0 kWh $80.62
Daily Charge (150.00 c/day x 31 days) $46.50
Property charges for this period 290.0 kWh $127.12
Total charges $127.12
Net cost (excluding GST) $110.54
"""


def test_meridian_split_a_usage_reads_the_aggregate_line():
    # Was the first segment (232.0): no pattern matched "Property charges for
    # this period", so the caller fell through to the shared first-NNN-kWh.
    assert MeridianParser._extract_meridian_usage(MERIDIAN_SPLIT_A) == 616.0


def test_meridian_split_a_per_kwh_unchanged_single_rate():
    # Both segments share 24.46 -> no blend; the shared path returns the rate.
    assert MeridianParser._extract_meridian_per_kwh(MERIDIAN_SPLIT_A) is None
    assert extract_per_kwh(MERIDIAN_SPLIT_A) == 24.46


def test_meridian_split_a_daily_charge_unchanged_single_rate():
    assert MeridianParser._extract_meridian_daily_charge(MERIDIAN_SPLIT_A) is None
    assert extract_daily_charge(MERIDIAN_SPLIT_A) == 267.79


def test_meridian_split_a_total_prefers_total_charges_over_amount_due():
    # Was 48915 ("Total amount due" carries the prior month's unpaid $258.14).
    assert MeridianParser._extract_meridian_total(MERIDIAN_SPLIT_A) == 23101


def test_meridian_split_b_usage_reads_the_aggregate_line():
    assert MeridianParser._extract_meridian_usage(MERIDIAN_SPLIT_B) == 660.1


def test_meridian_split_b_per_kwh_is_volume_weighted():
    # (24.46*305.7 + 26.83*354.4) / 660.1. extract_per_kwh alone returns the
    # first (pre-change) rate 24.46, so the period never reconciles.
    assert MeridianParser._extract_meridian_per_kwh(MERIDIAN_SPLIT_B) == pytest.approx(
        25.73, abs=0.01
    )


def test_meridian_split_b_daily_charge_is_day_weighted():
    # (267.79*14 + 288.11*17) / 31.
    assert MeridianParser._extract_meridian_daily_charge(MERIDIAN_SPLIT_B) == pytest.approx(
        278.93, abs=0.01
    )


def test_meridian_split_b_total_prefers_total_charges():
    # No arrears here, so amount due == total charges; either way 25632.
    assert MeridianParser._extract_meridian_total(MERIDIAN_SPLIT_B) == 25632


def test_meridian_split_a_reconciles_within_tolerance():
    # The four extracted values must reproduce this period's stated total.
    # days = 11 + 19 (the two daily-charge segments).
    delta = reconcile_total(
        MeridianParser._extract_meridian_usage(MERIDIAN_SPLIT_A),  # 616.0
        extract_per_kwh(MERIDIAN_SPLIT_A),  # 24.46 (single rate, no blend)
        30,
        extract_daily_charge(MERIDIAN_SPLIT_A),  # 267.79
        MeridianParser._extract_meridian_total(MERIDIAN_SPLIT_A),  # 23101
    )
    assert delta is not None
    assert delta < RECONCILE_TOLERANCE


def test_meridian_split_b_reconciles_within_tolerance():
    # days = 14 + 17 (the two daily-charge segments).
    delta = reconcile_total(
        MeridianParser._extract_meridian_usage(MERIDIAN_SPLIT_B),  # 660.1
        MeridianParser._extract_meridian_per_kwh(MERIDIAN_SPLIT_B),  # 25.73
        31,
        MeridianParser._extract_meridian_daily_charge(MERIDIAN_SPLIT_B),  # 278.93
        MeridianParser._extract_meridian_total(MERIDIAN_SPLIT_B),  # 25632
    )
    assert delta is not None
    assert delta < RECONCILE_TOLERANCE


def test_meridian_single_segment_does_not_blend():
    # A single segment never engages the blend: both methods return None and
    # the shared extractors return the lone rate, exactly as before the fix.
    assert MeridianParser._extract_meridian_usage(MERIDIAN_SINGLE_SEGMENT) == 290.0
    assert MeridianParser._extract_meridian_per_kwh(MERIDIAN_SINGLE_SEGMENT) is None
    assert MeridianParser._extract_meridian_daily_charge(MERIDIAN_SINGLE_SEGMENT) is None
    assert extract_per_kwh(MERIDIAN_SINGLE_SEGMENT) == 27.80
    assert extract_daily_charge(MERIDIAN_SINGLE_SEGMENT) == 150.0
    assert MeridianParser._extract_meridian_total(MERIDIAN_SINGLE_SEGMENT) == 12712
