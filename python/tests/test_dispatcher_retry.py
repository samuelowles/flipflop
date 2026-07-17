"""Tests for dispatcher retry-on-low-confidence (issue #59).

Covers:
* ``compute_confidence`` (parsers/common.py) — field completeness +
  regex match strength blending and clamping.
* ``POST /parse`` dispatcher retry: when the primary parser's confidence
  is < 0.7 and it was not the generic parser, the dispatcher retries
  once with ``GenericParser`` and keeps the higher-confidence result.
* ``parser_used`` + ``confidence`` observability in the final response.
"""
from __future__ import annotations

import json
from unittest.mock import patch

import pytest

import server
from parsers.base import ParserResult
from parsers.common import compute_confidence


# ---------------------------------------------------------------------------
# compute_confidence unit tests
# ---------------------------------------------------------------------------


class TestComputeConfidence:
    def test_pure_completeness_when_no_regex_signal(self):
        assert compute_confidence(8, 10) == 0.8

    def test_zero_fields_yields_zero(self):
        assert compute_confidence(0, 11) == 0.0

    def test_full_fields_yields_one(self):
        assert compute_confidence(11, 11) == 1.0

    def test_blends_completeness_and_regex_equally(self):
        # completeness 0.8, regex 0.6 -> (0.8 + 0.6) / 2 = 0.7
        assert compute_confidence(8, 10, regex_match_strength=0.6) == pytest.approx(0.7)

    def test_clamps_to_one(self):
        assert compute_confidence(12, 10, regex_match_strength=1.0) == 1.0

    def test_clamps_to_zero(self):
        assert compute_confidence(-1, 10, regex_match_strength=-0.5) == 0.0

    def test_zero_total_fields_is_zero(self):
        assert compute_confidence(5, 0) == 0.0

    def test_regex_only_signal_when_zero_fields(self):
        # completeness 0.0, regex 1.0 -> 0.5
        assert compute_confidence(0, 10, regex_match_strength=1.0) == 0.5


# ---------------------------------------------------------------------------
# Dispatcher retry tests
# ---------------------------------------------------------------------------


def _result_kwargs(**overrides):
    """Return valid ParserResult kwargs; confidence overridable per test."""
    base = dict(
        retailer="Test Retailer",
        plan_name="Standard User",
        meter_type="standard",
        icp_number="0001234567ABC99",
        period_start="2026-04-01",
        period_end="2026-04-30",
        days=30,
        usage_kwh=450.0,
        total_cents=12500,
        c_per_kwh=25.5,
        c_per_day=33.33,
        fixed_term_expiry=None,
        break_fee_cents=0,
        confidence=1.0,
        raw_json='{"source": "test"}',
    )
    base.update(overrides)
    return base


class _FakeParser:
    """Minimal parser stub returning a canned ParserResult."""

    def __init__(self, confidence: float, retailer: str = "Test Retailer"):
        self._result = ParserResult(**_result_kwargs(
            confidence=confidence, retailer=retailer,
        ))

    def parse(self, file_path: str) -> ParserResult:
        return self._result


@pytest.fixture
def client():
    """Flask test client with auth disabled."""
    server.app.config["TESTING"] = True
    with server.app.test_client() as c:
        yield c


def _post_parse(client, retailer_id="contact"):
    """POST /parse via the legacy file_path route.

    File existence is bypassed (``os.path.isfile`` patched to True)
    because the parsers are mocked and never actually open the file.
    """
    with patch("server.os.path.isfile", return_value=True):
        resp = client.post(
            "/parse",
            json={"file_path": "/tmp/fake.pdf", "retailer_id": retailer_id},
        )
    return resp


class TestDispatcherRetry:
    def test_primary_wins_when_higher_than_generic(self, client):
        """Retailer parser beats generic -> retailer result wins. The generic
        parser ALWAYS runs alongside a hinted parser (one-parser goal)."""
        primary = _FakeParser(confidence=0.9)
        fallback = _FakeParser(confidence=0.6, retailer="Detected")
        with patch("server.parser_for_retailer", return_value=primary), \
             patch("server.GenericParser", return_value=fallback) as gen_cls:
            resp = _post_parse(client, retailer_id="contact")
        assert resp.status_code == 200
        body = json.loads(resp.data)
        assert body["confidence"] == pytest.approx(0.9)
        assert body["parser_used"] == "contact"
        # Generic ran for comparison, exactly once.
        assert gen_cls.call_count == 1

    def test_retry_with_generic_when_primary_below_threshold(self, client):
        """Generic scores higher than the hinted retailer parser ->
        the generic result wins."""
        primary = _FakeParser(confidence=0.4)
        fallback = _FakeParser(confidence=0.75, retailer="Detected")
        with patch("server.parser_for_retailer", return_value=primary), \
             patch("server.GenericParser", return_value=fallback):
            resp = _post_parse(client, retailer_id="contact")
        assert resp.status_code == 200
        body = json.loads(resp.data)
        assert body["confidence"] == pytest.approx(0.75)
        assert body["parser_used"] == "generic"

    def test_keeps_primary_when_fallback_not_better(self, client):
        """Generic not higher -> primary kept (ties go to the retailer parser)."""
        primary = _FakeParser(confidence=0.6)
        fallback = _FakeParser(confidence=0.5, retailer="Detected")
        with patch("server.parser_for_retailer", return_value=primary), \
             patch("server.GenericParser", return_value=fallback):
            resp = _post_parse(client, retailer_id="contact")
        body = json.loads(resp.data)
        assert body["confidence"] == pytest.approx(0.6)
        # parser_used stays as the retailer id (primary won).
        assert body["parser_used"] == "contact"

    def test_no_retry_when_generic_is_primary(self, client):
        """When no retailer parser is registered, generic is the primary
        -> it runs exactly once (no self-comparison)."""
        fallback = _FakeParser(confidence=0.55, retailer="Unknown")
        with patch("server.parser_for_retailer", return_value=None), \
             patch("server.GenericParser", return_value=fallback) as gen_cls:
            resp = _post_parse(client, retailer_id="")
        assert resp.status_code == 200
        body = json.loads(resp.data)
        assert body["confidence"] == pytest.approx(0.55)
        assert body["parser_used"] == "generic"
        # GenericParser instantiated exactly once (the primary), not retried.
        assert gen_cls.call_count == 1

    def test_response_includes_parser_used_and_confidence(self, client):
        """AC: final result includes both parser_used and confidence."""
        primary = _FakeParser(confidence=0.95)
        fallback = _FakeParser(confidence=0.4, retailer="Detected")
        with patch("server.parser_for_retailer", return_value=primary), \
             patch("server.GenericParser", return_value=fallback):
            resp = _post_parse(client, retailer_id="mercury")
        body = json.loads(resp.data)
        assert "parser_used" in body
        assert "confidence" in body
        assert body["parser_used"] == "mercury"
        assert isinstance(body["confidence"], float)
