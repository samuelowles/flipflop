"""
Shared extraction functions for Flip bill parsers.

All monetary values are integer cents (NZD). All dates are ISO 8601.
Deterministic regex/heuristic-based extraction — NO AI/LLM.
"""

from __future__ import annotations

import re
from typing import Optional

from parsers.base import sanitize_date

# ---------------------------------------------------------------------------
# ICP number extraction
# ---------------------------------------------------------------------------

_ICP_PATTERN = re.compile(r"\b([A-Za-z0-9]{15})\b")
# Common ICP label patterns on NZ power bills
_ICP_LABEL_PATTERN = re.compile(
    r"(?:ICP|I\.C\.P\.?|Installation\s*Control\s*Point)[\s:#-]*([A-Za-z0-9]{15})",
    re.IGNORECASE,
)


def extract_icp(text: str) -> Optional[str]:
    """Extract a 15-character NZ ICP number from *text*.

    Tries labelled patterns first, then falls back to any 15-char
    alphanumeric token.
    """
    label_match = _ICP_LABEL_PATTERN.search(text)
    if label_match:
        return label_match.group(1).upper()

    for match in _ICP_PATTERN.finditer(text):
        candidate = match.group(1).upper()
        # Filter out things that look like UUIDs or hex strings
        if re.fullmatch(r"[0-9A-F]{15}", candidate) and not re.search(r"[A-F]", candidate):
            continue
        return candidate

    return None


# ---------------------------------------------------------------------------
# Supply / installation address extraction
# ---------------------------------------------------------------------------

# Labelled address line: "Supply Address: 456 Queen Street, Auckland".
# "Supply at:" is Genesis Energy's label variant.
# "Location" is Mercury's label; anchored to line start so the common noun
# elsewhere in prose cannot match.
_ADDRESS_LABEL_PATTERN = re.compile(
    r"(?:(?:Supply|Installation|Site|Premises|Property)\s*[Aa]ddress|Supply\s+at"
    r"|^[ \t]*Location)"
    r"\s*[:#\-]?\s*(.+)",
    re.IGNORECASE | re.MULTILINE,
)

# Leading unit noise the Powerswitch autocomplete chokes on: "Unit 5, ..." /
# "Flat 2, ...". Slash forms ("1/12 Queen St") are left intact — Powerswitch
# resolves those.
_UNIT_PREFIX_PATTERN = re.compile(
    r"^(?:Unit|Flat|Apt|Apartment)\s*\w+\s*[,/]\s*", re.IGNORECASE
)

# Street number at the start: "12", "12A", "1/12".
_STREET_NUMBER_PATTERN = re.compile(r"^\d+[A-Za-z]?(?:/\d+[A-Za-z]?)?\s+\S")

# NZ 4-digit postcode (word-bounded, at or near the end of the line).
_POSTCODE_PATTERN = re.compile(r"\b\d{4}\b\s*$")

# PDF row extraction can glue neighbouring cells onto the address line
# ("..., Auckland 0616 ICP 1000123456UN7C0" — seen on a real Meridian bill).
# Truncate right after the postcode (which ends an NZ address), and strip
# known non-address tails when no postcode is present.
_POSTCODE_CUT_PATTERN = re.compile(r"^(.*?,[^,]*?\b\d{4})\b")
_TRAILING_JUNK_PATTERN = re.compile(
    r"\s+(?:ICP|I\.C\.P\.?|Account|Customer|GST|Invoice)\b.*$", re.IGNORECASE
)

# NZ addressing attaches a unit letter to the street number ("129B Rangatira
# Road"). Bills print it detached ("129 B RANGATIRA ROAD") and the Powerswitch
# autocomplete then returns ZERO completions, so the whole comparison falls
# back to seeded plans. Only collapses a SINGLE letter that is itself followed
# by the street name.
_DETACHED_UNIT_LETTER_PATTERN = re.compile(r"^(\d+)\s+([A-Za-z])\s+(?=\S)")

