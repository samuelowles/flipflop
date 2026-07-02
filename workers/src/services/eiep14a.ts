/**
 * EIEP14A ingestion worker (#64) — fetches the Electricity Authority EIEP14A
 * daily file and upserts plan rows with provenance='eiep14a'.
 *
 * Triggered by Cron (0 3 * * * — daily at 03:00 UTC). The cron is wired in
 * wrangler.toml but the worker ships INERT: it short-circuits unless the
 * EIF_EIEP14A_ENABLED env flag is set to "true". The EA feed is expected to
 * become available in October — flip the flag then.
 *
 * Idempotent: each upsert computes a SHA-256 content_hash over the tracked
 * fields and skips the write when an existing row with the same eiep14a_id
 * already carries that hash. One plan_data_provenance audit row is written
 * per refreshPlans() run.
 */

import { upsertPlan, type UpsertPlanResult } from '../models/plans';

export const EIEP14A_FEED_URL =
  'https://www.emi.ea.govt.nz/Wholesale/Datasets/Mappings/RetailerPlanMapping';

const CACHE_KEY = 'plans:all';
const _CACHE_TTL = 60 * 60 * 24; // 24 hours
const DIFF_KEY_PREFIX = 'plans:diff:';

interface EIEP14ARecord {
  PlanId?: string;
  plan_id?: string;
  id?: string;
  Retailer?: string;
  retailer?: string;
  PlanName?: string;
  plan_name?: string;
  Plan?: string;
  Region?: string;
  region?: string;
  Area?: string;
  area?: string;
  VariableRate?: number;
  variable_rate?: number;
  c_per_kwh?: number;
  DailyCharge?: number;
  daily_charge?: number;
  c_per_day?: number;
  Tiers?: unknown;
  tiers?: unknown;
  PromptPaymentDiscount?: number;
  prompt_payment_discount?: number;
  LowUserEligible?: number;
  low_user_eligible?: number;
  FixedTermMonths?: number;
  fixed_term_months?: number;
  PaymentType?: string;
  payment_type?: string;
  ContractType?: string;
  contract_type?: string;
  ExitFee?: number;
  exit_fee?: number;
  RateType?: string;
  rate_type?: string;
  GSTInclusive?: boolean | string | number;
  gst_inclusive?: boolean | string | number;
  SourceURL?: string;
  source_url?: string;
  [key: `Tier${number}Rate` | `Tier${number}Threshold`]: number | undefined;
}

export interface EnvWithPlans {
  DB: D1Database;
  KV: KVNamespace;
  PYTHON_SERVICE_URL?: string;
  EIEP14A_API_KEY?: string;
  /** Issue #64: gate that keeps EIEP14A ingestion INERT until October. */
  EIF_EIEP14A_ENABLED?: string;
}

/**
 * Whether the EIEP14A worker is armed. Ships false; flip to "true" in October
 * when the EA feed goes live. Exposed for the cron gate in index.ts.
 */
export function isEiep14aEnabled(env: EnvWithPlans): boolean {
  return env.EIF_EIEP14A_ENABLED === 'true';
}

/**
 * Full plan refresh cycle — called from Cron trigger. INERT unless
 * isEiep14aEnabled(env) is true (the cron handler gates on this).
 */
