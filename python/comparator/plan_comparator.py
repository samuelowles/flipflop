"""
Flip Plan Comparator — main comparison engine.

Projects annual cost for each plan using actual usage data, ranks by
projected cost, and identifies savings opportunities.

Deterministic arithmetic — NO AI/LLM.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

from comparator.confidence import compute_comparison_confidence
from comparator.pricing import calculate_bill_cost, is_low_user_eligible, is_unsupported_plan

# Minimum saving (cents NZD) for a switch to be "worth it". Matches the TS
# notification threshold (SAVING_THRESHOLD_CENTS in planComparator.ts). The AC
# (#72) calls this the "configured notification threshold".
SWITCH_THRESHOLD_CENTS = 5000


def compare(
    usage_profile: dict,
    current_plan: dict,
    available_plans: list[dict],
    bill_history: list[dict],
) -> list[dict]:
    """Compare available plans against the user's current plan.

    Projects annual cost for each plan using actual usage data and
    returns a ranked list of ``ComparisonResult``-compatible dicts.

    Args:
        usage_profile: ``{"avg_daily_kwh": float, "meter_type": str,
            "seasonal_weight": Optional[dict]}``
        current_plan: The user's current plan dict with pricing fields.
        available_plans: List of plan dicts to compare against.
        bill_history: List of parsed bill dicts (most recent 3-12).

    Returns:
        List of comparison dicts sorted by projected annual cost
        (lowest first). Each dict has:
        - plan_id, plan_name, retailer_id, projected_cost_cents,
          current_cost_cents, saving_cents, confidence,
          stay_where_you_are (bool), comparison_details
    """
    avg_daily_kwh = float(usage_profile.get("avg_daily_kwh", 0))
    if avg_daily_kwh <= 0 and bill_history:
        avg_daily_kwh = _compute_avg_daily_kwh(bill_history)

    if avg_daily_kwh <= 0:
        return []

    annual_kwh = avg_daily_kwh * 365

    # Compute current plan annual cost
    current_annual_cost = _project_annual(avg_daily_kwh, current_plan)

    # Break fee / fixed-term awareness
    break_fee_cents = int(current_plan.get("break_fee_cents", 0) or 0)
    fixed_term_expiry = current_plan.get("fixed_term_expiry")  # None if not in a term

    results: list[dict] = []
    now = datetime.now(timezone.utc).isoformat()

    for plan in available_plans:
        plan_id = plan.get("id", "")
        plan_name = plan.get("name", "Unknown")
        retailer_id = plan.get("retailer_id", "unknown")

        # Skip if plan is not suitable for user's meter type
        if not _plan_matches_meter_type(plan, usage_profile.get("meter_type", "standard")):
            continue

        # TOU / missing-field guard (AC #125): unsupported plans must not be
        # priced at zero (which would fake a saving). Mark them unsupported and
        # zero the saving so they cannot trigger a switch recommendation.
        unsupported, unsupported_reason = is_unsupported_plan(plan)

        if unsupported:
            result = {
                "plan_id": plan_id,
                "plan_name": plan_name,
                "retailer_id": retailer_id,
                "projected_cost_cents": 0,
                "current_cost_cents": current_annual_cost,
                "saving_cents": 0,
                "confidence": compute_comparison_confidence(bill_history),
                "stay_where_you_are": plan_id == current_plan.get("id"),
                "unsupported": True,
                "unsupported_reason": unsupported_reason,
                "comparison_details": json.dumps({
                    "avg_daily_kwh": round(avg_daily_kwh, 2),
                    "annual_kwh_estimate": round(annual_kwh, 0),
                    "bill_count": len(bill_history),
                    "compared_at": now,
                }),
            }
            results.append(result)
            continue

        projected_cost = _project_annual(avg_daily_kwh, plan)
        saving = current_annual_cost - projected_cost  # positive = saving

        result = {
            "plan_id": plan_id,
            "plan_name": plan_name,
            "retailer_id": retailer_id,
            "projected_cost_cents": projected_cost,
            "current_cost_cents": current_annual_cost,
            "saving_cents": saving,
            "confidence": compute_comparison_confidence(bill_history),
            "stay_where_you_are": plan_id == current_plan.get("id"),
            "unsupported": False,
            "comparison_details": json.dumps({
                "avg_daily_kwh": round(avg_daily_kwh, 2),
                "annual_kwh_estimate": round(annual_kwh, 0),
                "bill_count": len(bill_history),
                "compared_at": now,
            }),
        }

        # Break fee awareness: warn if savings are positive but erased by exit fee
        if saving > 0 and break_fee_cents > 0:
            net_first_year = saving - break_fee_cents
            if net_first_year < 0:
                result["break_fee_warning"] = True
                result["net_first_year_saving_cents"] = net_first_year

        # Fixed-term awareness: pass expiry to caller so the TS side can check
        if fixed_term_expiry and _is_future_date(fixed_term_expiry):
            result["fixed_term_expiry"] = fixed_term_expiry

        results.append(result)

    # Sort: cheapest first, but current plan flagged with stay_where_you_are
    results.sort(key=lambda r: (not r["stay_where_you_are"], r["projected_cost_cents"]))

    # -----------------------------------------------------------------------
    # Recommendation derivation (AC #72): "stay_put" is a first-class outcome.
    # Python owns all money-derived decisions, so the verdict is computed here
    # from the best supported alternative's numbers and stamped onto every
    # result item. The TS side surfaces it; the recent_switch cooldown (also a
    # "stay" verdict) is applied in TS because it requires a DB read.
    # -----------------------------------------------------------------------
    recommendation, reason = _derive_recommendation(
        results, break_fee_cents, fixed_term_expiry
    )
    for r in results:
        r["recommendation"] = recommendation
        r["reason"] = reason

    return results


def _derive_recommendation(
    results: list[dict],
    break_fee_cents: int,
    fixed_term_expiry: str | None,
) -> tuple[str, str | None]:
    """Return (recommendation, reason) per AC #72.

    recommendation is "switch" or "stay_put"; reason is None for "switch" and
    one of {no_savings, low_savings, contract_constraints, lock_in_too_high}
    for "stay_put". recent_switch is applied TS-side (DB read).
    """
    # Best supported alternative (unsupported plans must never be recommended).
    alternatives = [
        r for r in results
        if not r.get("stay_where_you_are") and not r.get("unsupported")
    ]
    if not alternatives:
        return "stay_put", "no_savings"

    best = max(alternatives, key=lambda r: r["saving_cents"])
    best_saving = int(best.get("saving_cents", 0))

    # AC: no savings
    if best_saving <= 0:
        return "stay_put", "no_savings"

    # AC: contract_constraints — fixed term still active and would be broken
    if fixed_term_expiry and _is_future_date(fixed_term_expiry):
        return "stay_put", "contract_constraints"

    # AC: lock_in_too_high — break fee wipes out the first-year saving
    if break_fee_cents > 0 and best_saving - break_fee_cents < 0:
        return "stay_put", "lock_in_too_high"

    # AC: low_savings — positive but below the configured notification threshold
    if best_saving < SWITCH_THRESHOLD_CENTS:
        return "stay_put", "low_savings"

    return "switch", None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _project_annual(avg_daily_kwh: float, plan: dict) -> int:
    """Project annual cost for a plan given average daily kWh usage.

    Projects month-by-month to correctly model NZ tiered pricing where
    tier thresholds reset each billing period (typically monthly).
    Using annual kWh totals would apply tier thresholds only once,
    distorting the projection for plans with tiered rates.
    """
    monthly_kwh = avg_daily_kwh * (365 / 12)
    monthly_cost = calculate_bill_cost(monthly_kwh, 30, plan)
    return int(monthly_cost * 12)


def _compute_avg_daily_kwh(bills: list[dict]) -> float:
    """Compute average daily kWh from bill history."""
    total_kwh = 0.0
    total_days = 0

    for bill in bills:
        kwh = float(bill.get("usage_kwh", 0))
        days = int(bill.get("days", 0))

        if kwh <= 0 or days <= 0:
            continue

        total_kwh += kwh
        total_days += days

    if total_days <= 0:
        return 0.0

    return total_kwh / total_days


def _is_future_date(iso_date: str) -> bool:
    """Return True if *iso_date* is after the current UTC time."""
    try:
        # Normalise: strip microseconds if present, handle offsets
        if iso_date.endswith("Z"):
            parsed = datetime.fromisoformat(iso_date.replace("Z", "+00:00"))
        else:
            parsed = datetime.fromisoformat(iso_date)
        # If the parsed datetime is naive, treat it as UTC
        if parsed.tzinfo is None:
            from datetime import timezone as _tz

            parsed = parsed.replace(tzinfo=_tz.utc)
        return parsed > datetime.now(timezone.utc)
    except (ValueError, TypeError):
        return False


def _plan_matches_meter_type(plan: dict, meter_type: str) -> bool:
    """Check if a plan is suitable for the user's meter type.

    Low-user plans are only suitable for low_user meter types.
    Standard plans work for everyone.
    """
    low_user_eligible = bool(plan.get("low_user_eligible", 0))

    # Low-user plans require a low_user meter type
    if low_user_eligible and meter_type != "low_user":
        return False

    return True
