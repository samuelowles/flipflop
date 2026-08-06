"""
Base parser module for Flip bill parsing.

Defines the ParserResult dataclass (matching the bills D1 schema),
the abstract BaseParser class, shared validation functions, and a
retailer parser factory.

All monetary values are in integer cents (NZD). All dates are ISO 8601.
"""

from __future__ import annotations

import abc
import dataclasses
import json
import re
from datetime import datetime
from typing import Optional


# ---------------------------------------------------------------------------
# ParserResult dataclass
# ---------------------------------------------------------------------------

@dataclasses.dataclass
class ParserResult:
    """Structured result from a bill parser, matching the bills D1 schema.

    All monetary fields are integer cents (NZD).  All date fields are
    ISO 8601 strings.  ``fixed_term_expiry`` may be ``None`` when no
    fixed term applies.
    """

    retailer: str
    plan_name: str
    meter_type: str  # one of: standard, low_user, day_night, controlled
    icp_number: str  # 15-digit NZ ICP number
    period_start: str  # ISO 8601
    period_end: str  # ISO 8601
    days: int
    usage_kwh: float
    total_cents: int  # integer cents NZD
    c_per_kwh: float  # effective rate
    c_per_day: float  # fixed daily charge
    fixed_term_expiry: Optional[str]  # ISO 8601 or None
    break_fee_cents: int
    confidence: float  # 0.0 - 1.0
    raw_json: str  # full parser output as JSON string
    parser_used: Optional[str] = None  # id of parser that produced this result
    # Supply/installation address, one normalised autocomplete-friendly line
    # ("1 Queen Street, Auckland Central, Auckland 1010"), or None when not
    # confidently extractable.
    address: Optional[str] = None
    # Relative disagreement between the bill's line items and its stated total
    # (see reconcile_total). None when the bill states too little to check.
    # Diagnostic only — the enforcement is the confidence cap in __post_init__.
    reconciliation_delta: Optional[float] = None

    def __post_init__(self) -> None:
        """Gate confidence on whether the extracted fields agree with each other.

        `confidence` alone counts how many fields were FOUND, not whether they
        are RIGHT — a real Mercury bill scored 0.818 while its rate, daily
        charge and total were all wrong. Reconciliation is the missing
        correctness signal: a bill whose own line items cannot produce its own
        stated total has at least one mis-extracted field, so it must not be
        auto-accepted no matter how many fields were populated.
        """
        self.reconciliation_delta = reconcile_total(
            self.usage_kwh, self.c_per_kwh, self.days, self.c_per_day, self.total_cents
        )
        if (
            self.reconciliation_delta is not None
            and self.reconciliation_delta > RECONCILE_TOLERANCE
        ):
            self.confidence = min(self.confidence, RECONCILE_FAIL_CONFIDENCE)

    VALID_METER_TYPES = frozenset(
        {"standard", "low_user", "day_night", "controlled"}
    )

    def to_json(self) -> str:
        """Serialize the result to a JSON string (excluding raw_json to
        avoid double-wrapping)."""
        as_dict = dataclasses.asdict(self)
        return json.dumps(as_dict, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Abstract base parser
# ---------------------------------------------------------------------------


class BaseParser(abc.ABC):
    """Abstract base for retailer-specific bill parsers.

    Subclasses must implement ``parse``, which takes a local file path
    (PDF or image) and returns a fully-populated ``ParserResult``.
    """

    @abc.abstractmethod
    def parse(self, file_path: str) -> ParserResult:
        """Parse a bill file and return a structured result."""
        ...


# ---------------------------------------------------------------------------
# Shared validation helpers (pure functions)
# ---------------------------------------------------------------------------


def validate_nz_mobile(phone: str) -> bool:
    """Return ``True`` if *phone* looks like a valid NZ mobile number.

    Accepted prefixes:
    * ``+64`` followed by 8-10 digits (the leading '0' of the local
      prefix is dropped)
    * ``0`` followed by 8-10 digits (standard local format, e.g. 021...)

    Whitespace and hyphens are stripped before validation.
    """
    cleaned = re.sub(r"[\s\-]", "", phone.strip())

    if cleaned.startswith("+64"):
        # +64 then 8-10 digits → total length 11-13
        if not re.fullmatch(r"\+64\d{8,10}", cleaned):
            return False
    elif cleaned.startswith("0"):
        # 0 then 8-10 digits → total length 9-11
        if not re.fullmatch(r"0\d{8,10}", cleaned):
            return False
    else:
        return False

    # Second digit (after +64 or 0) should be 2 for NZ mobiles
    if cleaned.startswith("+64"):
        return len(cleaned) >= 12 and cleaned[3] == "2"
    else:
        return len(cleaned) >= 10 and cleaned[1] == "2"


def validate_icp_number(icp: str) -> bool:
    """Return ``True`` if *icp* is a 15-character alphanumeric NZ ICP number."""
    return bool(re.fullmatch(r"[A-Za-z0-9]{15}", icp.strip()))


def validate_kwh_range(kwh: float) -> bool:
    """Return ``True`` if *kwh* is in [0, 100000]."""
    return 0.0 <= kwh <= 100_000.0


def validate_cents_range(cents: int) -> bool:
    """Return ``True`` if *cents* is in [0, 10_000_000] (max $100,000 bill)."""
    return 0 <= cents <= 10_000_000


def validate_c_per_kwh(rate: float) -> bool:
    """Return ``True`` if *rate* is in [10, 60] (cents per kWh)."""
    return 10.0 <= rate <= 60.0


def validate_c_per_day(rate: float) -> bool:
    """Return ``True`` if *rate* is in [0, 500] (cents per day)."""
    return 0.0 <= rate <= 500.0


# ---------------------------------------------------------------------------
# Self-consistency (the correctness gate)
# ---------------------------------------------------------------------------

# How far the line items may miss the stated total before the parse is
# untrustworthy. Every field-level extraction error observed so far landed
# 18-37% out, while correctly-parsed real bills land under 1%, so 10% catches
# the whole observed failure class with room for real-bill noise: EA levies,
# prompt-payment credits, mid-period rate changes and rounding.
RECONCILE_TOLERANCE = 0.10

# Confidence assigned when reconciliation fails. Must sit below the Worker's
# auto-accept threshold (F1_HINT_CONFIDENCE_THRESHOLD, default 0.85) so the
# bill routes to needs_review instead of producing a wrong recommendation.
RECONCILE_FAIL_CONFIDENCE = 0.5


def reconcile_total(
    usage_kwh: Optional[float],
    c_per_kwh: Optional[float],
    days: Optional[int],
    c_per_day: Optional[float],
    total_cents: Optional[int],
) -> Optional[float]:
    """Relative disagreement between a bill's line items and its stated total.

    ``usage_kwh x c_per_kwh + days x c_per_day`` should reproduce
    ``total_cents``. Both GST conventions are accepted — rates quoted
    GST-exclusive (total = items x 1.15) or GST-inclusive (total = items) —
    and the closer of the two is used, because which one a bill uses is not
    reliably stated.

    Returns ``None`` when the bill states too little to check (any input
    missing or zero), ``1.0`` when line items exist but the total is zero or
    negative (a zero total is never trustworthy), otherwise the relative error
    as a fraction of the stated total.
    """
    parts = (usage_kwh, c_per_kwh, days, c_per_day)
    if any(p is None or p == 0 for p in parts):
        return None

    items = usage_kwh * c_per_kwh + days * c_per_day  # type: ignore[operator]
    if items <= 0:
        return None
    if total_cents is None or total_cents <= 0:
        return 1.0

    closest = min(abs(items - total_cents), abs(items * 1.15 - total_cents))
    return closest / total_cents


# ---------------------------------------------------------------------------
# Date sanitization
# ---------------------------------------------------------------------------

# Ordered from most to least specific / least ambiguous.
_DATE_FORMATS = (
    "%Y-%m-%d",     # 2026-05-14 (ISO 8601)
    "%d/%m/%Y",     # 14/05/2026  (NZ day/month/year)
    "%d-%m-%Y",     # 14-05-2026
    "%d %b %Y",     # 14 May 2026
    "%d %B %Y",     # 14 May 2026 (full month)
    "%b %d, %Y",    # May 14, 2026
    "%B %d, %Y",    # May 14, 2026
    "%Y%m%d",       # 20260514
    "%d %b %y",     # 24 Jun 26 (Electric Kiwi tax-invoice header)
    "%d %B %y",     # 24 June 26
)


def sanitize_date(date_str: str) -> str:
    """Parse *date_str* with common date formats and return ISO 8601.

    Raises ``ValueError`` if the string cannot be parsed.
    """
    stripped = date_str.strip()
    if not stripped:
        raise ValueError("Empty date string")

    for fmt in _DATE_FORMATS:
        try:
            dt = datetime.strptime(stripped, fmt)
            return dt.strftime("%Y-%m-%d")
        except ValueError:
            continue

    raise ValueError(f"Cannot parse date: {date_str!r}")


# ---------------------------------------------------------------------------
# Retailer parser factory
# ---------------------------------------------------------------------------

# Map of retailer_id → parser class (populated as parsers are built).
_PARSER_REGISTRY: dict[str, type[BaseParser]] = {}


def register_parser(retailer_id: str, parser_cls: type[BaseParser]) -> None:
    """Register a parser class for a retailer."""
    _PARSER_REGISTRY[retailer_id.lower()] = parser_cls


def parser_for_retailer(retailer_id: str) -> Optional[BaseParser]:
    """Return an instance of the parser for *retailer_id*, or ``None``."""
    cls = _PARSER_REGISTRY.get(retailer_id.lower())
    if cls is None:
        return None
    return cls()
