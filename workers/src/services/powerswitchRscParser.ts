/**
 * #221/#240 — Powerswitch RSC results parser (rebuilt against REAL captures).
 *
 * Parses the React Server Components flight stream returned by
 * `POST /results?p={token}` (capture: workers/tests/fixtures/powerswitch-live/
 * 18-results.res.txt) into a structured plan set. The flight is line-keyed:
 * each line is `id:JSON`; the plan/usage objects live on the `1:{…}` row.
 *
 * CARDINAL RULE (issue #240): every schema assertion below traces to a byte in
 * 18-results.res.txt. The earlier build was written against invented fixtures
 * and was wrong on every point — annual_kwh (real: household.usage.electricity),
 * string plan ids (real: NUMERIC, e.g. 176000), per-tariff description/
 * prices_last_changed (real: plan-level, not per-tariff), OFFPEAK register
 * (real: OP). This parser keys on the real shapes only.
 *
 * STRICT SCHEMA GUARD: on ANY shape mismatch the parser returns a `drift`
 * outcome and emits a structured `powerswitch_schema_drift` error. It NEVER
 * returns a partial/garbage parse — callers MUST abort without persisting on
 * drift (mirrors the MONEY_FIELD_MISSING_THRESHOLD philosophy in
 * services/powerswitchScraper.ts).
 */

// ---------------------------------------------------------------------------
// Structured types (what the parser produces)
// ---------------------------------------------------------------------------

export type TariffDisplayType = 'amount' | 'percentage';

/**
 * A single tariff line within a plan. Real shape (18-results.res.txt):
 * `{id, code, name, type, value, weight, display, value_array, display_type,
 *   requires_bill_input, register_content_code}`. We carry the fields the mapper
 * + drift guard depend on; per-tariff description/prices_last_changed do NOT
 * exist in the real capture (long descriptions are separate `2:T…` text lines).
 */
export interface ParsedTariff {
  /** Tariff code: F, D1, N1, TD3, PP, EC, ... (real, from capture). */
  readonly code: string;
  /** Human-readable tariff name. */
  readonly name: string;
  /** value is $/kWh (amount) or a fraction (percentage, e.g. 0.2685 = 26.85%). */
  readonly value: number;
  readonly displayType: TariffDisplayType;
  /** Register content code: PK, OP, FREE, F, TD3, EC, ED, IN, PP, SH, UN, "". */
  readonly registerContentCode: string;
}

/** A plan within the results set. `id`/`retailerId` are stringified at the boundary. */
export interface ParsedPlan {
  /** Numeric Powerswitch plan id, stringified (e.g. "176000"). */
  readonly id: string;
  readonly name: string;
  /** Retailer display name (real: plan.retailer.name, e.g. "Electric Kiwi"). */
  readonly retailerId: string;
  readonly energyType: string;
  readonly fixedTerm: boolean;
  /** Real shape: boolean (false normally, true when a price change is pending). */
  readonly priceChangeDue: boolean | string;
  readonly tariffs: ReadonlyArray<ParsedTariff>;
}

/** Household usage estimate. Field names preserved — the consumer reads annualKwh. */
export interface ParsedUsage {
  /** Annual kWh — real: household.usage.electricity (e.g. 7007.6875). */
  readonly annualKwh: number;
  /** 12-month series (Jan..Dec) — real: household.usage.electricity_monthly. */
  readonly monthlyKwh: ReadonlyArray<number>;
}

/** The full parsed results payload. */
export interface ParsedResults {
  readonly usage: ParsedUsage;
  readonly plans: ReadonlyArray<ParsedPlan>;
}

/** Discriminated parse outcome. */
export type ParseRscOutcome =
  | { readonly status: 'ok'; readonly results: ParsedResults }
  | { readonly status: 'drift'; readonly reason: string };

// ---------------------------------------------------------------------------
// Flight stream extraction
// ---------------------------------------------------------------------------

