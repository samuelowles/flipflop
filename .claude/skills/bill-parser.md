# Bill Parser Skill

## Purpose
Create a new retailer-specific Python bill parser for Flip. Each NZ power retailer gets its own parser module that extracts structured data from their bill PDFs.

## Retailer Coverage Plan

| Phase | Retailers |
|-------|-----------|
| Phase 2 | Contact Energy, Mercury, Genesis |
| Phase 3 | Meridian, Trustpower |
| Phase 4 | Nova, Electric Kiwi |
| Phase 5 | Powershop, Flick, Pulse Energy |

## Parser Architecture

All parsers extend `python/parsers/base.py` which provides:
- Shared extraction logic (date parsing, currency parsing, ICP number validation)
- Sanity-check utilities (kWh ranges, dollar ranges, date validity)
- Standard output JSON structure

## Workflow for Adding a New Parser

### 1. Collect Sample Bills
Obtain 3-5 anonymised sample PDFs from the target retailer, covering different plan variants (standard, low-user, day/night, controlled).

### 2. Analyze Bill Structure
Manually examine the PDFs to identify:
- Where each data field appears (page, section, table)
- Format of key values (dates, currency, kWh, ICP number)
- Plan name location and variants
- Any retailer-specific quirks (watermarks, multi-page layouts, unusual terminology)

### 3. Create Parser Module
Create `python/parsers/{retailer_name}.py`:
```python
"""Parser for {Retailer Display Name} bills."""

from .base import BaseParser, ParserResult


class {RetailerName}Parser(BaseParser):
    """Extracts structured data from {Retailer} PDF bills."""

    retailer_id = "{retailer_name}"

    def extract(self, pdf_path: str) -> ParserResult:
        """Parse a {Retailer} bill PDF and return structured data."""
        text = self.extract_text(pdf_path)

        return ParserResult(
            retailer=self.retailer_id,
            plan_name=self._extract_plan_name(text),
            meter_type=self._extract_meter_type(text),
            icp_number=self._extract_icp_number(text),
            period_start=self._extract_period_start(text),
            period_end=self._extract_period_end(text),
            days=self._calculate_days(),
            usage_kwh=self._extract_usage_kwh(text),
            total_cents=self._extract_total_cents(text),
            c_per_kwh=self._extract_c_per_kwh(text),
            c_per_day=self._extract_c_per_day(text),
            fixed_term_expiry=self._extract_fixed_term_expiry(text),
            break_fee_cents=self._extract_break_fee_cents(text),
            confidence=self._calculate_confidence(),
        )
```

### 4. Write Tests
Create `python/tests/parsers/test_{retailer_name}.py`:
```python
from parsers.{retailer_name} import {RetailerName}Parser


def test_standard_bill():
    parser = {RetailerName}Parser()
    result = parser.extract("tests/fixtures/{retailer_name}_standard_202601.pdf")

    assert result.retailer_id == "{retailer_name}"
    assert result.total_cents == expected_value  # exact cents
    assert result.confidence > 0.8


def test_low_confidence_bill():
    parser = {RetailerName}Parser()
    result = parser.extract("tests/fixtures/{retailer_name}_illegible.pdf")

    assert result.confidence < 0.5
```

### 5. Register Retailer
Add the retailer to D1 `retailers` table:
```sql
INSERT INTO retailers (id, name, domain, parser_id, is_active)
VALUES (
  '<UUID>',
  '{Retailer Display Name}',
  '@{retailer_domain}.co.nz',
  '{retailer_name}',
  1
);
```

### 6. Validate
- Run parser tests: `pytest python/tests/parsers/test_{retailer_name}.py -v`
- Verify extracted values fall within valid NZ ranges
- Check confidence scores are reasonable
- Run full test suite to ensure no regressions

## Quality Bar

Before merging a new parser:
- [ ] 3+ sample bills tested, all with confidence > 0.8
- [ ] Plan name correctly identified for each bill variant
- [ ] All monetary values extracted in exact cents
- [ ] ICP number format validated (15 digits, starts with retailer prefix)
- [ ] Meter type correctly detected (standard, low_user, day_night, controlled)
- [ ] Dates parsed as ISO 8601 with NZ timezone
- [ ] Edge cases tested: missing fields, illegible sections, multi-page layout
- [ ] Unit tests passing
- [ ] Full test suite passing
