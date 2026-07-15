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
 *
 * #225: feed parsing/normalisation split into eiep14aParser.ts. This module
 * retains ingestion/orchestration only (fetch, upsert loop, provenance audit,
 * `plans:diff` writes). Public parsing exports are re-exported below so
 * existing importers (`./eiep14a`) are unaffected.
 */

import { upsertPlan, type UpsertPlanResult } from '../models/plans';
import {
  computeContentHash,
  parseCSVResponse,
  parseJSONResponse,
  sha256Hex,
  transformRecords,
  type EIEP14ARecord,
} from './eiep14aParser';

// Re-export public parsing API so existing `from './eiep14a'` importers resolve.
export {
  computeContentHash,
  transformRecords,
  type EIEP14ARecord,
  type TransformedPlan,
} from './eiep14aParser';

export const EIEP14A_FEED_URL =
  'https://www.emi.ea.govt.nz/Wholesale/Datasets/Mappings/RetailerPlanMapping';

const CACHE_KEY = 'plans:all';
const _CACHE_TTL = 60 * 60 * 24; // 24 hours
const DIFF_KEY_PREFIX = 'plans:diff:';

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
