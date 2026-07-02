"""Powerswitch HTML plan parser and completeness gate (#67).

Consumes HTML snapshots saved by the #66 scraper, extracts rate components
into normalized plan rows, and enforces pricing-completeness checks
(required money fields cannot be unknown; TOU plans require clean windows;
runs below 90% field-parse rate are marked failed).
"""

from powerswitch.parser import parse_powerswitch_html, ParsedPlan
from powerswitch.completeness import (
    CompletenessResult,
    score_run,
    REQUIRED_MONEY_FIELDS,
)

__all__ = [
    "parse_powerswitch_html",
    "ParsedPlan",
    "CompletenessResult",
    "score_run",
    "REQUIRED_MONEY_FIELDS",
]
