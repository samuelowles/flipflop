"""Tests for the Powerswitch HTML parser (#67).

Fixtures live at ``workers/tests/fixtures/powerswitch/`` (created by #66)
and are referenced by relative path — that directory is the single source
of truth; these tests do not duplicate the HTML.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from powerswitch.parser import (
    parse_powerswitch_html,
    _extract_plan,
    _normalise_region,
)

# Resolve the #66 fixture directory from the python test location:
# python/tests/powerswitch/ -> ../../../../workers/tests/fixtures/powerswitch
_FIXTURES = (
    Path(__file__).resolve().parent.parent.parent.parent
    / "workers"
    / "tests"
    / "fixtures"
    / "powerswitch"
)


def _fixture(name: str) -> str:
    path = _FIXTURES / name
    assert path.exists(), f"missing #66 fixture: {path}"
    return path.read_text(encoding="utf-8")


# All non-drifted, non-incomplete fixtures that must yield a complete plan.
# Covers 8 retailers (Contact, Genesis, Mercury x2, Meridian, Nova, Powershop,
# Pulse, Trustpower, Electric Kiwi) and 3 regions (Auckland, Wellington,
# Christchurch) — exceeds the AC's ≥5 retailers / ≥2 regions.
COMPLETE_FIXTURES = [
    # (filename, retailer, region, user_type). user_type is derived from the
    # plan NAME + data-low-user-eligible flag (not the filename): plans whose
    # names lack "low user"/"standard" and have no low-user flag classify as
    # "user" (the Powerswitch default segmentation).
    ("contact_auckland_standard.html", "Contact Energy", "Auckland", "low_user"),
    ("contact_wellington_lowuser.html", "Contact Energy", "Wellington", "low_user"),
    ("genesis_auckland_standard.html", "Genesis Energy", "Auckland", "user"),
    ("mercury_auckland_standard.html", "Mercury", "Auckland", "user"),
    ("mercury_christchurch_tou.html", "Mercury", "Christchurch", "user"),
    ("meridian_wellington_standard.html", "Meridian Energy", "Wellington", "user"),
    ("nova_auckland_lowuser.html", "Nova Energy", "Auckland", "low_user"),
    ("powershop_auckland.html", "Powershop", "Auckland", "user"),
    ("pulse_auckland_full.html", "Pulse Energy", "Auckland", "user"),
    ("trustpower_wellington.html", "Trustpower", "Wellington", "user"),
    ("electric_kiwi_christchurch.html", "Electric Kiwi", "Christchurch", "user"),
]


class TestParsePowerswitchHtml:
    @pytest.mark.parametrize(
        "filename,retailer,region,user_type", COMPLETE_FIXTURES,
        ids=[f[0] for f in COMPLETE_FIXTURES],
    )
    def test_extracts_all_fields(self, filename, retailer, region, user_type):
        html = _fixture(filename)
        url = f"https://www.powerswitch.co.nz/plan/{filename}"

        plans = parse_powerswitch_html(html, source_url=url)

        assert len(plans) == 1, f"{filename} should yield one plan"
        plan = plans[0]

        # AC: provenance + source_url set.
        assert plan["provenance"] == "powerswitch"
        assert plan["source"] == "powerswitch"
        assert plan["source_url"] == url

        # Extracted identity fields.
        assert plan["retailer_id"]  # non-empty
        assert plan["name"]
        assert plan["region"] == region

        # Required money fields — float cents, never None for a complete plan.
        assert plan["c_per_kwh"] is not None
        assert plan["c_per_day"] is not None
        assert isinstance(plan["c_per_kwh"], float)
        assert isinstance(plan["c_per_day"], float)
        assert plan["c_per_kwh"] > 0
        assert plan["c_per_day"] > 0

        # conditions_json carries gst_inclusive + user_type (no migration).
        conditions = json.loads(plan["conditions_json"])
        assert "gst_inclusive" in conditions
        assert conditions["user_type"] == user_type

    def test_low_user_classification(self):
        """low_user plans set low_user_eligible=1."""
        html = _fixture("nova_auckland_lowuser.html")
        plans = parse_powerswitch_html(html, source_url="u")
        assert plans[0]["low_user_eligible"] == 1
        conditions = json.loads(plans[0]["conditions_json"])
        assert conditions["user_type"] == "low_user"

    def test_standard_classification(self):
        """A plan with 'standard' in its name → standard user_type."""
        html = """
        <html><body>
          <div class="plan-card" data-retailer="Genesis" data-plan-name="Standard User Plan"
               data-region="Auckland" data-variable-rate="30.0" data-daily-charge="2.1"></div>
        </body></html>
        """
        plans = parse_powerswitch_html(html, source_url="u")
        conditions = json.loads(plans[0]["conditions_json"])
        assert conditions["user_type"] == "standard"

    def test_tou_flag_in_conditions(self):
        """TOU plans carry is_tou=True in conditions_json."""
        html = _fixture("mercury_christchurch_tou.html")
        plans = parse_powerswitch_html(html, source_url="u")
        conditions = json.loads(plans[0]["conditions_json"])
        assert conditions["is_tou"] is True

    def test_incomplete_plan_skipped(self):
        """Flick fixture with both money fields missing → no rows emitted."""
        html = _fixture("flick_incomplete.html")
        plans = parse_powerswitch_html(html, source_url="u")
        assert plans == []

    def test_drifted_structure_yields_nothing(self):
        """The drifted-structure page has no .plan-card → empty list."""
        html = _fixture("drifted_structure.html")
        plans = parse_powerswitch_html(html, source_url="u")
        assert plans == []

    def test_missing_plan_card_returns_empty(self):
        """Plain HTML with no plan card produces no plans."""
        plans = parse_powerswitch_html("<html><body><p>no card</p></body></html>")
        assert plans == []

    def test_exit_fee_in_conditions_json(self):
        """When data-exit-fee is present, exit_fee_cents lands in conditions."""
        html = """
        <html><body>
          <div class="plan-card" data-retailer="Mercury" data-plan-name="X"
               data-region="Auckland" data-variable-rate="29.1"
               data-daily-charge="2.3" data-exit-fee="150.00"></div>
        </body></html>
        """
        plans = parse_powerswitch_html(html, source_url="u")
        assert len(plans) == 1
        conditions = json.loads(plans[0]["conditions_json"])
        # 150.00 → 15000 integer cents.
        assert conditions["exit_fee_cents"] == 15000

    def test_retailer_normalisation_reuses_eiep14a_map(self):
        """RETAILER_MAP is reused (single source of truth)."""
        html = _fixture("mercury_auckland_standard.html")
        plans = parse_powerswitch_html(html, source_url="u")
        # Mercury → canonical "Mercury" → id "mercury".
        assert plans[0]["retailer_id"] == "mercury"


class TestExtractPlan:
    def test_missing_fields_populated(self):
        """_extract_plan leaves required money fields None when absent."""
        html = _fixture("flick_incomplete.html")
        plan = _extract_plan(html, source_url="u")
        assert plan is not None
        assert plan.c_per_kwh is None
        assert plan.c_per_day is None

    def test_region_normalisation(self):
        assert _normalise_region("Auckland") == "Auckland"
        assert _normalise_region("wellington") == "Wellington"
        # Network code reused from eiep14a.
        assert _normalise_region("ORION") == "Canterbury"
        assert _normalise_region("") == "National"


class TestRetailerCoverage:
    """AC: ≥5 retailers across ≥2 regions."""

    def test_covers_five_plus_retailers(self):
        retailers = {f[1] for f in COMPLETE_FIXTURES}
        assert len(retailers) >= 5, f"only {len(retailers)} retailers: {retailers}"

    def test_covers_two_plus_regions(self):
        regions = {f[2] for f in COMPLETE_FIXTURES}
        assert len(regions) >= 2, f"only {len(regions)} regions: {regions}"