# Street-type token, required on the mid-line fallback path only. Without it a
# phone-number run ("...call 0800 10 18 10. on electricity and gas, contact:
# Utilities Disputes on 0800") satisfies every other address check.
_STREET_TYPE_PATTERN = re.compile(
    r"\b(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Lane|Ln|Place|Pl|Terrace|Tce"
    r"|Crescent|Cres|Way|Grove|Close|Court|Ct|Parade|Quay|Highway|Hwy"
    r"|Boulevard|Rise|Heights|Bay|Mews|Esplanade)\b",
    re.IGNORECASE,
)

# Main NZ urban centres. Smaller towns are accepted via the postcode signal
# instead of an exhaustive gazetteer.
_NZ_CITY_TOKENS = re.compile(
    r"\b(?:Auckland|Wellington|Christchurch|Hamilton|Tauranga|Dunedin|Napier"
    r"|Hastings|Nelson|Rotorua|New\s+Plymouth|Whang[āa]rei|Invercargill"
    r"|Palmerston\s+North|Queenstown|Lower\s+Hutt|Upper\s+Hutt|Porirua"
    r"|Whanganui|Gisborne|Timaru|Blenheim|Taup[ōo]|Masterton|Ashburton"
    r"|Levin|Cambridge|Whakat[āa]ne|Pukekohe|Rangiora|Rolleston|Oamaru"
    r"|Greymouth|Richmond|Wanaka|W[āa]naka|Kerikeri|Feilding|Tokoroa"
    r"|Te\s+Awamutu|Paraparaumu|Waikanae)\b",
    re.IGNORECASE,
)


def _normalise_address(raw: str) -> Optional[str]:
    """Normalise a candidate address line; return None if low-confidence.

    Autocomplete-friendly output: street + suburb + city (+postcode), single
    spaces, no label, no leading unit noise, no trailing punctuation. A
    candidate without a street number, or without a known city token or
    postcode, is rejected — a wrong address wastes live Powerswitch budget,
    a missing one just falls back to seeded plans.
    """
    addr = re.sub(r"\s+", " ", raw).strip().strip(".,;")
    addr = _UNIT_PREFIX_PATTERN.sub("", addr)
    addr = _DETACHED_UNIT_LETTER_PATTERN.sub(r"\1\2 ", addr)
    cut = _POSTCODE_CUT_PATTERN.match(addr)
    if cut:
        addr = cut.group(1)
    addr = _TRAILING_JUNK_PATTERN.sub("", addr).strip().strip(".,;")
    if not addr or len(addr) > 120:
        return None
    if not _STREET_NUMBER_PATTERN.match(addr):
        return None
    # No NZ street number starts with 0 — a leading zero means we latched onto
    # a phone number ("0800 ...") or a postcode, not an address.
    if addr[0] == "0":
        return None
    if "," not in addr:
        return None
    if not (_NZ_CITY_TOKENS.search(addr) or _POSTCODE_PATTERN.search(addr)):
        return None
    # "AUCKLAND, 0626" → "AUCKLAND 0626" — Powerswitch autocomplete format.
    return re.sub(r",\s*(\d{4})$", r" \1", addr)


def extract_address(text: str) -> Optional[str]:
    """Extract the supply/installation address as one normalised line.

    Tries labelled lines first ("Supply Address: ..."); falls back to the
    first bare header line shaped like a street address (some retailers,
    e.g. Meridian, print the supply address unlabelled below the customer
    name). Returns None rather than a low-confidence guess.
    """
    for match in _ADDRESS_LABEL_PATTERN.finditer(text):
        candidate = match.group(1).rstrip()
        # Mercury prints "Location 14 KOWHAI STREET, BIRKDALE," then "AUCKLAND"
        # on the next line — a trailing comma means the address continues.
        if candidate.endswith(","):
            nxt = text[match.end():].lstrip("\n").split("\n", 1)[0]
            candidate = f"{candidate} {nxt.strip()}"
        addr = _normalise_address(candidate)
        if addr:
            return addr

    for line in text.splitlines():
        addr = _normalise_address(line)
        if addr:
            return addr
        # Mid-line candidate: PDF row extraction can glue a leading cell onto
        # the address ("Tax Invoice 129 B RANGATIRA ROAD, BEACH HAVEN, ..."
        # — real Electric Kiwi layout). Retry from each street-number-looking
        # token. A street-type token is REQUIRED here: without it a phone-number
        # run satisfies every other check (real Mercury footer, see
        # _STREET_TYPE_PATTERN).
        for m in re.finditer(r"\b\d{1,4}[A-Za-z]?\b", line):
            fragment = line[m.start():]
            if not _STREET_TYPE_PATTERN.search(fragment):
                continue
            addr = _normalise_address(fragment)
            if addr:
                return addr

    return None


