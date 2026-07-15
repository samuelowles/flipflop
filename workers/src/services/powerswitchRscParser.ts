/**
 * #221 — Powerswitch RSC results parser.
 *
 * Parses the RSC (React Server Components) flight stream returned by
 * `GET /results?p={token}` into a structured plan set. The flight format is
 * line-keyed: each line is `id:JSON` (or a bare JSON value) and the
 * plan/usage objects are plain JSON values embedded in the stream.
 *
 * STRICT SCHEMA GUARD: on ANY shape mismatch the parser returns a `drift`
 * outcome and emits a structured `powerswitch_schema_drift` error. It NEVER
 * returns a partial/garbage parse — callers MUST abort without persisting on
 * drift. This mirrors the `MONEY_FIELD_MISSING_THRESHOLD` drift-guard
 * philosophy in services/powerswitchScraper.ts.
 *
 * Separated from powerswitchReplay.ts because schema validation is a distinct,
 * independently-testable responsibility; the replay orchestrates HTTP + caching
 * and consumes this parser.
 */

// ---------------------------------------------------------------------------
// Structured types (what the parser produces)
// ---------------------------------------------------------------------------

export type TariffDisplayType = 'amount' | 'percentage';

/** A single tariff line within a plan (F, D1, N1, TD3, ...). */
export interface ParsedTariff {
  readonly code: string;
  readonly name: string;
  /** Scalar value — cents/kWh (amount) or percentage off (percentage). */
  readonly value: number;
  /** 12-month series of the same unit as `value`. */
  readonly valueArray: ReadonlyArray<number>;
  readonly displayType: TariffDisplayType;
  /** Register content code: PK, OFFPEAK, FREE, F, ... */
  readonly registerContentCode: string;
  /** Free-text description (carries TOU window text + special conditions). */
  readonly description: string;
  /** ISO date the price was last changed. */
  readonly pricesLastChanged: string | null;
}

/** A plan within the results set. */
export interface ParsedPlan {
  readonly id: string;
  readonly name: string;
  readonly retailerId: string;
  readonly energyType: string;
  readonly fixedTerm: boolean;
  /** ISO date or null. */
  readonly priceChangeDue: string | null;
  readonly tariffs: ReadonlyArray<ParsedTariff>;
}

/** Household usage estimate. */
export interface ParsedUsage {
  readonly annualKwh: number;
  /** 12-month series (Jan..Dec). */
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
 * Split the flight stream into its `id:JSON` lines and parse each. Returns the
 * list of parsed top-level values (objects). Lines that are not valid JSON or
 * not objects are skipped (the flight carries control lines too); the schema
 * guard below validates the *extracted* objects, so skipped control lines are
 * safe.
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
  if (!isNumber(usage.annual_kwh)) return { ok: false, reason: 'usage_annual_kwh_not_number' };
  const monthly = usage.monthly_kwh;
  if (!Array.isArray(monthly) || monthly.length !== 12 || !monthly.every(isNumber)) {
    return { ok: false, reason: 'usage_monthly_kwh_not_12_numbers' };
  }
  return {
    ok: true,
    value: {
      annualKwh: usage.annual_kwh,
      monthlyKwh: monthly as number[],
    },
  };
}

function validateTariff(v: unknown): { readonly ok: true; readonly value: ParsedTariff } | { readonly ok: false; readonly reason: string } {
  if (!isObject(v)) return { ok: false, reason: 'tariff_not_object' };
  const { code, name, value, value_array, display_type, register_content_code, description, prices_last_changed } = v as Record<string, unknown>;
  if (typeof code !== 'string' || !code) return { ok: false, reason: 'tariff_code_missing' };
  if (typeof name !== 'string') return { ok: false, reason: 'tariff_name_not_string' };
  if (!isNumber(value)) return { ok: false, reason: 'tariff_value_not_number' };
  if (!Array.isArray(value_array) || value_array.length !== 12 || !value_array.every(isNumber)) {
    return { ok: false, reason: 'tariff_value_array_not_12_numbers' };
  }
  if (display_type !== 'amount' && display_type !== 'percentage') {
    return { ok: false, reason: 'tariff_display_type_invalid' };
  }
  if (typeof register_content_code !== 'string') return { ok: false, reason: 'tariff_register_content_code_not_string' };
  if (typeof description !== 'string') return { ok: false, reason: 'tariff_description_not_string' };
  if (prices_last_changed !== null && typeof prices_last_changed !== 'string') {
    return { ok: false, reason: 'tariff_prices_last_changed_not_string_or_null' };
  }
  return {
    ok: true,
    value: {
      code,
      name,
      value,
      valueArray: value_array as number[],
      displayType: display_type as TariffDisplayType,
      registerContentCode: register_content_code,
      description,
      pricesLastChanged: prices_last_changed as string | null,
    },
  };
}

function validatePlan(v: unknown): { readonly ok: true; readonly value: ParsedPlan } | { readonly ok: false; readonly reason: string } {
  if (!isObject(v)) return { ok: false, reason: 'plan_not_object' };
  const { id, name, retailer_id, energy_type, fixed_term, price_change_due, tariffs } = v as Record<string, unknown>;
  if (typeof id !== 'string' || !id) return { ok: false, reason: 'plan_id_missing' };
  if (typeof name !== 'string') return { ok: false, reason: 'plan_name_not_string' };
  if (typeof retailer_id !== 'string') return { ok: false, reason: 'plan_retailer_id_not_string' };
  if (typeof energy_type !== 'string') return { ok: false, reason: 'plan_energy_type_not_string' };
  if (typeof fixed_term !== 'boolean') return { ok: false, reason: 'plan_fixed_term_not_boolean' };
  if (price_change_due !== null && typeof price_change_due !== 'string') {
    return { ok: false, reason: 'plan_price_change_due_not_string_or_null' };
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
      id,
      name,
      retailerId: retailer_id,
      energyType: energy_type,
      fixedTerm: fixed_term,
      priceChangeDue: price_change_due as string | null,
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