export async function refreshPlans(env: EnvWithPlans): Promise<number> {
  const { records: rawRecords, rawHash, fileUrl } = await fetchEIEP14A(env);
  if (rawRecords.length === 0) {
    console.log(JSON.stringify({
      type: 'plan_ingestion',
      status: 'empty',
      message: 'No records from EIEP14A feed',
      timestamp: new Date().toISOString(),
    }));
    return 0;
  }

  const plans = transformRecords(rawRecords);
  let upserted = 0;
  const now = new Date().toISOString();

  // #68: group change events per retailer so we can emit one KV diff per
  // retailer that had ≥1 change. Retailers with zero changes are left alone
  // (their last-known diff in KV is preserved).
  const changedFieldsByRetailer = new Map<string, string[]>();
  const changeEvents: Array<{ retailer_id: string; plan_id: string; change_type: string }> = [];

  for (const plan of plans) {
    try {
      const contentHash = await computeContentHash(plan);
      const result: UpsertPlanResult = await upsertPlan(env.DB, {
        retailerId: plan.retailer_id,
        name: plan.name,
        region: plan.region,
        cPerKwh: plan.c_per_kwh,
        cPerDay: plan.c_per_day,
        tierThresholdsJson: plan.tier_thresholds_json,
        promptPaymentDiscount: plan.prompt_payment_discount,
        conditionsJson: plan.conditions_json,
        lowUserEligible: plan.low_user_eligible === 1,
        source: 'eiep14a',
        eiep14aId: plan.eiep14a_id,
        effectiveFrom: plan.effective_from,
        effectiveTo: null,
        provenance: 'eiep14a',
        sourceUrl: plan.source_url ?? fileUrl,
        ingestedAt: now,
        contentHash,
        isCurrent: true,
      });

      if (result.changeType !== 'unchanged') {
        upserted++;
        changeEvents.push({
          retailer_id: result.retailerId,
          plan_id: result.plan.id,
          change_type: result.changeType,
        });
        console.log(JSON.stringify({
          type: 'plan_change_event',
          retailer_id: result.retailerId,
          plan_id: result.plan.id,
          change_type: result.changeType,
          changed_fields: result.changedFields,
          timestamp: new Date().toISOString(),
        }));
      }

      // Only 'updated' carries a field-level diff worth recording; 'created'
      // and 'unchanged' do not contribute to a retailer's changed_fields list.
      if (result.changeType === 'updated' && result.changedFields.length > 0) {
        const acc = changedFieldsByRetailer.get(result.retailerId) ?? [];
        for (const f of result.changedFields) {
          if (!acc.includes(f)) acc.push(f);
        }
        changedFieldsByRetailer.set(result.retailerId, acc);
      }
    } catch (error) {
      console.log(JSON.stringify({
        type: 'plan_upsert_error',
        eiep14a_id: plan.eiep14a_id,
        error: error instanceof Error ? error.message : 'unknown',
        timestamp: new Date().toISOString(),
      }));
    }
  }

  // #68: emit one per-retailer KV diff. Retailers with zero changes are NOT
  // overwritten — last-known diff is preserved.
  await writePlanDiffs(env.KV, changedFieldsByRetailer, now);

  // One plan_data_provenance audit row per run (#64).
  await insertProvenanceAudit(env.DB, {
    source: 'eiep14a',
    fetchedAt: now,
    rawHash,
    fileUrl,
    recordCount: rawRecords.length,
    upsertedCount: upserted,
  });

  // Invalidate KV cache
  try {
    await env.KV.delete(CACHE_KEY);
  } catch {
    // KV may not be available in all environments
  }

  console.log(JSON.stringify({
    type: 'plan_ingestion',
    status: 'complete',
    fetched: rawRecords.length,
    upserted,
    timestamp: new Date().toISOString(),
  }));

  return upserted;
}

/**
 * Compute a SHA-256 hex hash over a plan row's tracked fields. Used for
 * hash-based idempotency: if an existing row with the same eiep14a_id
 * already carries this hash, the upsert is skipped.
 */
export async function computeContentHash(plan: TransformedPlan): Promise<string> {
  const payload = JSON.stringify({
    c_per_kwh: plan.c_per_kwh,
    c_per_day: plan.c_per_day,
    tier_thresholds_json: plan.tier_thresholds_json,
    prompt_payment_discount: plan.prompt_payment_discount,
    conditions_json: plan.conditions_json,
    low_user_eligible: plan.low_user_eligible,
    region: plan.region,
    name: plan.name,
  });
  return sha256Hex(payload);
}

