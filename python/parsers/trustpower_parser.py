"""
Trustpower bill parser.

Trustpower NZ residential electricity bills have these sections:
- Customer details and ICP number in the header
- Billing period (often "Supply period" or "Billing period")
- Energy / usage breakdown with kWh and per-kWh rate
- Daily fixed / line charge
- "Total amount due" or "Amount to pay" at the bottom

Trustpower is known for bundled utility bills (electricity + gas +
broadband); this parser focuses on the ELECTRICITY portion.

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
    extract_daily_charge,
    extract_dates,
    extract_dollars,
    extract_icp,
    extract_kwh,
    extract_meter_type,
    extract_per_kwh,
    extract_plan_name,
)


class TrustpowerParser(BaseParser):
    """Parser for Trustpower residential electricity bills."""

    RETAILER_NAME = "Trustpower"
    RETAILER_ID = "trustpower"

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
        usage_kwh = extract_kwh(full_text)
        if usage_kwh is not None:
            if validate_kwh_range(usage_kwh):
                fields_found += 1
        else:
            usage_kwh = 0.0

        # --- Total in cents ---
        total_cents = extract_dollars(full_text)
        if total_cents is not None:
            if validate_cents_range(total_cents):
                fields_found += 1
        else:
            total_cents = 0

        # --- Dates ---
        period_start, period_end = extract_dates(full_text)
        if period_start and period_end:
            fields_found += 2  # count both dates
        elif period_end:
            fields_found += 1
            period_start = None

        # --- Daily charge ---
        c_per_day = extract_daily_charge(full_text)
        if c_per_day is not None:
            if validate_c_per_day(c_per_day):
                fields_found += 1
        else:
            c_per_day = 0.0

        # --- Per-kWh rate ---
        c_per_kwh = extract_per_kwh(full_text)
        if c_per_kwh is not None:
            if validate_c_per_kwh(c_per_kwh):
                fields_found += 1
        else:
            c_per_kwh = 0.0

        # --- Plan name ---
        plan_name = self._extract_trustpower_plan(full_text)
        if plan_name:
            fields_found += 1
        else:
            plan_name = "Unknown"

        # --- Meter type ---
        meter_type = extract_meter_type(full_text)
        if meter_type != "standard":
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
            raw_json=json.dumps({"retailer_id": self.RETAILER_ID, "text_length": len(full_text)}),
        )

    @staticmethod
    def _extract_trustpower_plan(text: str) -> Optional[str]:
        """Trustpower plan names: Energy Online, Stay On, Standard, etc."""
        trustpower_plans = re.compile(
            r"Trustpower\s+(Online|Stay\s*On|Standard|Classic|Everyday|Saver|Anytime|Basic|Freedom|Energy)(?:\s*Plan)?",
            re.IGNORECASE,
        )
        match = trustpower_plans.search(text)
        if match:
            return match.group(0).strip()
        # Fall back to generic extraction
        return extract_plan_name(text)

    @staticmethod
    def _compute_days(period_start: Optional[str], period_end: Optional[str]) -> int:
        """Compute number of days between two ISO 8601 dates."""
        if not period_start or not period_end:
            return 0
        try:
            from datetime import datetime

            start = datetime.strptime(period_start, "%Y-%m-%d")
            end = datetime.strptime(period_end, "%Y-%m-%d")
            return max(0, (end - start).days + 1)  # inclusive: Apr 1-30 = 30 days
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
            re.compile(r"[Cc]ancell?ation\s*[Ff]ee[\s:#$-]*\$?\s*([\d,]+(?:\.\d{2})?)", re.IGNORECASE),
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
register_parser(TrustpowerParser.RETAILER_ID, TrustpowerParser)