/**
 * Split the flight stream into its `id:JSON` lines and parse each. Lines that
 * are not valid JSON (the `2:T…`/`3:T…` prose lines, control/prefetch hints) or
 * not objects are skipped; the schema guard validates the extracted objects, so
 * skipped control lines are safe.
 */
export function extractFlightRows(flight: string): unknown[] {
  const rows: unknown[] = [];
  for (const rawLine of flight.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // Flight lines are `id:JSON`. Strip the leading `<id>:` prefix.
    const colonIdx = line.indexOf(':');
    const jsonText = colonIdx >= 0 ? line.slice(colonIdx + 1) : line;
    try {
      rows.push(JSON.parse(jsonText));
    } catch {
      // Non-JSON line (control / prefetch hint) — not an error; skip.
    }
  }
  return rows;
}

/**
 * Find the first object row in the flight that contains `key`. Used by the
 * session (key 'completions') and replay (keys 'result'/'profile') to pull the
 * single payload object off the `1:{…}` row without re-parsing the whole stream.
 */
export function findFlightObject(flight: string, key: string): Record<string, unknown> | null {
  for (const row of extractFlightRows(flight)) {
    if (isObject(row) && key in row) return row;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Strict schema validation
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && !Number.isNaN(v);
}

function validateUsage(obj: Record<string, unknown>): { readonly ok: true; readonly value: ParsedUsage } | { readonly ok: false; readonly reason: string } {
  const household = obj.household;
  if (!isObject(household)) return { ok: false, reason: 'missing_household' };
  const usage = household.usage;
  if (!isObject(usage)) return { ok: false, reason: 'missing_household_usage' };
  // Real key is `electricity` (NOT annual_kwh). 18-results.res.txt: usage.electricity: 7007.6875.
  if (!isNumber(usage.electricity)) return { ok: false, reason: 'usage_electricity_not_number' };
  const monthly = usage.electricity_monthly;
  if (!Array.isArray(monthly) || monthly.length !== 12 || !monthly.every(isNumber)) {
    return { ok: false, reason: 'usage_electricity_monthly_not_12_numbers' };
  }
  return {
    ok: true,
    value: {
      annualKwh: usage.electricity,
      monthlyKwh: monthly as number[],
    },
  };
}

function validateTariff(v: unknown): { readonly ok: true; readonly value: ParsedTariff } | { readonly ok: false; readonly reason: string } {
  if (!isObject(v)) return { ok: false, reason: 'tariff_not_object' };
  const { code, name, value, display_type, register_content_code } = v as Record<string, unknown>;
  if (typeof code !== 'string' || !code) return { ok: false, reason: 'tariff_code_missing' };
  if (typeof name !== 'string') return { ok: false, reason: 'tariff_name_not_string' };
  if (!isNumber(value)) return { ok: false, reason: 'tariff_value_not_number' };
  if (display_type !== 'amount' && display_type !== 'percentage') {
    return { ok: false, reason: 'tariff_display_type_invalid' };
  }
  if (typeof register_content_code !== 'string') return { ok: false, reason: 'tariff_register_content_code_not_string' };
  return {
    ok: true,
    value: {
      code,
      name,
      value,
      displayType: display_type as TariffDisplayType,
      registerContentCode: register_content_code,
    },
  };
}

function validatePlan(v: unknown): { readonly ok: true; readonly value: ParsedPlan } | { readonly ok: false; readonly reason: string } {
  if (!isObject(v)) return { ok: false, reason: 'plan_not_object' };
  const { id, name, retailer_id, retailer, energy_type, fixed_term, price_change_due, tariffs } = v as Record<string, unknown>;
  // Real plan id + retailer_id are NUMERIC (e.g. 176000, 68). Stringify at the boundary.
  if (!isNumber(id)) return { ok: false, reason: 'plan_id_not_number' };
  if (typeof name !== 'string') return { ok: false, reason: 'plan_name_not_string' };
  if (!isNumber(retailer_id)) return { ok: false, reason: 'plan_retailer_id_not_number' };
  // Retailer display name rides on the plan (plan.retailer.name) — no separate fetch.
  const retailerName = isObject(retailer) && typeof retailer.name === 'string'
    ? retailer.name
    : String(retailer_id);
  if (typeof energy_type !== 'string') return { ok: false, reason: 'plan_energy_type_not_string' };
  if (typeof fixed_term !== 'boolean') return { ok: false, reason: 'plan_fixed_term_not_boolean' };
  // Real: boolean (false normally, true on 174456 Broadband Bundle). README notes
  // it can also be a date string — accept both, reject anything else.
  if (typeof price_change_due !== 'boolean' && typeof price_change_due !== 'string') {
    return { ok: false, reason: 'plan_price_change_due_not_boolean_or_string' };
  }
  if (!Array.isArray(tariffs) || tariffs.length === 0) return { ok: false, reason: 'plan_tariffs_empty_or_missing' };
  const parsedTariffs: ParsedTariff[] = [];
  for (const t of tariffs) {
    const r = validateTariff(t);
    if (!r.ok) return { ok: false, reason: r.reason };
    parsedTariffs.push(r.value);
  }
  return {
    ok: true,
    value: {
      id: String(id),
      name,
      retailerId: retailerName,
      energyType: energy_type,
      fixedTerm: fixed_term,
      priceChangeDue: price_change_due as boolean | string,
      tariffs: parsedTariffs,
    },
  };
}

function validateResultsBlock(v: unknown): { readonly ok: true; readonly value: ReadonlyArray<ParsedPlan> } | { readonly ok: false; readonly reason: string } {
  if (!isObject(v)) return { ok: false, reason: 'results_root_not_object' };
  const results = v.results;
  if (!Array.isArray(results) || results.length === 0) return { ok: false, reason: 'results_array_empty_or_missing' };
  const plans: ParsedPlan[] = [];
  for (const block of results) {
    if (!isObject(block)) return { ok: false, reason: 'results_entry_not_object' };
    const blockPlans = block.plans;
    if (!Array.isArray(blockPlans)) return { ok: false, reason: 'results_entry_plans_not_array' };
    for (const p of blockPlans) {
      const r = validatePlan(p);
      if (!r.ok) return { ok: false, reason: r.reason };
      plans.push(r.value);
    }
  }
  return { ok: true, value: plans };
}

/**
 * Parse + strict-validate the RSC flight stream. On ANY shape mismatch logs a
 * structured `powerswitch_schema_drift` error and returns a `drift` outcome —
 * NEVER a partial parse. Callers MUST abort without persisting on drift.
 */
export function parseRscResults(flight: string): ParseRscOutcome {
  const rows = extractFlightRows(flight);

  // Locate the household.usage block and the results block across the rows.
  let usage: ParsedUsage | null = null;
  let plans: ReadonlyArray<ParsedPlan> | null = null;

  for (const row of rows) {
    if (!isObject(row)) continue;
    if (usage === null && 'household' in row) {
      const r = validateUsage(row);
      if (!r.ok) return drift(r.reason, flight);
      usage = r.value;
    }
    if (plans === null && 'results' in row) {
      const r = validateResultsBlock(row);
      if (!r.ok) return drift(r.reason, flight);
      plans = r.value;
    }
  }

  if (usage === null) return drift('usage_block_missing', flight);
  if (plans === null) return drift('results_block_missing', flight);

  return { status: 'ok', results: { usage, plans } };
}

function drift(reason: string, flight: string): ParseRscOutcome {
  console.error(JSON.stringify({
    type: 'powerswitch_schema_drift',
    reason,
    sample: truncate(flight),
    timestamp: new Date().toISOString(),
  }));
  return { status: 'drift', reason };
}

function truncate(s: string, max = 300): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}