# ---------------------------------------------------------------------------
# kWh extraction
# ---------------------------------------------------------------------------

_KWH_PATTERNS = [
    # "847 kWh" or "847kWh"
    re.compile(r"([\d,]+(?:\.\d+)?)\s*kWh", re.IGNORECASE),
    # "Usage: 847" or "Total units: 847"
    re.compile(r"(?:[Uu]sage|[Tt]otal\s*[Uu]nits|[Cc]onsumption)[\s:#-]*([\d,]+(?:\.\d+)?)"),
    # "units: 847"
    re.compile(r"([\d,]+(?:\.\d+)?)\s*units?", re.IGNORECASE),
]


def extract_kwh(text: str) -> Optional[float]:
    """Extract total kWh usage from *text*."""
    for pattern in _KWH_PATTERNS:
        match = pattern.search(text)
        if match:
            raw = match.group(1).replace(",", "")
            try:
                return float(raw)
            except ValueError:
                continue
    return None


# ---------------------------------------------------------------------------
# Time-of-use (TOU) charge components
# ---------------------------------------------------------------------------

# TOU usage-table lines on real bills (first seen on Electric Kiwi):
# "Peak Charges 98.31 kWh ...", "Off-peak Charges 175.62 kWh ...",
# "Hour of Power Savings 24.56 kWh FREE ...". NOT line-anchored — pdfplumber
# glues left-column cells onto table rows ("AUCKLAND 0626 Peak Charges ...").
_TOU_PEAK_PATTERN = re.compile(r"(?<!-)(?<!f )\bPeak\s+Charges\b[^\n]*?kWh", re.IGNORECASE)
_TOU_OFFPEAK_PATTERN = re.compile(r"\bOff[- ]?peak\s+Charges\b[^\n]*?kWh", re.IGNORECASE)
# The other NZ TOU family: "Day Rate: 300 kWh @ ..." / "Night rate usage: 180
# kWh" (Nova, Mercury, Electric Kiwi day/night plans). Same meaning as
# Peak/Off-peak, different vocabulary.
_TOU_DAY_PATTERN = re.compile(r"\bDay\s+Rate(?:\s+usage)?\b[^\n]*?kWh", re.IGNORECASE)
_TOU_NIGHT_PATTERN = re.compile(r"\bNight\s+Rate(?:\s+usage)?\b[^\n]*?kWh", re.IGNORECASE)

# Shared component label for both families.
_TOU_LABEL = (
    r"(?:(?:Peak|Off[- ]?peak|Day|Night)\s+(?:Charges|Rate(?:\s+usage)?)"
    r"|Hour of Power\s+Savings)"
)
_TOU_COMPONENT_PATTERN = re.compile(
    _TOU_LABEL + r"[^\n]*?([\d,]+(?:\.\d+)?)\s*kWh",
    re.IGNORECASE,
)


def has_tou_charges(text: str) -> bool:
    """True when the bill itemises time-of-use component lines.

    Either family counts: Peak + Off-peak, or Day + Night.
    """
    peak_offpeak = _TOU_PEAK_PATTERN.search(text) and _TOU_OFFPEAK_PATTERN.search(text)
    day_night = _TOU_DAY_PATTERN.search(text) and _TOU_NIGHT_PATTERN.search(text)
    return bool(peak_offpeak or day_night)


def extract_tou_usage(text: str) -> Optional[float]:
    """Sum TOU component kWh lines (Peak + Off-peak + free Hour of Power).

    Bills in this layout carry NO total-usage line; free kWh is still
    consumption. Returns None unless at least two component lines are found.
    """
    components = [m.group(1) for m in _TOU_COMPONENT_PATTERN.finditer(text)]
    if len(components) < 2:
        return None
    try:
        return round(sum(float(c.replace(",", "")) for c in components), 2)
    except ValueError:
        return None


