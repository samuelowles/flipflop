"""
Shared parser helpers.

Provides the canonical confidence function used by retailer-specific
parsers to score their extraction quality. Combines two signals:

* **field completeness** — how many of the expected bill fields were
  successfully extracted (e.g. ICP, kWh, dates, rates, plan name).
* **regex match strength** — a per-parser heuristic in ``[0, 1]`` that
  reflects how strongly the source text matched the parser's expected
  layout / patterns (e.g. exact section headers vs. fuzzy fallback).

The combined score is clamped to ``[0, 1]``. Existing parsers compute
confidence directly today; this function is the canonical helper for
new parsers going forward (issue #59).
"""

from __future__ import annotations


def compute_confidence(
    fields_found: int,
    total_fields: int,
    regex_match_strength: float = 0.0,
) -> float:
    """Return a confidence score in ``[0, 1]`` for a parser result.

    The score blends field completeness (``fields_found / total_fields``)
    with an optional ``regex_match_strength`` heuristic. The two signals
    are weighted equally and averaged so that a parser extracting every
    field with only a moderate pattern match still scores reasonably,
    while a parser with strong pattern matches but missing fields does
    not falsely report a perfect score.

    Args:
        fields_found: Number of bill fields successfully extracted.
        total_fields: Total expected fields for the bill schema.
        regex_match_strength: Heuristic in ``[0, 1]`` describing how well
            the source text matched the parser's expected layout. A value
            of ``0.0`` (the default) means "no additional pattern signal"
            and the score falls back to pure field completeness.

    Returns:
        Confidence in ``[0, 1]``.
    """
    if total_fields <= 0:
        completeness = 0.0
    else:
        completeness = fields_found / total_fields

    if regex_match_strength <= 0.0:
        # No regex signal — score on completeness alone.
        score = completeness
    else:
        score = 0.5 * completeness + 0.5 * regex_match_strength

    return max(0.0, min(1.0, score))
