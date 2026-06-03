"""
Confidence scoring for plan comparisons.

Computes a confidence score based on:
- Number of bills in the history (more bills = higher confidence)
- Recency of the newest bill (fresher = higher confidence)
- Completeness of extracted fields

Deterministic scoring — NO AI/LLM.
"""

from __future__ import annotations

from datetime import datetime, timezone


def compute_confidence(
    bill_count: int,
    newest_bill_days_ago: int,
    fields_complete: int,
    total_fields: int,
) -> float:
    """Compute a confidence score for a plan comparison.

    The score is weighted:
    - 40% bill count factor (0 bills → 0.0, 12+ bills → 1.0)
    - 30% recency factor (0 days → 1.0, 90+ days → 0.0)
    - 30% field completeness factor (fields_complete / total_fields)

    Args:
        bill_count: Number of bills in the user's history.
        newest_bill_days_ago: Age of the newest bill in days.
        fields_complete: Number of fields successfully extracted.
        total_fields: Total number of expected fields.

    Returns:
        Confidence score from 0.0 to 1.0.
    """
    # Bill count factor: 0 bills = 0.0, 12+ bills = 1.0
    bill_factor = min(1.0, bill_count / 12.0)

    # Recency factor: 0 days = 1.0, 90+ days = 0.0
    recency_factor = max(0.0, 1.0 - (newest_bill_days_ago / 90.0))

    # Completeness factor
    completeness_factor = fields_complete / max(1, total_fields)

    # Weighted combination
    confidence = (
        0.4 * bill_factor
        + 0.3 * recency_factor
        + 0.3 * completeness_factor
    )

    return round(max(0.0, min(1.0, confidence)), 4)


def compute_comparison_confidence(
    bills: list[dict],
    required_fields: int = 11,
) -> float:
    """Compute confidence for a plan comparison from bill history.

    Args:
        bills: List of bill dicts. Each should have at minimum
               ``period_end`` and ``total_cents`` fields.
        required_fields: Number of fields expected per bill.

    Returns:
        Confidence score from 0.0 to 1.0.
    """
    bill_count = len(bills)
    if bill_count == 0:
        return 0.0

    # Find newest bill
    try:
        now = datetime.now(timezone.utc)
        newest_days_ago = 90  # default to max

        for bill in bills:
            period_end = bill.get("period_end", "")
            if period_end:
                try:
                    end_date = datetime.fromisoformat(period_end.replace("Z", "+00:00"))
                    days_ago = (now - end_date).days
                    newest_days_ago = min(newest_days_ago, max(0, days_ago))
                except (ValueError, TypeError):
                    pass

        # Estimate field completeness
        fields_complete = 0
        total_fields = len(bills) * required_fields
        for bill in bills:
            for field in (
                "total_cents", "usage_kwh", "c_per_kwh", "c_per_day",
                "period_start", "period_end", "days", "plan_name",
                "meter_type", "icp_number", "retailer",
            ):
                if bill.get(field):
                    fields_complete += 1

        return compute_confidence(
            bill_count=bill_count,
            newest_bill_days_ago=newest_days_ago,
            fields_complete=fields_complete,
            total_fields=max(1, total_fields),
        )
    except Exception:
        return compute_confidence(bill_count, 90, 0, required_fields)