# Same component lines as _TOU_COMPONENT_PATTERN, but also capturing the rest
# of the line so the component's dollar total can be read off the end.
_TOU_COMPONENT_LINE_PATTERN = re.compile(
    _TOU_LABEL + r"[^\n]*?([\d,]+(?:\.\d+)?)\s*kWh([^\n]*)",
    re.IGNORECASE,
)
_DOLLAR_AMOUNT_PATTERN = re.compile(r"\$\s*([\d,]+(?:\.\d{2})?)")


def extract_tou_blended_rate(text: str) -> Optional[float]:
    """Volume-weighted effective c/kWh across the TOU component lines.

    A TOU bill itemises Peak and Off-peak at different rates, so the single
    rate ``extract_per_kwh`` finds is whichever appears first — in practice the
    PEAK rate, which overstates the customer's real cost and skews every plan
    comparison. This blends them: total component dollars / total component
    kWh. Free kWh (Electric Kiwi's "Hour of Power") counts as consumption at
    $0, which is exactly the point of blending.

    Returns None when the bill is not TOU or the component totals cannot be
    read.
    """
    if not has_tou_charges(text):
        return None

    total_kwh = 0.0
    total_cents = 0.0
    found = 0
    for match in _TOU_COMPONENT_LINE_PATTERN.finditer(text):
        amounts = _DOLLAR_AMOUNT_PATTERN.findall(match.group(2))
        if not amounts:
            return None
        try:
            kwh = float(match.group(1).replace(",", ""))
            # The component's own total is the LAST dollar figure on the line
            # (the ones before it are the unit rate, e.g. "$0.5671/kWh $55.75").
            dollars = float(amounts[-1].replace(",", ""))
        except ValueError:
            return None
        total_kwh += kwh
        total_cents += dollars * 100
        found += 1

    if found < 2 or total_kwh <= 0:
        return None
    return round(total_cents / total_kwh, 2)


# ---------------------------------------------------------------------------
# Dollar extraction (returns integer cents)
# ---------------------------------------------------------------------------

