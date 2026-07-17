"""
Generic fallback bill parser.

Used when the retailer is unknown or no retailer-specific parser exists.
Applies broad heuristics to extract as much as possible from the PDF.

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
    extract_tou_usage,
    has_tou_charges,
)


class GenericParser(BaseParser):
    """Generic fallback parser for unknown retailer bills.

    Uses broad heuristics to extract data. Confidence will typically
    be lower than retailer-specific parsers.
    """

    RETAILER_NAME = "Unknown"
    RETAILER_ID = "generic"

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
        # TOU-itemised bills (Peak/Off-peak/Hour-of-Power lines, no total
        # line) are summed first — extract_kwh would grab the first
        # component only (real Electric Kiwi bill).
        usage_kwh = extract_tou_usage(full_text)
        if usage_kwh is None:
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
            fields_found += 2
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
        plan_name = extract_plan_name(full_text)
        if plan_name:
            fields_found += 1
        else:
            plan_name = "Unknown"

        # --- Meter type ---
        meter_type = extract_meter_type(full_text)
        if meter_type != "standard" or has_tou_charges(full_text):
            fields_found += 1

        # --- Retailer detection ---
        retailer_name = self._detect_retailer(full_text)
        if retailer_name and retailer_name != "Unknown":
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
        # Honest field-coverage scoring, same formula as the retailer
        # parsers. The old 0.5-baseline/0.8-ceiling design (issue #51) meant
        # a generic-only parse could NEVER clear the 0.85 'parsed' threshold
        # — a dead end now that the generic parser is the primary path for
        # all bill types (retailer parsers are a hint-driven bonus, not a
        # requirement). Garbage input scores low because nothing extracts;
        # rich bills score high because everything does.
        confidence = min(1.0, fields_found / total_fields)

        return ParserResult(
            retailer=retailer_name,
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
            address=extract_address(full_text),
            raw_json=json.dumps({"retailer_id": self.RETAILER_ID, "text_length": len(full_text), "detected_retailer": retailer_name}),
        )

    @staticmethod
    def _detect_retailer(text: str) -> str:
        """Try to detect the retailer from the text content.

        Covers all 22+ known NZ residential electricity retailers and brands.
        Source: Powerswitch + Electricity Authority registry (May 2026).
        Patterns are ordered to prefer exact matches over substrings.
        """
        retailers: list[tuple[str, str, int]] = [
            # Major retailers (dedicated parsers available)
            # Real Contact bills never print "Contact Energy" — the anchors
            # are the contact.co.nz domain and "Thanks for choosing Contact".
            ("Contact Energy", r"Contact\s*Energy|contact\.co\.nz|choosing\s+Contact", re.IGNORECASE),
            ("Genesis Energy", r"Genesis\s*Energy", re.IGNORECASE),
            ("Mercury", r"Mercury", re.IGNORECASE),
            # Major retailers (generic parser only)
            ("Meridian Energy", r"Meridian\s*Energy", re.IGNORECASE),
            ("Nova Energy", r"Nova\s*Energy", re.IGNORECASE),
            ("Trustpower", r"Trustpower", re.IGNORECASE),
            ("Electric Kiwi", r"Electric\s*Kiwi", re.IGNORECASE),
            ("Powershop", r"Powershop", re.IGNORECASE),
            ("Flick Electric", r"Flick\s*Electric", re.IGNORECASE),
            ("Pulse Energy", r"Pulse\s*Energy", re.IGNORECASE),
            # Additional retailers (Powerswitch + EA registry)
            ("Ecotricity", r"Ecotricity", re.IGNORECASE),
            ("Globug", r"Globug", re.IGNORECASE),
            ("Hanergy", r"Hanergy", re.IGNORECASE),
            ("Megatel", r"Megatel", re.IGNORECASE),
            ("Octopus Energy", r"Octopus\s*Energy", re.IGNORECASE),
            ("Tensor", r"Tensor", re.IGNORECASE),
            ("Toast Electric", r"Toast\s*Electric", re.IGNORECASE),
            ("2degrees", r"2degrees", re.IGNORECASE),
            ("Slingshot", r"Slingshot", re.IGNORECASE),
            ("Grey Power Electricity", r"Grey\s*Power\s*(?:Electricity)?", re.IGNORECASE),
            ("Black Box Power", r"Black\s*Box\s*Power", re.IGNORECASE),
            ("Just Energy", r"Just\s*Energy", re.IGNORECASE),
            ("Nau Mai Rā", r"Nau\s*Mai\s*Rā", re.IGNORECASE),
            ("Wise Prepay Energy", r"Wise\s*Prepay\s*Energy", re.IGNORECASE),
            # Legacy / rebranded
            ("Manawa Energy", r"Manawa\s*Energy", re.IGNORECASE),
        ]

        for name, pattern, flags in retailers:
            if re.search(pattern, text, flags):
                return name

        return "Unknown"

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
        import re
        from parsers.base import sanitize_date

        patterns = [
            re.compile(r"[Ff]ixed\s*[Tt]erm\s*(?:ends?|expir(?:es|y))[\s:#-]*(\d{1,2}[/\-\s][A-Za-z]{3,9}[/\-\s]\d{2,4})", re.IGNORECASE),
            re.compile(r"[Cc]ontract\s*(?:ends?|expir(?:es|y))[\s:#-]*(\d{1,2}[/\-\s][A-Za-z]{3,9}[/\-\s]\d{2,4})", re.IGNORECASE),
            re.compile(r"(?:[Tt]erm|[Cc]ontract)\s*(?:[Ee]nds?|[Ee]xpir(?:es|y))[\s:#-]*(\d{4}-\d{2}-\d{2})", re.IGNORECASE),
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
        import re

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
