"""
EIEP14A record parser.

Transforms raw EIEP14A feed records into Flip's plan schema format
(matching the D1 ``plans`` table columns).

Deterministic transformation — NO AI/LLM.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# NZ regions as used in the electricity market
NZ_REGIONS = frozenset({
    "Northland", "Auckland", "Waikato", "Bay of Plenty", "Gisborne",
    "Hawke's Bay", "Taranaki", "Manawatu-Whanganui", "Wellington",
    "Tasman", "Nelson", "Marlborough", "West Coast", "Canterbury",
    "Otago", "Southland",
    # Common variations
    "North Island", "South Island", "National",
})

# Known retailer name normalisations
RETAILER_MAP = {
    "contact": "Contact Energy",
    "contactenergy": "Contact Energy",
    "contact energy": "Contact Energy",
    "mercury": "Mercury",
    "genesis": "Genesis Energy",
    "genesisenergy": "Genesis Energy",
    "genesis energy": "Genesis Energy",
    "meridian": "Meridian Energy",
    "meridianenergy": "Meridian Energy",
    "meridian energy": "Meridian Energy",
    "trustpower": "Trustpower",
    "nova": "Nova Energy",
    "novaenergy": "Nova Energy",
    "nova energy": "Nova Energy",
    "electrickiwi": "Electric Kiwi",
    "electric kiwi": "Electric Kiwi",
    "powershop": "Powershop",
    "flick": "Flick Electric",
    "flickelectric": "Flick Electric",
    "flick electric": "Flick Electric",
    "pulse": "Pulse Energy",
    "pulseenergy": "Pulse Energy",
    "pulse energy": "Pulse Energy",
}


# ---------------------------------------------------------------------------
# Main parser
# ---------------------------------------------------------------------------


def parse_eiep14a_records(raw_records: list[dict]) -> list[dict]:
    """Transform raw EIEP14A records into Flip plan schema dicts.

    Each output dict has the columns matching the ``plans`` D1 table:
    - id, retailer_id, name, region, c_per_kwh, c_per_day,
      tier_thresholds_json, prompt_payment_discount, conditions_json,
      low_user_eligible, source, eiep14a_id

    Args:
        raw_records: List of raw dicts from the EIEP14A feed.

    Returns:
        List of transformed plan dicts ready for database insertion.
    """
    plans: list[dict] = []
    seen_ids: set[str] = set()

    for record in raw_records:
        try:
            plan = _transform_record(record)
            if plan["eiep14a_id"] in seen_ids:
                continue
            seen_ids.add(plan["eiep14a_id"])
            plans.append(plan)
        except Exception as exc:
            logger.warning("Skipping invalid EIEP14A record: %s — %s", exc, record.get("id", "no-id"))

    logger.info("Transformed %d EIEP14A records into %d plan records", len(raw_records), len(plans))
    return plans


def _transform_record(rec: dict) -> dict:
    """Transform a single raw EIEP14A record."""
    now = datetime.now(timezone.utc).isoformat()

    # Normalise retailer name
    retailer_name = _normalise_retailer(rec.get("Retailer", rec.get("retailer", "")))
    retailer_id = _retailer_name_to_id(retailer_name)

    # Plan name
    plan_name = rec.get("PlanName", rec.get("plan_name", rec.get("Plan", "")))

    # Region
    region = _extract_region(rec)

    # Rates
    c_per_kwh = _safe_float(rec.get("VariableRate", rec.get("variable_rate", rec.get("c_per_kwh", 0.0))))
    c_per_day = _safe_float(rec.get("DailyCharge", rec.get("daily_charge", rec.get("c_per_day", 0.0))))

    # Tiered pricing
    tiers = _extract_tiers(rec)
    tier_thresholds_json = json.dumps(tiers) if tiers else "[]"

    # Prompt payment discount
    ppd = _safe_float(rec.get("PromptPaymentDiscount", rec.get("prompt_payment_discount", 0.0)))

    # Conditions
    conditions = _extract_conditions(rec)
    conditions_json = json.dumps(conditions) if conditions else "{}"

    # Low user eligibility
    low_user_eligible = _safe_int(rec.get("LowUserEligible", rec.get("low_user_eligible", 0)))

    # EIEP14A identifier
    eiep14a_id = str(rec.get("PlanId", rec.get("plan_id", rec.get("id", str(uuid.uuid4())))))

    return {
        "id": str(uuid.uuid4()),
        "retailer_id": retailer_id,
        "name": plan_name,
        "region": region,
        "c_per_kwh": c_per_kwh,
        "c_per_day": c_per_day,
        "tier_thresholds_json": tier_thresholds_json,
        "prompt_payment_discount": ppd,
        "conditions_json": conditions_json,
        "low_user_eligible": low_user_eligible,
        "source": "eiep14a",
        "eiep14a_id": eiep14a_id,
        "effective_from": now,
        "effective_to": None,
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _normalise_retailer(name: str) -> str:
    """Normalise a retailer name to its canonical form."""
    cleaned = name.strip()
    lower = cleaned.lower()
    if lower in RETAILER_MAP:
        return RETAILER_MAP[lower]
    return cleaned


def _retailer_name_to_id(name: str) -> str:
    """Convert a canonical retailer name to a snake_case ID."""
    # Reverse lookup in RETAILER_MAP
    lower = name.lower()
    for key, value in RETAILER_MAP.items():
        if value.lower() == lower:
            # Return the first key (which is the retailer_id form)
            return key.split()[0]
    # Fallback: slugify the name
    return re.sub(r"[^a-z0-9]+", "_", lower).strip("_")


def _extract_region(rec: dict) -> str:
    """Extract and normalise the region from a record."""
    raw = rec.get("Region", rec.get("region", rec.get("Area", rec.get("area", ""))))
    cleaned = raw.strip()
    if cleaned in NZ_REGIONS:
        return cleaned
    # Try case-insensitive match
    lower = cleaned.lower()
    for region in NZ_REGIONS:
        if region.lower() == lower:
            return region
    return cleaned if cleaned else "National"


def _extract_tiers(rec: dict) -> list[dict]:
    """Extract tiered pricing structure from a record."""
    tiers: list[dict] = []

    # Direct tier array
    if "Tiers" in rec or "tiers" in rec:
        raw_tiers = rec.get("Tiers", rec.get("tiers", []))
        if isinstance(raw_tiers, list):
            for t in raw_tiers:
                if isinstance(t, dict):
                    tiers.append({
                        "threshold_kwh": _safe_float(t.get("Threshold", t.get("threshold", 0))),
                        "c_per_kwh": _safe_float(t.get("Rate", t.get("rate", 0))),
                    })
            return tiers
        if isinstance(raw_tiers, str):
            try:
                parsed = json.loads(raw_tiers)
                if isinstance(parsed, list):
                    return parsed
            except json.JSONDecodeError:
                pass

    # Alternative: Tier1Rate, Tier1Threshold pattern
    for i in range(1, 6):
        rate = rec.get(f"Tier{i}Rate", rec.get(f"tier{i}_rate"))
        threshold = rec.get(f"Tier{i}Threshold", rec.get(f"tier{i}_threshold"))
        if rate is not None:
            tiers.append({
                "threshold_kwh": _safe_float(threshold or 0),
                "c_per_kwh": _safe_float(rate),
            })

    return tiers


def _extract_conditions(rec: dict) -> dict:
    """Extract plan conditions (fixed term, payment type, etc.)."""
    conditions: dict = {}

    fixed_term = rec.get("FixedTermMonths", rec.get("fixed_term_months"))
    if fixed_term is not None:
        conditions["fixed_term_months"] = _safe_int(fixed_term)

    payment_type = rec.get("PaymentType", rec.get("payment_type"))
    if payment_type:
        conditions["payment_type"] = str(payment_type)

    contract_type = rec.get("ContractType", rec.get("contract_type"))
    if contract_type:
        conditions["contract_type"] = str(contract_type)

    exit_fee = rec.get("ExitFee", rec.get("exit_fee"))
    if exit_fee is not None:
        conditions["exit_fee_cents"] = _safe_int(exit_fee)

    return conditions


def _safe_float(value) -> float:
    """Safely convert a value to float, defaulting to 0.0."""
    if value is None:
        return 0.0
    try:
        return float(value)
    except (ValueError, TypeError):
        return 0.0


def _safe_int(value) -> int:
    """Safely convert a value to int, defaulting to 0."""
    if value is None:
        return 0
    try:
        return int(value)
    except (ValueError, TypeError):
        return 0