_DOLLAR_PATTERNS = [
    # Priority 0 (highest of all): the CURRENT-PERIOD charges total. Real
    # bills with arrears put the arrears-inclusive figure under "Total amount
    # due" ("Total amount due $492.80" when this period's power was $103.09 —
    # real Contact bill), so an explicit current/new-charges label always
    # wins. `[^\n$]*` bridges mid-label noise ("(Incl GST)", "- All Services",
    # "- please pay by ...").
    (
        re.compile(
            r"(?:Total\s*current\s*charges|Total\s*new\s*(?:usage\s*)?charges"
            r"|New\s*Power\s*Charges|Current\s*charges\s*total)"
            r"[^\n$]*\$\s*([\d,]+(?:\.\d{2})?)",
            re.IGNORECASE,
        ),
        12,
    ),
    # Priority 0.5: a labelled ELECTRICITY section total. Bundled bills
    # (Mercury bills electricity + mobile on one invoice) carry several section
    # totals; the electricity one is the only figure the electricity-only
    # schema wants, and leaving it to generic scoring made it a coin-flip
    # against "MOBILE TOTAL".
    (
        re.compile(
            r"ELECTRICITY\s+TOTAL[\s:#$-]*\$?\s*([\d,]+(?:\.\d{2})?)",
            re.IGNORECASE,
        ),
        11,
    ),
    # Priority 0.6: the "to pay" / "payable" family — "Total to pay: $X"
    # (Meridian), "Amount to pay: $X" (Nova), "Total payable: $X" (Powershop),
    # "TOTAL TO PAY $X" (Electric Kiwi). The "due"-anchored pattern below
    # cannot reach any of them, and with no label matched extract_dollars falls
    # through to first-dollar-wins — which returned the DAILY CHARGE line
    # ($47.12) as a Meridian bill's total. Scored below the current-charges
    # labels (12) so a bill carrying both still prefers current charges.
    (
        re.compile(
            r"(?:Total|Amount)\s*(?:to\s*pay|payable)[\s:#$-]*\$?\s*([\d,]+(?:\.\d{2})?)",
            re.IGNORECASE,
        ),
        10,
    ),
    # Priority 1 (highest): "Total amount due $X", "Amount due $X", or
    # "Total due $X" (Contact Energy phrasing). The literal "due" bridges
    # the label and the colon before the $ figure.
    (
        re.compile(
            r"(?:[Tt]otal\s*(?:[Aa]mount\s*)?[Dd]ue|[Aa]mount\s*[Dd]ue)"
            r"[\s:#$-]*\$?\s*([\d,]+(?:\.\d{2})?)"
        ),
        10,
    ),
    # Priority 2: "Total charges $X" or "Electricity charge $X"
    (re.compile(r"(?:[Tt]otal\s*[Cc]harges?|[Ee]lectricity\s*[Cc]harges?)[\s:#$-]*\$?\s*([\d,]+(?:\.\d{2})?)"), 9),
    # Priority 3: "Your bill: $X" or "Your bill $X"
    (re.compile(r"[Yy]our\s*[Bb]ill[\s:#$-]*\$?\s*([\d,]+(?:\.\d{2})?)"), 8),
    # Priority 4: "Total: $X" (exclude "Total amount due" / "Total due",
    # which are already captured by Priority 1).
    # `\b` before Total: without it this matched inside "Subtotal" and scored
    # the ex-GST subtotal as though it were the bill total (real Mercury bill).
    (re.compile(r"(?<!\bAmount\s)(?<!\bamount\s)(?<!\bDue\s)(?<!\bdue\s)\b[Tt]otal[\s:#$-]*\$?\s*([\d,]+(?:\.\d{2})?)"), 7),
    # Priority 5: Generic "$X.XX" dollar amounts (catch-all)
    (re.compile(r"\$\s*([\d,]+(?:\.\d{2})?)"), 1),
    # Priority 6 (lowest): "Balance $X" (can be opening/previous balance, not current)
    (re.compile(r"[Bb]alance[\s:#$-]*\$?\s*([\d,]+(?:\.\d{2})?)"), 0),
    # Negative match: "Opening balance" — exclude these
    (re.compile(r"[Oo]pening\s*[Bb]alance[\s:#$-]*\$?\s*([\d,]+(?:\.\d{2})?)"), -5),
]

# Label keywords that indicate this is NOT the bill total
_NON_TOTAL_LABELS = re.compile(
    r"(?:[Oo]pening\s*[Bb]alance|[Pp]revious\s*[Bb]alance|[Ll]ast\s*[Bb]ill"
    r"|[Ss]ubtotal)",
)


def extract_dollars(text: str) -> Optional[int]:
    """Extract the bill total in integer cents.

    Uses weighted patterns to prefer the actual total over opening balances
    or other non-total amounts. When multiple amounts are found, the
    highest-scoring amount is returned.
    """
    scored: dict[int, int] = {}  # cents -> cumulative score

    for pattern, weight in _DOLLAR_PATTERNS:
        for match in pattern.finditer(text):
            # Skip matches whose full text contains non-total labels
            full_match = match.group(0)
            if weight < 0 or _NON_TOTAL_LABELS.search(full_match):
                if weight <= 0:
                    continue  # explicitly excluded
            raw = match.group(1).replace(",", "")
            try:
                cents = int(round(float(raw) * 100))
            except ValueError:
                continue
            # A bill total of $0.00 is never the answer. Without this the
            # Mercury layout returned 0: "Opening balance total $0.00" and the
            # mobile section's "TOTAL $0.00" both scored as totals and
            # out-weighed the real figure.
            if cents == 0:
                continue
            scored[cents] = scored.get(cents, 0) + weight

    if not scored:
        return None

    # Return the amount with the highest cumulative score
    return max(scored, key=lambda k: scored[k])


# ---------------------------------------------------------------------------
# Date extraction
# ---------------------------------------------------------------------------

