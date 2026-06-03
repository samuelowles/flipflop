"""
EIEP14A data feed fetcher.

Downloads and caches the Electricity Authority's retailer-to-plan
mapping data. The EIEP14A feed provides standardised plan information
for all NZ electricity retailers.

Source: https://www.emi.ea.govt.nz/Wholesale/Datasets/Mappings/RetailerPlanMapping
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Optional

import requests

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

EIEP14A_BASE_URL = "https://www.emi.ea.govt.nz"
EIEP14A_MAPPING_PATH = "/Wholesale/Datasets/Mappings/RetailerPlanMapping"
DEFAULT_TIMEOUT = 30  # seconds

# ---------------------------------------------------------------------------
# Fetcher
# ---------------------------------------------------------------------------


def fetch_eiep14a_data(
    cache_path: Optional[str] = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> list[dict]:
    """Download the EIEP14A retailer-plan mapping feed.

    Args:
        cache_path: Optional file path to cache the raw response.
        timeout: HTTP request timeout in seconds.

    Returns:
        A list of raw plan-mapping records (dicts).

    Raises:
        requests.RequestException: If the HTTP request fails.
        ValueError: If the response cannot be parsed.
    """
    url = f"{EIEP14A_BASE_URL}{EIEP14A_MAPPING_PATH}"

    logger.info("Fetching EIEP14A data from %s", url)

    response = requests.get(url, timeout=timeout)
    response.raise_for_status()

    data = _parse_response(response.text, response.headers.get("content-type", ""))

    if cache_path:
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "fetched_at": datetime.now(timezone.utc).isoformat(),
                    "source_url": url,
                    "record_count": len(data),
                    "records": data,
                },
                f,
                ensure_ascii=False,
                indent=2,
            )

    logger.info("Fetched %d EIEP14A records", len(data))
    return data


def _parse_response(body: str, content_type: str) -> list[dict]:
    """Parse the EIEP14A response into a list of dicts.

    The feed may be CSV or JSON depending on the endpoint configuration.
    """
    body = body.strip()
    if not body:
        raise ValueError("EIEP14A response body was empty")

    # Try JSON first
    if "json" in content_type or body.startswith("{") or body.startswith("["):
        try:
            parsed = json.loads(body)
            if isinstance(parsed, list):
                return parsed
            if isinstance(parsed, dict) and "records" in parsed:
                return parsed["records"]
            if isinstance(parsed, dict) and "items" in parsed:
                return parsed["items"]
            # Single-level dict: wrap in list
            return [parsed]
        except json.JSONDecodeError:
            pass

    # Try CSV
    import csv
    import io

    reader = csv.DictReader(io.StringIO(body))
    return list(reader)


def fetch_with_retry(
    cache_path: Optional[str] = None,
    max_retries: int = 3,
    timeout: int = DEFAULT_TIMEOUT,
) -> list[dict]:
    """Fetch EIEP14A data with retry logic.

    Args:
        cache_path: Optional cache file path.
        max_retries: Maximum number of retry attempts.
        timeout: HTTP request timeout in seconds.

    Returns:
        List of raw plan records.

    Raises:
        requests.RequestException: If all retries fail.
    """
    last_error: Optional[Exception] = None

    for attempt in range(1, max_retries + 1):
        try:
            return fetch_eiep14a_data(cache_path=cache_path, timeout=timeout)
        except requests.RequestException as exc:
            last_error = exc
            logger.warning(
                "EIEP14A fetch attempt %d/%d failed: %s",
                attempt,
                max_retries,
                exc,
            )
            if attempt < max_retries:
                import time

                time.sleep(2**attempt)  # Exponential backoff

    raise last_error  # type: ignore[misc]
