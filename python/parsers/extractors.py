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
# Dollar extraction (returns integer cents)
# ---------------------------------------------------------------------------

_DOLLAR_PATTERNS = [
    # Priority 1 (highest): "Total amount due $X" or "Amount due $X"
    (re.compile(r"(?:[Tt]otal\s*[Aa]mount\s*[Dd]ue|[Aa]mount\s*[Dd]ue)[\s:#$-]*\$?\s*([\d,]+(?:\.\d{2})?)"), 10),
    # Priority 2: "Total charges $X" or "Electricity charge $X"
    (re.compile(r"(?:[Tt]otal\s*[Cc]harges?|[Ee]lectricity\s*[Cc]harges?)[\s:#$-]*\$?\s*([\d,]+(?:\.\d{2})?)"), 9),
    # Priority 3: "Your bill: $X" or "Your bill $X"
    (re.compile(r"[Yy]our\s*[Bb]ill[\s:#$-]*\$?\s*([\d,]+(?:\.\d{2})?)"), 8),
    # Priority 4: "Total: $X" (but not "Total amount due" which is already captured)
    (re.compile(r"(?<!\bAmount\s)(?<!\bamount\s)[Tt]otal[\s:#$-]*\$?\s*([\d,]+(?:\.\d{2})?)"), 7),
    # Priority 5: Generic "$X.XX" dollar amounts (catch-all)
    (re.compile(r"\$\s*([\d,]+(?:\.\d{2})?)"), 1),
    # Priority 6 (lowest): "Balance $X" (can be opening/previous balance, not current)
    (re.compile(r"[Bb]alance[\s:#$-]*\$?\s*([\d,]+(?:\.\d{2})?)"), 0),
    # Negative match: "Opening balance" — exclude these
    (re.compile(r"[Oo]pening\s*[Bb]alance[\s:#$-]*\$?\s*([\d,]+(?:\.\d{2})?)"), -5),
]

# Label keywords that indicate this is NOT the bill total
_NON_TOTAL_LABELS = re.compile(
    r"(?:[Oo]pening\s*[Bb]alance|[Pp]revious\s*[Bb]alance|[Ll]ast\s*[Bb]ill)",
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
                scored[cents] = scored.get(cents, 0) + weight
            except ValueError:
                continue

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


def extract_dates(text: str) -> tuple[Optional[str], Optional[str]]:
    """Extract billing period start and end dates from *text*.

    Returns ``(period_start, period_end)`` as ISO 8601 strings, or
    ``(None, None)`` if dates cannot be found.
    """
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
    # "Daily charge: 90.00 c/day" or "Fixed daily: $0.90/day"
    re.compile(
        r"(?:[Dd]aily\s*[Cc]harge|[Ff]ixed\s*[Dd]aily|[Dd]aily\s*[Ff]ixed)[\s:#$-]*([\d.]+)\s*(?:c|cents?)?\s*(?:/|per)\s*day",
        re.IGNORECASE,
    ),
    # "$0.90 per day"
    re.compile(r"\$\s*([\d.]+)\s*(?:/|per)\s*day", re.IGNORECASE),
    # "Daily: 90.000 c" or "90.000 cents per day"
    re.compile(r"([\d.]+)\s*c(?:ents?)?\s*(?:/|per)\s*day", re.IGNORECASE),
    # "fixed charge 90.00c"
    re.compile(r"[Ff]ixed\s*[Cc]harge[\s:#$-]*\$?\s*([\d.]+)\s*c?", re.IGNORECASE),
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
    # "25.50 c/kWh" or "25.50 c per kWh"
    re.compile(r"([\d.]+)\s*c(?:ents?)?\s*(?:/|per)\s*kWh", re.IGNORECASE),
    # "Variable: 25.50 c/kWh"
    re.compile(r"[Vv]ariable[\s:#$-]*([\d.]+)\s*c", re.IGNORECASE),
    # "Energy charge: 25.500 c/kWh"
    re.compile(r"[Ee]nergy\s*[Cc]harge[\s:#$-]*([\d.]+)\s*c", re.IGNORECASE),
    # "25.50 cents per unit"
    re.compile(r"([\d.]+)\s*c(?:ents?)?\s*(?:/|per)\s*unit", re.IGNORECASE),
]


def extract_per_kwh(text: str) -> Optional[float]:
    """Extract the per-kWh rate in cents from *text*."""
    candidates = []
    for pattern in _PER_KWH_PATTERNS:
        for match in pattern.finditer(text):
            try:
                value = float(match.group(1))
                candidates.append(value)
            except ValueError:
                continue

    if not candidates:
        return None

    # Return the most common NZ residential rate (typically 20-35 c/kWh)
    # or the first found if none in that range
    residential_candidates = [c for c in candidates if 10.0 <= c <= 60.0]
    if residential_candidates:
        return residential_candidates[0]
    return candidates[0]


# ---------------------------------------------------------------------------
# Plan name extraction
# ---------------------------------------------------------------------------

_PLAN_NAME_PATTERNS = [
    re.compile(r"[Pp]lan\s*[Nn]ame[\s:#-]*(\S[\s\S]{0,40}?)(?:\n|$)", re.IGNORECASE),
    re.compile(r"[Pp]lan[\s:#-]*(\S[\s\S]{0,40}?)(?:\n|$)", re.IGNORECASE),
    re.compile(
        r"(?:Standard|Low\s*User|Day\s*Night|Controlled|Economy|Classic|Anytime|Online|Saver|Freedom|Basic|Everyday)(?:\s*Plan)?",
        re.IGNORECASE,
    ),
]


def extract_plan_name(text: str) -> Optional[str]:
    """Extract the plan name from *text*."""
    for pattern in _PLAN_NAME_PATTERNS:
        match = pattern.search(text)
        if match:
            name = match.group(0).strip()
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

    for pattern in _DAY_NIGHT_PATTERNS:
        if pattern.search(text):
            return "day_night"

    for pattern in _CONTROLLED_PATTERNS:
        if pattern.search(text):
            return "controlled"

    return "standard"