_DATE_PATTERNS = [
    # "14 May 2026 - 13 Jun 2026" or "14/05/2026 to 13/06/2026"
    re.compile(
        r"(\d{1,2}[/\-\s][A-Za-z]{3,9}[/\-\s]\d{2,4})\s*[-–to]+\s*(\d{1,2}[/\-\s][A-Za-z]{3,9}[/\-\s]\d{2,4})",
        re.IGNORECASE,
    ),
    # "Period: 14 May 2026 - 13 Jun 2026"
    re.compile(
        r"[Pp]eriod[\s:#-]*(\d{1,2}[/\-\s][A-Za-z]{3,9}[/\-\s]\d{2,4})\s*[-–to]+\s*(\d{1,2}[/\-\s][A-Za-z]{3,9}[/\-\s]\d{2,4})"
    ),
    # ISO-style: "2026-04-01 to 2026-04-30"
    re.compile(
        r"(\d{4}-\d{2}-\d{2})\s*[-–to]+\s*(\d{4}-\d{2}-\d{2})"
    ),
    # Simple numeric: "01/04/2026 - 30/04/2026"
    re.compile(
        r"(\d{2}/\d{2}/\d{4})\s*[-–to]+\s*(\d{2}/\d{2}/\d{4})"
    ),
    # "Billing period: 14 May to 13 Jun 2026"
    re.compile(
        r"(\d{1,2}\s+[A-Za-z]{3,9})\s*[-–to]+\s*(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})",
        re.IGNORECASE,
    ),
    # "for period ending 14 May 2026" — just the end date
    re.compile(
        r"[Pp]eriod\s*[Ee]nd(?:ing)?[\s:#-]*(\d{1,2}[/\-\s][A-Za-z]{3,9}[/\-\s]\d{2,4})",
        re.IGNORECASE,
    ),
]


# Ordinal day suffixes ("24th Jun", "2nd Jul" — Electric Kiwi layout) defeat
# the range patterns; strip them before matching.
_ORDINAL_SUFFIX_PATTERN = re.compile(r"(\d{1,2})(?:st|nd|rd|th)\b", re.IGNORECASE)


def extract_dates(text: str) -> tuple[Optional[str], Optional[str]]:
    """Extract billing period start and end dates from *text*.

    Returns ``(period_start, period_end)`` as ISO 8601 strings, or
    ``(None, None)`` if dates cannot be found.
    """
    text = _ORDINAL_SUFFIX_PATTERN.sub(r"\1", text)
    for pattern in _DATE_PATTERNS:
        match = pattern.search(text)
        if match:
            groups = match.groups()
            if len(groups) >= 2:
                try:
                    start = sanitize_date(groups[0])
                    end = sanitize_date(groups[1])
                    return (start, end)
                except ValueError:
                    continue
            elif len(groups) == 1:
                try:
                    end = sanitize_date(groups[0])
                    return (None, end)
                except ValueError:
                    continue

    return (None, None)


# ---------------------------------------------------------------------------
# Daily charge extraction
# ---------------------------------------------------------------------------

_DAILY_CHARGE_PATTERNS = [
    # "32 Days x 291.00 cents" — Mercury/Genesis/Contact table layout. Captures
    # the RATE, not the day count. First for the same reason as the kWh twin.
    re.compile(r"\bDays?\s*[x×@]\s*([\d.]+)\s*c(?:ents?)?\b", re.IGNORECASE),
    # "Daily charge: 90.00 c/day" or "Fixed daily: $0.90/day"
    re.compile(
        r"(?:[Dd]aily\s*[Cc]harge|[Ff]ixed\s*[Dd]aily|[Dd]aily\s*[Ff]ixed)[\s:#$-]*([\d.]+)\s*(?:c|cents?)?\s*(?:/|per)\s*day",
        re.IGNORECASE,
    ),
    # "$0.90 per day"
    re.compile(r"\$\s*([\d.]+)\s*(?:/|per)\s*day", re.IGNORECASE),
    # "1.768 dollars per day" (real Contact layout) — the shared <10 → x100
    # dollars-to-cents heuristic below converts it.
    re.compile(r"([\d.]+)\s*dollars?\s*(?:/|per)\s*day", re.IGNORECASE),
    # "Daily: 90.000 c" or "90.000 cents per day"
    re.compile(r"([\d.]+)\s*c(?:ents?)?\s*(?:/|per)\s*day", re.IGNORECASE),
    # "fixed charge 90.00c". The cents unit is REQUIRED: when it was optional
    # this matched the day count in "Daily Fixed Charge 32 Days x 291.00 cents"
    # and returned 32.0 c/day on a real Mercury bill.
    re.compile(r"[Ff]ixed\s*[Cc]harge[\s:#$-]*\$?\s*([\d.]+)\s*c(?:ents?)?\b", re.IGNORECASE),
]


