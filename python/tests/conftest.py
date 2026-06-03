"""
Pytest configuration and shared fixtures for the Flip test suite.

Provides:
* Root-level pytest markers and options.
* A ``fixtures_dir`` fixture pointing at ``python/tests/fixtures/``.
* Shared factory fixtures for constructing valid ParserResult instances.
* Automatic cleanup helpers.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path
from typing import Generator

import pytest


# ---------------------------------------------------------------------------
# Pytest configuration
# ---------------------------------------------------------------------------


def pytest_configure(config: pytest.Config) -> None:
    """Register custom markers."""
    config.addinivalue_line(
        "markers", "slow: marks tests as slow (deselect with '-m \"not slow\"')"
    )
    config.addinivalue_line(
        "markers", "integration: marks tests that require external services"
    )


# ---------------------------------------------------------------------------
# Directory fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def project_root() -> Path:
    """Absolute path to the project root (parent of python/)."""
    return Path(__file__).resolve().parent.parent.parent


@pytest.fixture(scope="session")
def fixtures_dir(project_root: Path) -> Path:
    """Absolute path to ``python/tests/fixtures/``.

    The directory is created if it does not exist.
    """
    path = project_root / "python" / "tests" / "fixtures"
    path.mkdir(parents=True, exist_ok=True)
    return path


# ---------------------------------------------------------------------------
# Temporary directory fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def tmp_work_dir() -> Generator[Path, None, None]:
    """Create a temporary working directory, cleaned up after the test."""
    path = Path(tempfile.mkdtemp(prefix="flip_test_"))
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


# ---------------------------------------------------------------------------
# Sample data fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def valid_parser_result_kwargs() -> dict:
    """Return a dict of valid kwargs for constructing a ParserResult."""
    return {
        "retailer": "test_retailer",
        "plan_name": "Standard User",
        "meter_type": "standard",
        "icp_number": "0001234567ABC99",
        "period_start": "2026-04-01",
        "period_end": "2026-04-30",
        "days": 30,
        "usage_kwh": 450.0,
        "total_cents": 12500,
        "c_per_kwh": 25.5,
        "c_per_day": 33.33,
        "fixed_term_expiry": None,
        "break_fee_cents": 0,
        "confidence": 1.0,
        "raw_json": '{"source": "test"}',
    }
