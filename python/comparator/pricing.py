"""
Pricing helper functions for the Flip plan comparator.

All monetary values are integer cents (NZD).
Deterministic arithmetic — NO AI/LLM.
"""

from __future__ import annotations

from typing import Optional

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# NZ low-user threshold: < 8,000 kWh/year (single-phase) or < 9,000 kWh/year
LOW_USER_ANNUAL_KWH_THRESHOLD = 8000

# Typical tiers for NZ residential
# Low user: < 8000 kWh = "low fixed" rate; standard = "standard" rate
# Anytime/Uncontrolled pricing: first N kWh at one rate, remainder at another
DEFAULT_LOW_USER_DAILY = 30.0  # cents/day
DEFAULT_STANDARD_DAILY = 90.0  # cents/day


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def calculate_bill_cost(kwh: float, days: int, plan: dict) -> int:
    """Calculate total bill cost for a plan in integer cents.

    Args:
        kwh: Total kWh used in the billing period.
        days: Number of days in the billing period.
        plan: Plan dict with pricing fields (c_per_kwh, c_per_day,
              tier_thresholds_json, prompt_payment_discount, low_user_eligible).

    Returns:
        Total cost in integer cents (NZD).
    """
    c_per_kwh = float(plan.get("c_per_kwh", 0))
    c_per_day = float(plan.get("c_per_day", 0))

    # Apply tiered pricing if configured
    tiers = _get_tiers(plan)
    if tiers:
        effective_rate = apply_tiers(kwh, tiers)
    else:
        effective_rate = c_per_kwh

    # Energy cost (c_per_kwh is already in cents, e.g. 25.0 = 25c/kWh)
    energy_cents = int(round(kwh * effective_rate))

    # Daily charge (c_per_day is already in cents, e.g. 90.0 = 90c/day)
    daily_cents = int(round(days * c_per_day))

    subtotal = energy_cents + daily_cents

    # Prompt payment discount
    discount_pct = float(plan.get("prompt_payment_discount", 0))
    if discount_pct > 0:
        subtotal = apply_discount(subtotal, discount_pct)

    return subtotal


def apply_tiers(kwh: float, tiers: list[dict]) -> float:
    """Calculate effective c/kWh with tiered pricing.

    Tiers use ``threshold_kwh`` as the cumulative upper bound for that tier.
    A ``threshold_kwh`` of 0 means "unlimited remainder" — all remaining kWh
    after bounded tiers are charged at this overflow rate.

    Example::
        [{"threshold_kwh": 500, "c_per_kwh": 30.0},   # first 500 kWh at 30c
         {"threshold_kwh": 0, "c_per_kwh": 25.0}]      # remainder at 25c

    Args:
        kwh: Total kWh used.
        tiers: List of ``{"threshold_kwh": float, "c_per_kwh": float}`` dicts.

    Returns:
        Effective rate in cents per kWh.
    """
    if not tiers:
        return 0.0

    # Separate bounded tiers (threshold > 0) from overflow (threshold == 0)
    bounded = sorted(
        [t for t in tiers if float(t.get("threshold_kwh", 0)) > 0],
        key=lambda t: float(t.get("threshold_kwh", 0)),
    )
    overflow_tiers = [t for t in tiers if float(t.get("threshold_kwh", 0)) == 0]
    overflow_rate = float(overflow_tiers[0].get("c_per_kwh", 0)) if overflow_tiers else 0.0

    # If no bounded tiers but we have overflow, everything goes at overflow rate
    if not bounded:
        if overflow_tiers:
            return overflow_rate
        return 0.0

    remaining = kwh
    total_charge = 0.0
    cumulative = 0.0  # kWh already covered by previous tiers

    for tier in bounded:
        threshold = float(tier.get("threshold_kwh", 0))
        rate = float(tier.get("c_per_kwh", 0))

        tier_kwh = min(remaining, threshold - cumulative)
        if tier_kwh <= 0:
            break

        total_charge += tier_kwh * rate
        remaining -= tier_kwh
        cumulative += tier_kwh

        if remaining <= 0:
            break

    # Remaining kWh charged at overflow rate
    if remaining > 0 and overflow_rate > 0:
        total_charge += remaining * overflow_rate

    # If no overflow rate but still remaining, use last bounded tier's rate
    if remaining > 0 and overflow_rate == 0:
        last_rate = float(bounded[-1].get("c_per_kwh", 0))
        total_charge += remaining * last_rate

    return total_charge / kwh if kwh > 0 else float(bounded[0].get("c_per_kwh", 0))


def apply_discount(subtotal_cents: int, discount_pct: float) -> int:
    """Apply a prompt payment discount percentage to a subtotal.

    Args:
        subtotal_cents: The pre-discount amount in cents.
        discount_pct: Discount percentage (e.g., 10.0 = 10%).

    Returns:
        Discounted amount in cents.
    """
    if discount_pct <= 0:
        return subtotal_cents
    discount_factor = 1.0 - (discount_pct / 100.0)
    return int(round(subtotal_cents * discount_factor))


def is_low_user_eligible(annual_kwh: float) -> bool:
    """Determine if a household qualifies as a low user.

    In NZ, low-user plans are available for households using
    less than 8,000 kWh/year (single-phase) or 9,000 kWh/year
    (multi-phase). We use the conservative 8,000 threshold.

    Args:
        annual_kwh: Estimated or actual annual kWh usage.

    Returns:
        True if the household qualifies as a low user.
    """
    return annual_kwh < LOW_USER_ANNUAL_KWH_THRESHOLD


def project_annual_cost(avg_daily_kwh: float, days_in_period: int, plan: dict) -> int:
    """Project the annual cost for a plan given average daily usage.

    Args:
        avg_daily_kwh: Average daily usage in kWh.
        days_in_period: Number of days used for projection (typically 365).
        plan: Plan pricing dict.

    Returns:
        Projected annual cost in integer cents.
    """
    total_kwh = avg_daily_kwh * days_in_period
    return calculate_bill_cost(total_kwh, days_in_period, plan)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _get_tiers(plan: dict) -> list[dict]:
    """Extract tier list from plan dict, handling JSON string or list."""
    tiers = plan.get("tier_thresholds_json")
    if tiers is None:
        return []
    if isinstance(tiers, list):
        return tiers
    if isinstance(tiers, str):
        import json

        try:
            parsed = json.loads(tiers)
            if isinstance(parsed, list):
                return parsed
        except json.JSONDecodeError:
            pass
    return []