def extract_daily_charge(text: str) -> Optional[float]:
    """Extract the daily fixed charge in cents from *text*."""
    for pattern in _DAILY_CHARGE_PATTERNS:
        match = pattern.search(text)
        if match:
            try:
                value = float(match.group(1))
                # If the value looks like dollars (e.g., 0.90), convert to cents
                if value < 10.0:
                    return round(value * 100, 2)
                return value
            except ValueError:
                continue
    return None


# ---------------------------------------------------------------------------
# Per-kWh rate extraction
# ---------------------------------------------------------------------------

_PER_KWH_PATTERNS = [
    # "1113.88 kWh x 22.49 cents" — the usage x rate table layout used by
    # Mercury, Genesis and Contact. Captures the RATE, not the usage. First
    # because it is the most reliable signal on those layouts.
    re.compile(
        r"[\d,]+(?:\.\d+)?\s*kWh\s*[x×@]\s*([\d.]+)\s*c(?:ents?)?\b",
        re.IGNORECASE,
    ),
    # "25.50 c/kWh" or "25.50 c per kWh"
    re.compile(r"([\d.]+)\s*c(?:ents?)?\s*(?:/|per)\s*kWh", re.IGNORECASE),
    # "Variable: 25.50 c/kWh". `$` is deliberately NOT in the separator class
    # and the unit is word-bounded: the old form matched "Variable $329.07
    # credit" on a real Mercury bill (a customer PAYMENT, with the trailing `c`
    # gluing onto "credit") and returned 329.07 as a cents-per-kWh rate.
    re.compile(r"[Vv]ariable[\s:#-]*([\d.]+)\s*c(?:ents?)?\b", re.IGNORECASE),
    # "Energy charge: 25.500 c/kWh"
    re.compile(r"[Ee]nergy\s*[Cc]harge[\s:#-]*([\d.]+)\s*c(?:ents?)?\b", re.IGNORECASE),
    # "25.50 cents per unit"
    re.compile(r"([\d.]+)\s*c(?:ents?)?\s*(?:/|per)\s*unit", re.IGNORECASE),
]


# Dollar-denominated rate: "$0.5671/kWh" (Electric Kiwi layout). Converted
# to cents before joining the shared candidate pool.
_PER_KWH_DOLLAR_PATTERN = re.compile(r"\$\s*([\d.]+)\s*(?:/|per)\s*kWh", re.IGNORECASE)


def extract_per_kwh(text: str) -> Optional[float]:
    """Extract the effective per-kWh rate in cents from *text*.

    On a time-of-use bill the itemised rates differ (Peak/Off-peak, Day/Night)
    and picking whichever appears first returns the EXPENSIVE one, overstating
    the customer's real cost. TOU bills therefore resolve to the
    volume-weighted blended rate — the only figure that reconciles against the
    bill's own total.
    """
    blended = extract_tou_blended_rate(text)
    if blended is not None:
        return blended

    candidates = []
    for match in _PER_KWH_DOLLAR_PATTERN.finditer(text):
        try:
            candidates.append(round(float(match.group(1)) * 100, 2))
        except ValueError:
            continue
    for pattern in _PER_KWH_PATTERNS:
        for match in pattern.finditer(text):
            try:
                value = float(match.group(1))
                candidates.append(value)
            except ValueError:
                continue

    if not candidates:
        return None

    # Return the most common NZ residential rate (typically 20-35 c/kWh). If
    # nothing lands in the plausible window, return None rather than the first
    # candidate: the caller already handles a missing field, whereas a garbage
    # rate silently corrupts every downstream plan comparison (a real Mercury
    # bill yielded 329.07 c/kWh this way — it was a customer payment).
    residential_candidates = [c for c in candidates if 10.0 <= c <= 60.0]
    if residential_candidates:
        return residential_candidates[0]
    return None