/**
 * #68 — write one per-retailer KV diff for each retailer with ≥1 changed field.
 * Format: `{ retailer_id, changed_fields: [...], detected_at: <iso> }` at key
 * `plans:diff:{retailer_id}`. Retailers with zero changes are intentionally
 * NOT written: last-known diff is preserved so a later consumer can still see
 * the most recent change even across no-op refreshes.
 */
async function writePlanDiffs(
  kv: KVNamespace,
  changedFieldsByRetailer: Map<string, string[]>,
  detectedAt: string
): Promise<void> {
  for (const [retailerId, changedFields] of changedFieldsByRetailer) {
    if (changedFields.length === 0) continue;
    try {
      await kv.put(
        `${DIFF_KEY_PREFIX}${retailerId}`,
        JSON.stringify({ retailer_id: retailerId, changed_fields: changedFields, detected_at: detectedAt })
      );
    } catch {
      // KV may not be available in all environments; non-fatal.
    }
  }
}

interface ProvenanceAuditInput {
  source: string;
  fetchedAt: string;
  rawHash: string;
  fileUrl: string;
  recordCount: number;
  upsertedCount: number;
}

/**
 * Insert one run-level audit row into plan_data_provenance (#63 table, #64 use).
 * retailer_id/plan_id are NULL at the run-summary level.
 */
