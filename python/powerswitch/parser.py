"""
Powerswitch HTML plan parser (#67).

Extracts rate components from saved Powerswitch plan HTML snapshots into
Flip's normalized plan-schema dicts (matching the ``plans`` D1 table columns).

REUSES ``RETAILER_MAP``, ``NZ_REGIONS``, ``NETWORK_CODE_TO_REGION`` and
``_to_bool`` from ``eiep14a.parser`` — do not duplicate (#65).

Money convention (matches ``plans`` table + ``ParserResult``):
- ``c_per_kwh`` / ``c_per_day`` → float cents (e.g. 29.10 c/kWh).
- ``exit_fee_cents`` (in conditions_json) → integer cents NZD.

Unlike eiep14a's ``_safe_float`` (which silently defaults missing money to
0.0), the Powerswitch path treats a missing required money field as a
FAILURE — see ``completeness.py`` and ``_require_money``.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from bs4 import BeautifulSoup

# Reuse eiep14a helpers — single source of truth (#65).
from eiep14a.parser import (
    NZ_REGIONS,
    NETWORK_CODE_TO_REGION,
    RETAILER_MAP,
    _normalise_retailer,
    _retailer_name_to_id,
    _to_bool,
)

logger = logging.getLogger(__name__)

# Powerswitch user-type segmentation. A plan's "region" classification is
# one of these alongside the geographic region.
USER_TYPES = frozenset({"low_user", "standard", "user"})


class ParsedPlan:
    """Intermediate parse result before normalization to a plan row.

    Money fields stay ``None`` when absent so the completeness gate can
    distinguish "missing" from a genuine zero (the eiep14a parser cannot).
    """

    __slots__ = (
        "retailer",
        "retailer_id",
        "plan_name",
        "region",
        "user_type",
        "c_per_kwh",
        "c_per_day",
        "prompt_payment_discount",
        "low_user_eligible",
        "is_tou",
        "exit_fee_cents",
        "gst_inclusive",
        "term_months",
        "source_url",
        "missing_fields",
    )

    def __init__(self) -> None:
        self.retailer: str = ""
        self.retailer_id: str = ""
        self.plan_name: str = ""
        self.region: str = "National"
        self.user_type: str = "standard"
        self.c_per_kwh: Optional[float] = None
        self.c_per_day: Optional[float] = None
        self.prompt_payment_discount: Optional[float] = None
        self.low_user_eligible: bool = False
        self.is_tou: bool = False
        self.exit_fee_cents: Optional[int] = None
        self.gst_inclusive: bool = True
        self.term_months: Optional[int] = None
        self.source_url: Optional[str] = None
        self.missing_fields: list[str] = []


def parse_powerswitch_html(
    html: str,
    source_url: Optional[str] = None,
) -> list[dict]:
    """Parse a Powerswitch HTML snapshot into normalized plan rows.

    Args:
        html: Raw HTML (a single Powerswitch plan page).
        source_url: Origin URL for the snapshot (#63 ``source_url`` column).

    Returns:
        List of plan dicts matching the ``plans`` D1 table schema, each with
        ``provenance='powerswitch'`` and ``source_url`` set. Plans failing
        the required-money completeness check are omitted (logged); callers
        that need the failure accounting should use ``completeness.score_run``.
    """
    from powerswitch.completeness import is_complete

    parsed = _extract_plan(html, source_url=source_url)
    if parsed is None:
        logger.warning("Powerswitch HTML yielded no plan card: %s", source_url)
        return []

    if not is_complete(parsed)[0]:
        logger.warning(
            "Skipping incomplete Powerswitch plan %r (%s): missing %s",
            parsed.plan_name,
            source_url,
            parsed.missing_fields,
        )
        return []

    return [_to_plan_row(parsed)]


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------


def _extract_plan(
    html: str,
    source_url: Optional[str] = None,
) -> Optional[ParsedPlan]:
    """Extract a single ParsedPlan from Powerswitch HTML.

    Returns ``None`` if no ``.plan-card`` element is present (the page is
    structurally drifted or otherwise unparseable).
    """
    soup = BeautifulSoup(html, "html.parser")
    card = soup.select_one(".plan-card")
    if card is None:
        return None

    plan = ParsedPlan()
    plan.source_url = source_url

    # Retailer, plan name, region — prefer data-* on the card, then <meta>,
    # then visible headings.
    retailer_raw = (
        card.get("data-retailer")
        or _meta_content(soup, "retailer")
        or _heading_text(soup, "h1")
        or ""
    )
    plan.retailer = _normalise_retailer(str(retailer_raw))
    plan.retailer_id = _retailer_name_to_id(plan.retailer)

    plan.plan_name = str(
        card.get("data-plan-name")
        or _meta_content(soup, "plan-name")
        or _heading_text(soup, "h2.plan-name")
        or ""
    ).strip()

    region_raw = str(
        card.get("data-region")
        or _meta_content(soup, "region")
        or ""
    ).strip()
    plan.region = _normalise_region(region_raw)

    # User-type segmentation (low_user / standard / user).
    plan.user_type = _classify_user_type(plan, card)

    # Required money fields. None if absent — completeness gate enforces.
    plan.c_per_kwh = _data_float(card, "data-variable-rate")
    plan.c_per_day = _data_float(card, "data-daily-charge")

    # Optional money / discount fields.
    plan.prompt_payment_discount = _data_float(card, "data-prompt-payment-discount")
    plan.low_user_eligible = _to_bool(
        card.get("data-low-user-eligible", default=False)
    )
    plan.is_tou = _to_bool(card.get("data-tou", default=False))

    # Exit fee (integer cents). Optional.
    exit_raw = card.get("data-exit-fee")
    if exit_raw:
        plan.exit_fee_cents = _to_int_cents(exit_raw)

    # GST inclusiveness. Powerswitch quotes GST-inclusive prices by default.
    gst_raw = card.get("data-gst-inclusive")
    plan.gst_inclusive = _to_bool(gst_raw) if gst_raw else True

    # Contract term (months). Optional.
    term_raw = card.get("data-term-months")
    if term_raw:
        plan.term_months = _safe_int(term_raw)

    return plan


def _normalise_region(raw: str) -> str:
    """Normalise a region string. Reuses eiep14a NETWORK_CODE_TO_REGION +
    NZ_REGIONS (#65) for consistency across ingestion paths."""
    cleaned = raw.strip()
    if not cleaned:
        return "National"

    code = NETWORK_CODE_TO_REGION.get(cleaned.upper())
    if code is not None:
        return code

    if cleaned in NZ_REGIONS:
        return cleaned
    lower = cleaned.lower()
    for region in NZ_REGIONS:
        if region.lower() == lower:
            return region

    return cleaned


def _classify_user_type(plan: ParsedPlan, card) -> str:
    """Classify the Powerswitch user-type segmentation.

    Powerswitch segments plans by low-user vs standard-user tariffs. The
    ``data-low-user-eligible`` flag is the primary signal; the plan name is
    a secondary hint (e.g. "... Low User").
    """
    if _to_bool(card.get("data-low-user-eligible", default=False)):
        return "low_user"
    name_lower = plan.plan_name.lower()
    if "low user" in name_lower or "low-user" in name_lower:
        return "low_user"
    if "standard" in name_lower:
        return "standard"
    return "user"


# ---------------------------------------------------------------------------
# Money helpers
# ---------------------------------------------------------------------------

_MONEY_RE = re.compile(r"-?\d+(?:\.\d+)?")


def _data_float(card, attr: str) -> Optional[float]:
    """Read a float from a ``data-*`` attribute. None if absent/unparseable."""
    raw = card.get(attr)
    if raw is None or str(raw).strip() == "":
        return None
    match = _MONEY_RE.search(str(raw))
    if match is None:
        return None
    try:
        return float(match.group(0))
    except (ValueError, TypeError):
        return None


def _to_int_cents(raw) -> Optional[int]:
    """Convert a dollar/cents value to integer cents NZD."""
    match = _MONEY_RE.search(str(raw))
    if match is None:
        return None
    try:
        return int(round(float(match.group(0)) * 100))
    except (ValueError, TypeError):
        return None


def _safe_int(value) -> int:
    """Safely convert a value to int, defaulting to 0."""
    if value is None:
        return 0
    try:
        return int(value)
    except (ValueError, TypeError):
        return 0


# ---------------------------------------------------------------------------
# Soup helpers
# ---------------------------------------------------------------------------


def _meta_content(soup, name: str) -> Optional[str]:
    meta = soup.select_one(f'meta[name="{name}"]')
    if meta is None:
        return None
    content = meta.get("content")
    return str(content).strip() if content else None


def _heading_text(soup, selector: str) -> Optional[str]:
    el = soup.select_one(selector)
    if el is None:
        return None
    text = el.get_text(strip=True)
    return text or None


# ---------------------------------------------------------------------------
# Row normalization
# ---------------------------------------------------------------------------


def _to_plan_row(plan: ParsedPlan) -> dict:
    """Convert a complete ParsedPlan into a ``plans``-table schema dict.

    Money fields follow the plans-table / eiep14a convention: c_per_kwh and
    c_per_day as float cents. exit_fee_cents (integer cents) and
    gst_inclusive live inside ``conditions_json`` — they are NOT top-level
    columns (no migration adds them; #63 migration 0013 did not).
    """
    now = datetime.now(timezone.utc).isoformat()

    conditions: dict = {
        "gst_inclusive": plan.gst_inclusive,
        "user_type": plan.user_type,
        "is_tou": plan.is_tou,
    }
    if plan.exit_fee_cents is not None:
        conditions["exit_fee_cents"] = plan.exit_fee_cents
    if plan.term_months is not None:
        conditions["fixed_term_months"] = plan.term_months

    low_user_eligible = 1 if (plan.user_type == "low_user" or plan.low_user_eligible) else 0

    return {
        "id": str(uuid.uuid4()),
        "retailer_id": plan.retailer_id,
        "name": plan.plan_name,
        "region": plan.region,
        "c_per_kwh": plan.c_per_kwh,
        "c_per_day": plan.c_per_day,
        "tier_thresholds_json": "[]",
        "prompt_payment_discount": plan.prompt_payment_discount,
        "conditions_json": json.dumps(conditions),
        "low_user_eligible": low_user_eligible,
        "source": "powerswitch",
        "eiep14a_id": None,
        "source_url": plan.source_url,
        "provenance": "powerswitch",
        "effective_from": now,
        "effective_to": None,
        "ingested_at": now,
        "content_hash": None,
        "is_current": True,
    }