# ---------------------------------------------------------------------------
# Plan name extraction
# ---------------------------------------------------------------------------

_PLAN_NAME_PATTERNS = [
    re.compile(r"[Pp]lan\s*[Nn]ame[\s:#-]*(\S[\s\S]{0,40}?)(?:\n|$)", re.IGNORECASE),
    # Require an explicit separator after "Plan" — a bare space matched prose
    # ("...check you are on the right plan for your needs" in the Billy
    # footer on real bills) and returned garbage plan names.
    re.compile(r"[Pp]lan\s*[:#-]\s*(\S[\s\S]{0,40}?)(?:\n|$)", re.IGNORECASE),
    # Bare keyword, but ONLY in plan context. With the trailing "Plan"
    # optional this matched the word "online" inside "Access your account
    # online at:" on a real Mercury bill and returned it as the plan name.
    # A wrong plan name is worse than none — it feeds the comparator.
    re.compile(
        r"(?:Standard|Low\s*User|Day\s*Night|Controlled|Economy|Classic|Anytime"
        r"|Online|Saver|Freedom|Basic|Everyday)\s*(?:Plan|Pricing|Tariff|Product)\b"
        r"|(?:Plan|Pricing|Tariff|Product)\s*[:\-]?\s*"
        r"(?:Standard|Low\s*User|Day\s*Night|Controlled|Economy|Classic|Anytime"
        r"|Online|Saver|Freedom|Basic|Everyday)\b",
        re.IGNORECASE,
    ),
]


def extract_plan_name(text: str) -> Optional[str]:
    """Extract the plan name from *text*."""
    for pattern in _PLAN_NAME_PATTERNS:
        match = pattern.search(text)
        if match:
            # Prefer the captured value over the whole match: the labelled
            # patterns capture the plan in group 1, and group(0) dragged the
            # label in with it ("Plan: Standard User" instead of "Standard
            # User"), which is what then reached the user in messages.
            name = (match.group(1) if match.groups() else match.group(0)).strip()
            # Clean up common suffixes
            name = re.sub(r"\s*(?:Plan|Product)\s*$", "", name, flags=re.IGNORECASE)
            if len(name) >= 3:
                return name[:80]  # Cap length
    return None


# ---------------------------------------------------------------------------
# Meter type detection
# ---------------------------------------------------------------------------

_LOW_USER_PATTERNS = [
    re.compile(r"Low\s*User", re.IGNORECASE),
    re.compile(r"Low\s*Usage", re.IGNORECASE),
    re.compile(r"Low\s*Fixed", re.IGNORECASE),
]

_DAY_NIGHT_PATTERNS = [
    re.compile(r"Day\s*Night", re.IGNORECASE),
    re.compile(r"Day\s*/\s*Night", re.IGNORECASE),
    re.compile(r"Night\s*Rate", re.IGNORECASE),
    re.compile(r"Day\s*Rate\s*.*Night\s*Rate", re.IGNORECASE),
]

_CONTROLLED_PATTERNS = [
    re.compile(r"Controlled", re.IGNORECASE),
    re.compile(r"Night\s*Only", re.IGNORECASE),
    re.compile(r"Off[\s-]*Peak", re.IGNORECASE),
    re.compile(r"Hot\s*Water\s*(?:Only|Plan)", re.IGNORECASE),
]


def extract_meter_type(text: str) -> str:
    """Determine meter type from *text*.

    Returns one of: ``standard``, ``low_user``, ``day_night``, ``controlled``.
    Defaults to ``standard``.
    """
    for pattern in _LOW_USER_PATTERNS:
        if pattern.search(text):
            return "low_user"

    # Itemised Peak + Off-peak charge lines = a TOU meter. Checked before the
    # controlled patterns because "Off-peak" would otherwise false-match the
    # controlled-load "Off Peak" pattern (real Electric Kiwi bill).
    if has_tou_charges(text):
        return "day_night"

    for pattern in _DAY_NIGHT_PATTERNS:
        if pattern.search(text):
            return "day_night"

    for pattern in _CONTROLLED_PATTERNS:
        if pattern.search(text):
            return "controlled"

    return "standard"