async function insertProvenanceAudit(
  db: D1Database,
  input: ProvenanceAuditInput
): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO plan_data_provenance (
        id, retailer_id, plan_id, source, fetched_at,
        raw_hash, file_url, record_count, upserted_count
      ) VALUES (?1, NULL, NULL, ?2, ?3, ?4, ?5, ?6, ?7)`
    ).bind(
      crypto.randomUUID(),
      input.source,
      input.fetchedAt,
      input.rawHash,
      input.fileUrl,
      input.recordCount,
      input.upsertedCount
    ).run();
  } catch (error) {
    console.log(JSON.stringify({
      type: 'plan_provenance_audit_error',
      error: error instanceof Error ? error.message : 'unknown',
      timestamp: new Date().toISOString(),
    }));
  }
}

/** SHA-256 over a UTF-8 string, returned as lowercase hex. */
async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

interface FetchResult {
  readonly records: readonly EIEP14ARecord[];
  readonly rawHash: string;
  readonly fileUrl: string;
}

/**
 * Fetch EIEP14A data feed.
 * Falls back gracefully — returns empty records on failure.
 * Returns the raw payload SHA-256 (raw_hash) and the source URL for audit.
 */
async function fetchEIEP14A(env: EnvWithPlans): Promise<FetchResult> {
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (env.EIEP14A_API_KEY) {
      headers['Authorization'] = `Bearer ${env.EIEP14A_API_KEY}`;
    }

    const response = await fetch(EIEP14A_FEED_URL, {
      method: 'GET',
      headers,
      cf: { cacheTtl: 3600 },
    });

    if (!response.ok) {
      console.log(JSON.stringify({
        type: 'eiep14a_fetch_error',
        status: response.status,
        timestamp: new Date().toISOString(),
      }));
      return { records: [], rawHash: '', fileUrl: EIEP14A_FEED_URL };
    }

    const contentType = response.headers.get('content-type') ?? '';
    let records: EIEP14ARecord[];
    let rawBody: string;

    if (contentType.includes('application/json')) {
      rawBody = await response.text();
      records = parseJSONResponse(JSON.parse(rawBody) as unknown);
    } else if (contentType.includes('text/csv') || contentType.includes('text/plain')) {
      rawBody = await response.text();
      records = parseCSVResponse(rawBody);
    } else {
      rawBody = await response.text();
      records = parseJSONResponse(JSON.parse(rawBody) as unknown);
    }

    const rawHash = await sha256Hex(rawBody);
    return { records, rawHash, fileUrl: EIEP14A_FEED_URL };
  } catch (error) {
    console.log(JSON.stringify({
      type: 'eiep14a_fetch_error',
      error: error instanceof Error ? error.message : 'unknown',
      timestamp: new Date().toISOString(),
    }));
    return { records: [], rawHash: '', fileUrl: EIEP14A_FEED_URL };
  }
}

function parseJSONResponse(data: unknown): EIEP14ARecord[] {
  if (Array.isArray(data)) return data as EIEP14ARecord[];
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.records)) return obj.records as EIEP14ARecord[];
    if (Array.isArray(obj.items)) return obj.items as EIEP14ARecord[];
    if (Array.isArray(obj.data)) return obj.data as EIEP14ARecord[];
    // Single record
    return [obj as EIEP14ARecord];
  }
  return [];
}

function parseCSVResponse(text: string): EIEP14ARecord[] {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headerLine = lines[0];
  if (!headerLine) return [];
  const headers = headerLine.split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const records: EIEP14ARecord[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const values = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    const record: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      const header = headers[j];
      if (header === undefined) continue;
      record[header] = values[j] ?? '';
    }
    records.push(record as unknown as EIEP14ARecord);
  }
  return records;
}

/**
 * Generate a deterministic UUID v4 from a string seed.
 */
function generateUUID(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  // Create hex string from hash + some fixed pattern for UUID format
  const hex = Math.abs(hash).toString(16).padStart(8, '0');
  return `${hex.slice(0, 8)}-${hex.slice(0, 4)}-4${hex.slice(1, 4)}-a${hex.slice(1, 4)}-${hex.slice(0, 12)}`;
}

interface TransformedPlan {
  retailer_id: string;
  name: string;
  region: string;
  c_per_kwh: number;
  c_per_day: number;
  tier_thresholds_json: string;
  prompt_payment_discount: number;
  conditions_json: string;
  low_user_eligible: number;
  source: string;
  eiep14a_id: string;
  source_url: string | null;
  effective_from: string;
}

const RETAILER_MAP: Record<string, string> = {
  contact: 'Contact Energy',
  contactenergy: 'Contact Energy',
  'contact energy': 'Contact Energy',
  mercury: 'Mercury',
  genesis: 'Genesis Energy',
  genesisenergy: 'Genesis Energy',
  'genesis energy': 'Genesis Energy',
  meridian: 'Meridian Energy',
  meridianenergy: 'Meridian Energy',
  'meridian energy': 'Meridian Energy',
  trustpower: 'Trustpower',
  nova: 'Nova Energy',
  novaenergy: 'Nova Energy',
  'nova energy': 'Nova Energy',
  electrickiwi: 'Electric Kiwi',
  'electric kiwi': 'Electric Kiwi',
  powershop: 'Powershop',
  flick: 'Flick Electric',
  flickelectric: 'Flick Electric',
  'flick electric': 'Flick Electric',
  pulse: 'Pulse Energy',
  pulseenergy: 'Pulse Energy',
  'pulse energy': 'Pulse Energy',
};

function normaliseRetailer(name: string): string {
  const lower = name.trim().toLowerCase();
  return RETAILER_MAP[lower] ?? name.trim();
}

function retailerNameToId(name: string): string {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(RETAILER_MAP)) {
    if (value.toLowerCase() === lower) return key.split(' ')[0]!;
  }
  return lower.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function safeFloat(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function safeInt(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

/** #65: coerce common truthy feed values to a boolean (mirrors python _to_bool). */
function toBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return ['true', '1', 'yes', 'y', 't'].includes(String(value).trim().toLowerCase());
}

function extractTiers(rec: EIEP14ARecord): Array<{ threshold_kwh: number; c_per_kwh: number }> {
  const tiers: Array<{ threshold_kwh: number; c_per_kwh: number }> = [];

  if (rec.Tiers !== undefined || rec.tiers !== undefined) {
    const raw = rec.Tiers ?? rec.tiers;
    if (Array.isArray(raw)) {
      for (const t of raw) {
        if (t && typeof t === 'object') {
          const tier = t as Record<string, unknown>;
          tiers.push({
            threshold_kwh: safeFloat(tier.Threshold ?? tier.threshold),
            c_per_kwh: safeFloat(tier.Rate ?? tier.rate),
          });
        }
      }
      return tiers;
    }
  }

  // Tier1Rate/Tier1Threshold pattern
  for (let i = 1; i <= 5; i++) {
    const rate = (rec as Record<string, unknown>)[`Tier${i}Rate`] ?? (rec as Record<string, unknown>)[`tier${i}_rate`];
    if (rate !== undefined) {
      const threshold = (rec as Record<string, unknown>)[`Tier${i}Threshold`] ?? (rec as Record<string, unknown>)[`tier${i}_threshold`];
      tiers.push({
        threshold_kwh: safeFloat(threshold),
        c_per_kwh: safeFloat(rate),
      });
    }
  }

  return tiers;
}

export function transformRecords(rawRecords: readonly EIEP14ARecord[]): TransformedPlan[] {
  const now = new Date().toISOString();
  const seen = new Set<string>();
  const plans: TransformedPlan[] = [];

  for (const rec of rawRecords) {
    if (!rec || typeof rec !== 'object') continue;

    const eiep14aId = String(rec.PlanId ?? rec.plan_id ?? rec.id ?? generateUUID(JSON.stringify(rec)));
    if (seen.has(eiep14aId)) continue;
    seen.add(eiep14aId);

    const retailerName = normaliseRetailer(rec.Retailer ?? rec.retailer ?? '');
    const planName = rec.PlanName ?? rec.plan_name ?? rec.Plan ?? 'Unknown Plan';
    const region = String(rec.Region ?? rec.region ?? rec.Area ?? rec.area ?? 'National');
    const cPerKwh = safeFloat(rec.VariableRate ?? rec.variable_rate ?? rec.c_per_kwh);
    const cPerDay = safeFloat(rec.DailyCharge ?? rec.daily_charge ?? rec.c_per_day);
    const tiers = extractTiers(rec);
    const ppd = safeFloat(rec.PromptPaymentDiscount ?? rec.prompt_payment_discount);
    const lowUser = safeInt(rec.LowUserEligible ?? rec.low_user_eligible);

    const conditions: Record<string, unknown> = {};
    const fixedTerm = rec.FixedTermMonths ?? rec.fixed_term_months;
    if (fixedTerm !== undefined) conditions.fixed_term_months = safeInt(fixedTerm);
    const paymentType = rec.PaymentType ?? rec.payment_type;
    if (paymentType) conditions.payment_type = String(paymentType);
    const contractType = rec.ContractType ?? rec.contract_type;
    if (contractType) conditions.contract_type = String(contractType);
    const exitFee = rec.ExitFee ?? rec.exit_fee;
    if (exitFee !== undefined) conditions.exit_fee_cents = safeInt(exitFee);
    // #65: rate_type + gst_inclusive live in conditions_json (no new column).
    const rateType = rec.RateType ?? rec.rate_type;
    if (rateType) conditions.rate_type = String(rateType).toUpperCase();
    const gstRaw = rec.GSTInclusive ?? rec.gst_inclusive;
    conditions.gst_inclusive = gstRaw === undefined ? true : toBool(gstRaw);

    // #65: per-record source_url overrides the run-level fileUrl.
    const recSourceUrl = rec.SourceURL ?? rec.source_url;
    const sourceUrl = recSourceUrl ? String(recSourceUrl) : null;

    plans.push({
      retailer_id: retailerNameToId(retailerName),
      name: planName,
      region,
      c_per_kwh: cPerKwh,
      c_per_day: cPerDay,
      tier_thresholds_json: tiers.length > 0 ? JSON.stringify(tiers) : '[]',
      prompt_payment_discount: ppd,
      conditions_json: JSON.stringify(conditions),
      low_user_eligible: lowUser,
      source: 'eiep14a',
      eiep14a_id: eiep14aId,
      source_url: sourceUrl,
      effective_from: now,
    });
  }

  return plans;
}
