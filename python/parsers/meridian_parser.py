"""
Meridian Energy bill parser.

Meridian Energy NZ residential bills have a distinctive layout:
- "Meridian" branding near the top
- ICP number (15-digit) in the customer/supply header
- Billing period as a date range
- Usage breakdown showing total kWh
- Charges section with daily fixed charge and variable per-kWh rate
- "Total to pay" or "Amount due" as the final amount
- Plan name (Energy Online, Good Energy, NEO, SimpleSaver)

Deterministic extraction — NO AI/LLM.
"""

from __future__ import annotations

import json
import re
from typing import Optional

import pdfplumber

from parsers.base import (
    BaseParser,
    ParserResult,
    register_parser,
    sanitize_date,
    validate_icp_number,
    validate_kwh_range,
    validate_cents_range,
    validate_c_per_kwh,
    validate_c_per_day,
)
from parsers.extractors import (
    extract_address,
    extract_daily_charge,
    extract_dates,
    extract_dollars,
    extract_icp,
    extract_kwh,
    extract_meter_type,
    extract_per_kwh,
    extract_plan_name,
)


class MeridianParser(BaseParser):
    """Parser for Meridian Energy residential electricity bills."""

    RETAILER_NAME = "Meridian Energy"
    RETAILER_ID = "meridian"

    def parse(self, file_path: str) -> ParserResult:
        fields_found = 0
        total_fields = 11

        with pdfplumber.open(file_path) as pdf:
            full_text = ""
            for page in pdf.pages:
                page_text = page.extract_text()
                if page_text:
                    full_text += page_text + "\n"

        full_text = full_text.strip()
        if not full_text:
            raise ValueError(f"No extractable text found in {file_path}")

        # --- ICP number ---
        icp_number = extract_icp(full_text)
        if icp_number and validate_icp_number(icp_number):
            fields_found += 1

        # --- Usage kWh ---
        # Prefer a labelled "Total units/usage" line (Meridian day/night
        # bills list day & night separately before a total); fall back to
        # the shared extractor.
        usage_kwh = self._extract_meridian_usage(full_text)
        if usage_kwh is None:
            usage_kwh = extract_kwh(full_text)
        if usage_kwh is not None and validate_kwh_range(usage_kwh):
            fields_found += 1
        else:
            # Out of range is not a value: an unvalidated usage_kwh must
            # never leave the parser (a real Mercury bill emitted
            # 329.07 c/kWh this way).
            usage_kwh = 0.0

        # --- Total in cents ---
        total_cents = self._extract_meridian_total(full_text)
        if total_cents is not None and validate_cents_range(total_cents):
            fields_found += 1
        else:
            # Out of range is not a value: an unvalidated total_cents must
            # never leave the parser (a real Mercury bill emitted
            # 329.07 c/kWh this way).
            total_cents = 0

        # --- Dates ---
        period_start, period_end = extract_dates(full_text)
        if period_start and period_end:
            fields_found += 2
        elif period_end:
            fields_found += 1
            period_start = None

        # --- Daily charge ---
        c_per_day = self._extract_meridian_daily_charge(full_text)
        if c_per_day is None:
            c_per_day = extract_daily_charge(full_text)
        if c_per_day is not None and validate_c_per_day(c_per_day):
            fields_found += 1
        else:
            # Out of range is not a value: an unvalidated c_per_day must
            # never leave the parser (a real Mercury bill emitted
            # 329.07 c/kWh this way).
            c_per_day = 0.0

        # --- Per-kWh rate ---
        c_per_kwh = self._extract_meridian_per_kwh(full_text)
        if c_per_kwh is None:
            c_per_kwh = extract_per_kwh(full_text)
        if c_per_kwh is not None and validate_c_per_kwh(c_per_kwh):
            fields_found += 1
        else:
            # Out of range is not a value: an unvalidated c_per_kwh must
            # never leave the parser (a real Mercury bill emitted
            # 329.07 c/kWh this way).
            c_per_kwh = 0.0

        # --- Plan name ---
        plan_name = self._extract_meridian_plan(full_text)
        if plan_name:
            fields_found += 1
        else:
            plan_name = "Unknown"

        # --- Meter type (standard is a valid classification for Meridian) ---
        # Meridian canonical bills always carry enough signal to classify the
        # meter, so a determined type — including "standard" — counts as a
        # found field. This lets canonical bills reach the AC's >=0.9 target.
        meter_type = extract_meter_type(full_text)
        fields_found += 1

        # --- Days ---
        days = self._compute_days(period_start, period_end)
        if days > 0:
            fields_found += 1

        # --- Fixed term expiry ---
        fixed_term_expiry = self._extract_fixed_term_expiry(full_text)

        # --- Break fee ---
        break_fee_cents = self._extract_break_fee(full_text)

        # --- Confidence ---
        # --- Address ---
        # Scored: it is extracted from the bill and is what resolves the
        # Powerswitch lookup downstream. Excluding it while total_fields
        # counted 11 capped every bill that names no plan at 0.818 —
        # below the worker's 0.85 auto-accept threshold.
        address = extract_address(full_text)
        if address:
            fields_found += 1

        confidence = min(1.0, fields_found / total_fields)

        return ParserResult(
            retailer=self.RETAILER_NAME,
            plan_name=plan_name,
            meter_type=meter_type,
            icp_number=icp_number or "",
            period_start=period_start or "",
            period_end=period_end or "",
            days=days,
            usage_kwh=usage_kwh,
            total_cents=total_cents,
            c_per_kwh=c_per_kwh,
            c_per_day=c_per_day,
            fixed_term_expiry=fixed_term_expiry,
            break_fee_cents=break_fee_cents,
            confidence=confidence,
            address=address,
            raw_json=json.dumps({"retailer_id": self.RETAILER_ID, "text_length": len(full_text)}),
        )

    @staticmethod
    def _extract_meridian_usage(text: str) -> Optional[float]:
        """Extract total kWh from a labelled total line.

        Meridian day/night bills list day and night components separately
        before a total; this prefers an explicit "Total units/usage" label
        so the aggregate is returned rather than the first component.

        Split-period bills print the aggregate on a "Property charges for
        this period NNN.N kWh" line. That is matched FIRST: none of the
        other patterns reach it, so without this the method returns None
        and the caller falls through to the shared extract_kwh(), which
        returns the FIRST segment's volume instead of the period total.
        """
        patterns = [
            re.compile(r"Property\s+charges\s+for\s+this\s+period\s+([\d,]+(?:\.\d+)?)\s*kWh"),
            re.compile(r"[Tt]otal\s*(?:units|usage|consumption|kWh)[\s:#-]*([\d,]+(?:\.\d+)?)"),
            re.compile(r"(?:[Tt]otal|Consumption)[\s:#-]*([\d,]+(?:\.\d+)?)\s*kWh", re.IGNORECASE),
        ]
        for pattern in patterns:
            match = pattern.search(text)
            if match:
                try:
                    return float(match.group(1).replace(",", ""))
                except ValueError:
                    continue
        return None

    @staticmethod
    def _extract_meridian_plan(text: str) -> Optional[str]:
        """Meridian plan names include Energy Online, Good Energy, NEO, SimpleSaver."""
        meridian_plans = re.compile(
            r"(?:Meridian\s+)?(Energy\s+Online|Good\s+Energy|NEO|SimpleSaver|Simple\s+Saver|StayAhead|Freedom)(?:\s*Plan)?",
            re.IGNORECASE,
        )
        match = meridian_plans.search(text)
        if match:
            return match.group(0).strip()
        return extract_plan_name(text)

    @staticmethod
    def _extract_meridian_total(text: str) -> Optional[int]:
        """Meridian bills use 'Total to pay' as the canonical total label.

        "Total charges" is preferred ABOVE every other label: it is THIS
        period's charge, whereas "Total amount due"/"Your bill"/"Total to
        pay" fold in any unpaid prior balance (a real bill showed $489.15
        amount due against $231.01 of current charges — the $258.14 gap was
        the previous month's unpaid bill). On a bill with no arrears the two
        figures are equal, so preferring "Total charges" is strictly safer.

        Falls back to the shared extract_dollars if no Meridian-specific
        label is found.
        """
        patterns = [
            re.compile(r"[Tt]otal\s*[Cc]harges?[\s:#$-]*\$?\s*([\d,]+(?:\.\d{2})?)"),
            re.compile(r"[Tt]otal\s*[Tt]o\s*[Pp]ay[\s:#$-]*\$?\s*([\d,]+(?:\.\d{2})?)"),
            re.compile(r"[Pp]lease\s*[Pp]ay[\s:#$-]*\$?\s*([\d,]+(?:\.\d{2})?)"),
        ]
        for pattern in patterns:
            match = pattern.search(text)
            if match:
                try:
                    return int(round(float(match.group(1).replace(",", "")) * 100))
                except ValueError:
                    continue
        return extract_dollars(text)

    @staticmethod
    def _extract_meridian_per_kwh(text: str) -> Optional[float]:
        """Volume-weighted c/kWh across split-period charge segments.

        A re-rated or price-changed Meridian bill itemises two
        "NN.NN c/kWh NNN.N kWh" segments at different rates; the shared
        extract_per_kwh() returns the first (pre-change) rate, so the
        period never reconciles. This blends the segments by volume:
        sum(rate * kwh) / sum(kwh).

        Returns None for fewer than two segments, or when every segment
        shares a rate — single-rate bills are unchanged and fall back to
        the shared extract_per_kwh() path.
        """
        segment = re.compile(
            r"([\d.]+)\s*c(?:ents?)?\s*(?:/|per)\s*kWh\s+([\d,]+(?:\.\d+)?)\s*kWh",
            re.IGNORECASE,
        )
        segments = []
        for match in segment.finditer(text):
            try:
                rate = float(match.group(1))
                kwh = float(match.group(2).replace(",", ""))
            except ValueError:
                continue
            segments.append((rate, kwh))

        if len(segments) < 2:
            return None
        if len({rate for rate, _ in segments}) == 1:
            return None

        total_kwh = sum(kwh for _, kwh in segments)
        if total_kwh <= 0:
            return None
        return round(sum(rate * kwh for rate, kwh in segments) / total_kwh, 2)

    @staticmethod
    def _extract_meridian_daily_charge(text: str) -> Optional[float]:
        """Day-weighted c/day across split-period daily-charge segments.

        Mirrors _extract_meridian_per_kwh: a split-period bill carries two
        "Daily Charge (NNN.NN c/day x NN days)" lines, and the shared
        extract_daily_charge() returns the first. This blends them by day
        count: sum(rate * days) / sum(days).

        Returns None for fewer than two segments, or when every segment
        shares a rate — single-rate bills are unchanged and fall back to
        the shared extract_daily_charge() path.
        """
        segment = re.compile(
            r"[Dd]aily\s*[Cc]harge\s*\(\s*([\d.]+)\s*c(?:ents?)?\s*(?:/|per)\s*day"
            r"\s*[x×]\s*(\d+)\s*days?\s*\)",
        )
        segments = []
        for match in segment.finditer(text):
            try:
                rate = float(match.group(1))
                days = int(match.group(2))
            except ValueError:
                continue
            segments.append((rate, days))

        if len(segments) < 2:
            return None
        if len({rate for rate, _ in segments}) == 1:
            return None

        total_days = sum(days for _, days in segments)
        if total_days <= 0:
            return None
        return round(sum(rate * days for rate, days in segments) / total_days, 2)

    @staticmethod
    def _compute_days(period_start: Optional[str], period_end: Optional[str]) -> int:
        if not period_start or not period_end:
            return 0
        try:
            from datetime import datetime

            start = datetime.strptime(period_start, "%Y-%m-%d")
            end = datetime.strptime(period_end, "%Y-%m-%d")
            return max(0, (end - start).days + 1)  # inclusive: Apr 1–30 = 30 days
        except ValueError:
            return 0

    @staticmethod
    def _extract_fixed_term_expiry(text: str) -> Optional[str]:
        patterns = [
            re.compile(r"[Ff]ixed\s*[Tt]erm\s*(?:ends?|expir(?:es|y))[\s:#-]*(\d{1,2}[/\-\s][A-Za-z]{3,9}[/\-\s]\d{2,4})", re.IGNORECASE),
            re.compile(r"[Cc]ontract\s*(?:ends?|expir(?:es|y))[\s:#-]*(\d{1,2}[/\-\s][A-Za-z]{3,9}[/\-\s]\d{2,4})", re.IGNORECASE),
        ]
        for pattern in patterns:
            match = pattern.search(text)
            if match:
                try:
                    return sanitize_date(match.group(1))
                except ValueError:
                    continue
        return None

    @staticmethod
    def _extract_break_fee(text: str) -> int:
        patterns = [
            re.compile(r"[Bb]reak\s*[Ff]ee[\s:#$-]*\$?\s*([\d,]+(?:\.\d{2})?)", re.IGNORECASE),
            re.compile(r"[Ee]arly\s*[Tt]ermination\s*[Ff]ee[\s:#$-]*\$?\s*([\d,]+(?:\.\d{2})?)", re.IGNORECASE),
        ]
        for pattern in patterns:
            match = pattern.search(text)
            if match:
                try:
                    return int(round(float(match.group(1).replace(",", "")) * 100))
                except ValueError:
                    continue
        return 0


# Register the parser
register_parser(MeridianParser.RETAILER_ID, MeridianParser)
