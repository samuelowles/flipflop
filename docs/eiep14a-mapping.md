# EIEP14A -> plans Mapping (#65)

This document defines how each field in an EIEP14A feed record maps onto a
row of the D1 `plans` table. It is the canonical reference for both the Python
parser (`python/eiep14a/parser.py`) and the TypeScript ingestion worker
(`workers/src/services/eiep14a.ts`).

## Design principles

- **No new columns were added for `rate_type` or `gst_inclusive`.** Column
  additions were #63's job (migration 0013). These two fields are folded into
  the existing `conditions_json` blob, where they join `fixed_term_months`,
  `payment_type`, `contract_type`, and `exit_fee_cents`.
- **Region is normalised to a human-readable name.** The EIEP14A feed may
  carry either a distribution-network code (e.g. `NRC`) or a region name
  (e.g. `Northland`). Both resolve to the canonical name via
  `NETWORK_CODE_TO_REGION` then `NZ_REGIONS`.
- **`source_url` is captured at two levels:** the run-level feed URL
  (`fetchEIEP14A` return value) and an optional per-record override
  (`SourceURL` / `source_url` key). Per-record wins; otherwise the batch URL
  is applied to every row.

## Field-by-field mapping

| EIEP14A field(s) | `plans` column | Notes |
|---|---|---|
| `PlanId` / `plan_id` / `id` | `eiep14a_id` | Dedup key. Falls back to a generated UUID when absent. |
| `Retailer` / `retailer` | `retailer_id` | Normalised via `RETAILER_MAP` then slugified (e.g. "Contact Energy" -> `contact`). |
| `PlanName` / `plan_name` / `Plan` | `name` | Pass-through. |
| `Region` / `region` / `Area` / `area` | `region` | **#65:** resolved via `NETWORK_CODE_TO_REGION` first (e.g. `NRC` -> `Northland`), then `NZ_REGIONS` (case-insensitive), then raw passthrough, then `National` default. |
| `VariableRate` / `variable_rate` / `c_per_kwh` | `c_per_kwh` | c/kWh. `_safe_float`; defaults to `0.0`. |
| `DailyCharge` / `daily_charge` / `c_per_day` | `c_per_day` | c/day. `_safe_float`; defaults to `0.0`. |
| `Tiers` / `Tier{N}Rate`+`Tier{N}Threshold` | `tier_thresholds_json` | JSON array of `{threshold_kwh, c_per_kwh}`. `[]` when absent. |
| `PromptPaymentDiscount` / `prompt_payment_discount` | `prompt_payment_discount` | `_safe_float`; defaults to `0.0`. |
| `LowUserEligible` / `low_user_eligible` | `low_user_eligible` | `_safe_int` (0/1). |
| *(constant)* | `source` | Always `'eiep14a'`. |
| *(generated)* | `id` | Random UUID per row. |
| *(generated)* | `effective_from` | UTC ISO timestamp at transform time. |
| *(constant)* | `effective_to` | `NULL` (open-ended). |
| *(run-level)* | `provenance` | `'eiep14a'` (#63 column). |
| `SourceURL` / `source_url` (per-record) OR run-level feed URL | `source_url` | **#65.** Per-record key takes precedence; otherwise the batch-level `fileUrl` from `fetchEIEP14A`. `NULL` when neither is present. |
| *(run-level)* | `ingested_at` | UTC ISO timestamp at upsert time (#63 column). |
| *(computed)* | `content_hash` | SHA-256 over tracked fields (#64 idempotency). `rate_type` and `gst_inclusive` are included transitively via `conditions_json`. |
| *(constant)* | `is_current` | `true` for freshly upserted rows (#63 column). |

### Fields folded into `conditions_json` (no dedicated column)

| EIEP14A field(s) | `conditions_json` key | Notes |
|---|---|---|
| `FixedTermMonths` / `fixed_term_months` | `fixed_term_months` | `_safe_int`. Omitted when absent. |
| `PaymentType` / `payment_type` | `payment_type` | String. Omitted when absent. |
| `ContractType` / `contract_type` | `contract_type` | String. Omitted when absent. |
| `ExitFee` / `exit_fee` | `exit_fee_cents` | `_safe_int` (cents). Omitted when absent. |
| **`RateType` / `rate_type`** (#65) | **`rate_type`** | Upper-cased (e.g. `ANYTIME`, `CONTROLLED`, `UNCONTROLLED`). Omitted when absent. |
| **`GSTInclusive` / `gst_inclusive`** (#65) | **`gst_inclusive`** | Boolean. **Defaults to `true`** per EIEP14A feed spec when absent. Coerced from truthy strings/ints via `_to_bool`. |

## Region resolution order (#65)

1. **Network code** — `NETWORK_CODE_TO_REGION.get(value.upper())`. Covers 21
   NZ distribution-network codes (NRC, APE, VEC, WEL, ORION, UNI, POA, TCK,
   TKK, WAC, EAS, SCN, NTL, MBC, AUR, POW, SLD, BOP, GIS, HBR, WGN).
2. **Region name** — direct or case-insensitive match against `NZ_REGIONS`
   (16 regions + North/South Island + National).
3. **Passthrough** — the raw value unchanged (preserves unrecognised codes
   for downstream inspection).
4. **Default** — `National` when the field is empty.

## Fixture

`python/tests/eiep14a/fixtures/sample_eiep14a_rows.json` contains 6
anonymized records exercising every mapping above: network-code regions,
both `rate_type` casings, `gst_inclusive` as bool/string/int, the
lowercase-key variant, and per-record vs batch `source_url`.

## References

- Issue #63 (migration 0013): added `provenance`, `source_url`, `ingested_at`,
  `content_hash`, `is_current` columns.
- Issue #64: EIEP14A ingestion worker + hash-based idempotency.
- Issue #65 (this doc): `rate_type` / `gst_inclusive` into `conditions_json`,
  network-code -> region map, `source_url` propagation.
