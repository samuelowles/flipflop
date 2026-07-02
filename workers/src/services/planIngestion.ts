/**
 * Plan ingestion service — fetches EIEP14A data and upserts plans into D1.
 *
 * Triggered by Cron (0 3 * * * — daily at 03:00 UTC).
 * Caches plan list in KV for fast comparison lookups.
 */

import { upsertPlan } from '../models/plans';

const EIEP14A_FEED_URL =
  'https://www.emi.ea.govt.nz/Wholesale/Datasets/Mappings/RetailerPlanMapping';

const CACHE_KEY = 'plans:all';
const _CACHE_TTL = 60 * 60 * 24; // 24 hours

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
  [key: `Tier${number}Rate` | `Tier${number}Threshold`]: number | undefined;
}

export interface EnvWithPlans {
  DB: D1Database;
  KV: KVNamespace;
  PYTHON_SERVICE_URL?: string;
  EIEP14A_API_KEY?: string;
}

/**
 * Full plan refresh cycle — called from Cron trigger.
 */
export async function refreshPlans(env: EnvWithPlans): Promise<number> {
  const rawRecords = await fetchEIEP14A(env);
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

  for (const plan of plans) {
    try {
      await upsertPlan(env.DB, {
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
        sourceUrl: null,
        ingestedAt: null,
        contentHash: null,
        isCurrent: true,
      });
      upserted++;
    } catch (error) {
      console.log(JSON.stringify({
        type: 'plan_upsert_error',
        eiep14a_id: plan.eiep14a_id,
        error: error instanceof Error ? error.message : 'unknown',
        timestamp: new Date().toISOString(),
      }));
    }
  }

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
 * Fetch EIEP14A data feed.
 * Falls back gracefully — returns empty array on failure.
 */
async function fetchEIEP14A(env: EnvWithPlans): Promise<readonly EIEP14ARecord[]> {
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
      return [];
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const data = await response.json() as unknown;
      return parseJSONResponse(data);
    }

    if (contentType.includes('text/csv') || contentType.includes('text/plain')) {
      const text = await response.text();
      return parseCSVResponse(text);
    }

    // Try JSON anyway
    const data = await response.json() as unknown;
    return parseJSONResponse(data);
  } catch (error) {
    console.log(JSON.stringify({
      type: 'eiep14a_fetch_error',
      error: error instanceof Error ? error.message : 'unknown',
      timestamp: new Date().toISOString(),
    }));
    return [];
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

function transformRecords(rawRecords: readonly EIEP14ARecord[]): TransformedPlan[] {
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

    plans.push({
      retailer_id: retailerNameToId(retailerName),
      name: planName,
      region,
      c_per_kwh: cPerKwh,
      c_per_day: cPerDay,
      tier_thresholds_json: tiers.length > 0 ? JSON.stringify(tiers) : '[]',
      prompt_payment_discount: ppd,
      conditions_json: Object.keys(conditions).length > 0 ? JSON.stringify(conditions) : '{}',
      low_user_eligible: lowUser,
      source: 'eiep14a',
      eiep14a_id: eiep14aId,
      effective_from: now,
    });
  }

  return plans;
}
