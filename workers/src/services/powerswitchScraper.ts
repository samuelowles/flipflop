/**
 * #66 — Powerswitch scraper bridge (TEMPORARY, sunset when EIEP14A lands).
 *
 * COMPLIANCE OVERRIDE: docs/AI_RULES.md prohibits scraping Billy, Powerswitch,
 * and retailer websites. This module is an EXPLICIT, DOCUMENTED, TEMPORARY
 * EXCEPTION scoped to public plan-listing pages on https://www.powerswitch.org.nz
 * only. It exists because the EIEP14A feed (issue #64) is not available until
 * October 2026 and Powerswitch is the temporary live plan-data path.
 *
 * Sunset trigger: when #64 is live AND EIEP14A coverage is sufficient, set
 * POWERSWITCH_SCRAPER_ENABLED back to "false" and remove this module (and its
 * cron branch in index.ts). The override block in docs/AI_RULES.md documents
 * the full scope and approval (2026-06-19).
 *
 * SAFETY:
 *  - Ships INERT. POWERSWITCH_SCRAPER_ENABLED defaults to "false".
 *  - Submits ZERO PII. No ICP, address, account, or user data is ever sent.
 *    Only public plan-listing HTML pages are fetched.
 *  - Rate-limited with exponential backoff (constants below).
 *  - Documented user-agent string identifying the service + contact.
 *  - Never overwrites provenance='manual' rows (manual data always wins).
 *
 * Issue #67 (next wave) builds the python parser + completeness gate that
 * consumes the HTML fixtures under workers/tests/fixtures/powerswitch/. The
 * TS parse here is a minimal best-effort extraction for the audit/upsert path.
 */

import { upsertPowerswitchPlan } from '../models/plans';

/** Base URL for public Powerswitch plan-listing pages. Public, no auth. */
export const POWERSWITCH_BASE_URL = 'https://www.powerswitch.org.nz';

/**
 * #223 — KV prefix for per-retailer plan-data diffs. Mirrors eiep14a.ts
 * DIFF_KEY_PREFIX exactly so planDiffConsumer (#75) consumes both sources
 * identically. Value shape: { retailer_id, changed_fields, detected_at }.
 */
const DIFF_KEY_PREFIX = 'plans:diff:';

/**
 * Documented user agent. Identifies the service, the issue governing the
 * override, and a contact address so Powerswitch can reach us if needed.
 * Operators must set POWERSWITCH_CONTACT_EMAIL in the deployed env.
 */
export const POWERSWITCH_USER_AGENT =
  'FlipNZ-BillMonitor/1.0 (+https://flip.nz; issue #66; contact: ops@flip.nz)';

/** Rate-limit / backoff constants. Conservative; Powerswitch is a shared resource. */
const REQUEST_DELAY_MS = 1500; // delay between sequential page fetches
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 2000; // 2s, 4s, 8s

/** Selector-drift guard: if more than this many money fields are missing, the run fails. */
export const MONEY_FIELD_MISSING_THRESHOLD = 0.5;

export interface EnvWithPowerswitch {
  DB: D1Database;
  KV: KVNamespace;
  /** #66: gate that keeps the scraper INERT. Defaults false. */
  POWERSWITCH_SCRAPER_ENABLED?: string;
}

/**
 * Whether the Powerswitch scraper is armed. Ships false; flip to "true" only
 * while the EIEP14A feed is unavailable. Exposed for the cron gate in index.ts.
 */
export function isPowerswitchEnabled(env: EnvWithPowerswitch): boolean {
  return env.POWERSWITCH_SCRAPER_ENABLED === 'true';
}

/** Result of parsing a single fetched page. */
export interface ParsedPlan {
  readonly retailer: string;
  readonly retailerId: string;
  readonly planName: string;
  readonly region: string;
  readonly cPerKwh: number | null;
  readonly cPerDay: number | null;
  readonly promptPaymentDiscount: number | null;
  readonly lowUserEligible: boolean;
  readonly conditions: Record<string, unknown>;
  readonly sourceUrl: string;
}

/** Run-level counters written to one plan_data_provenance audit row. */
export interface ScrapeCounts {
  fetched: number;
  parsed: number;
  skipped: number;
  failed: number;
}

/**
 * Full scrape cycle — called from Cron trigger. INERT unless
 * isPowerswitchEnabled(env) is true (the cron handler gates on this).
 * Returns the counts (also persisted to plan_data_provenance).
 */
export async function scrapePowerswitchPlans(
  env: EnvWithPowerswitch
): Promise<ScrapeCounts> {
  const counts: ScrapeCounts = { fetched: 0, parsed: 0, skipped: 0, failed: 0 };
  const now = new Date().toISOString();

  // (a) INERT gate — the cron also checks this, but double-guard the entry point.
  if (!isPowerswitchEnabled(env)) {
    console.log(JSON.stringify({
      type: 'powerswitch_skipped',
      reason: 'POWERSWITCH_SCRAPER_ENABLED not "true"',
      timestamp: now,
    }));
    return counts;
  }

  // #223 — accumulate retailers whose plan data changed during this run so we
  // can emit one plans:diff:{retailer_id} KV key per changed retailer, matching
  // eiep14a.ts writePlanDiffs. upsertPowerswitchPlan returns no field-level
  // diff, so the sentinel lists the tracked fields the scraper owns.
  const changedRetailers = new Set<string>();

  const pageUrls = listPlanPageUrls();
  const rawPages: Array<{ url: string; html: string }> = [];

  for (const url of pageUrls) {
    try {
      const html = await fetchWithBackoff(url);
      rawPages.push({ url, html });
      counts.fetched++;
      await delay(REQUEST_DELAY_MS);
    } catch (error) {
      counts.failed++;
      console.log(JSON.stringify({
        type: 'powerswitch_fetch_error',
        url,
        error: error instanceof Error ? error.message : 'unknown',
        timestamp: new Date().toISOString(),
      }));
    }
  }

  let rawHashInput = '';
  for (const { url, html } of rawPages) {
    rawHashInput += html;
    try {
      const parsed = parsePlanPage(html, url);
      if (!parsed) {
        counts.skipped++;
        continue;
      }
      // (e) upsert with manual-protection: upsertPowerswitchPlan skips any
      // existing provenance='manual' row for the same (retailer, name, region).
      const { changed, blockedByManual } = await upsertPowerswitchPlan(env.DB, {
        plan: parsed,
        ingestedAt: now,
      });
      if (blockedByManual) {
        counts.skipped++;
      } else if (changed) {
        counts.parsed++;
        changedRetailers.add(parsed.retailerId);
      } else {
        counts.skipped++;
      }
    } catch (error) {
      counts.failed++;
      console.log(JSON.stringify({
        type: 'powerswitch_parse_error',
        url,
        error: error instanceof Error ? error.message : 'unknown',
        timestamp: new Date().toISOString(),
      }));
    }
  }

  // #223 — write per-retailer diff keys so the daily re-compare cron (#75,
  // planDiffConsumer.ts) can pick up Powerswitch-sourced changes. Mirrors
  // eiep14a.ts: same prefix, same { retailer_id, changed_fields, detected_at }
  // value shape. Retailers with zero changes get no key (parity behaviour).
  await writePlanDiffs(env.KV, changedRetailers, now);

  const rawHash = await sha256Hex(rawHashInput);
  await insertProvenanceAudit(env.DB, {
    source: 'powerswitch',
    fetchedAt: now,
    rawHash,
    fileUrl: POWERSWITCH_BASE_URL,
    counts,
  });

  // Invalidate KV plans cache so the read-side sees fresh data.
  try {
    await env.KV.delete('plans:all');
  } catch {
    // KV may be unavailable in some environments.
  }

  console.log(JSON.stringify({
    type: 'powerswitch_scrape_complete',
    ...counts,
    timestamp: new Date().toISOString(),
  }));

  return counts;
}

/**
 * The set of public plan-listing page URLs to fetch. Scoped to plan-listing
 * pages only — never submits ICP, address, or user data.
 * Region codes mirror the EIEP14A region taxonomy where possible.
 */
export function listPlanPageUrls(): string[] {
  const regions = ['auckland', 'wellington', 'christchurch'];
  return regions.map(
    (r) => `${POWERSWITCH_BASE_URL}/plans/${r}`
  );
}

/**
 * Fetch a single page with exponential backoff on transient failures.
 * Uses a documented user-agent and cache headers.
 */
export async function fetchWithBackoff(url: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': POWERSWITCH_USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
        },
        cf: { cacheTtl: 3600 },
      });
      if (response.status >= 500 && attempt < MAX_RETRIES) {
        await delay(BACKOFF_BASE_MS * 2 ** (attempt - 1));
        continue;
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) {
        await delay(BACKOFF_BASE_MS * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('fetch failed after retries');
}

/**
 * Parse a Powerswitch plan-listing HTML page into a ParsedPlan.
 * Best-effort regex/selector extraction. Returns null if required fields are
 * missing beyond the drift threshold (the run records it as skipped).
 *
 * The python parser in #67 will own authoritative parsing; this TS path is
 * the ingestion hook that upserts what it can and writes the audit row.
 */
export function parsePlanPage(html: string, sourceUrl: string): ParsedPlan | null {
  const retailer = extractFirstMatch(html, [
    /<meta[^>]+name=["']retailer["'][^>]+content=["']([^"']+)["']/i,
    /data-retailer=["']([^"']+)["']/i,
    /<h1[^>]*>([^<]+)<\/h1>/i,
  ]);
  const planName = extractFirstMatch(html, [
    /<meta[^>]+name=["']plan-name["'][^>]+content=["']([^"']+)["']/i,
    /data-plan-name=["']([^"']+)["']/i,
    /<h2[^>]*class=["'][^"']*plan-name[^"']*["'][^>]*>([^<]+)<\/h2>/i,
  ]);
  const region = extractFirstMatch(html, [
    /<meta[^>]+name=["']region["'][^>]+content=["']([^"']+)["']/i,
    /data-region=["']([^"']+)["']/i,
  ]);

  const cPerKwh = extractMoney(html, ['variable-rate', 'c-per-kwh', 'variableRate']);
  const cPerDay = extractMoney(html, ['daily-charge', 'c-per-day', 'dailyCharge']);
  const ppd = extractMoney(html, ['prompt-payment-discount', 'ppd']);
  const lowUserEligible = /low[-_ ]?user[^<]*eligible/i.test(html);

  // Selector-drift guard: if both money fields are null, the page structure
  // has shifted and we should not write garbage. Return null -> counted skipped.
  const moneyFields = [cPerKwh, cPerDay];
  const missing = moneyFields.filter((v) => v === null).length;
  if (missing / moneyFields.length > MONEY_FIELD_MISSING_THRESHOLD) {
    return null;
  }

  if (!retailer || !planName) {
    return null;
  }

  const conditions: Record<string, unknown> = {};
  const touMatch = html.match(/data-tou=["'](true|false)["']/i);
  if (touMatch) conditions.tou = touMatch[1] === 'true';

  return {
    retailer: retailer.trim(),
    retailerId: retailerNameToId(retailer),
    planName: planName.trim(),
    region: (region ?? 'National').trim(),
    cPerKwh,
    cPerDay,
    promptPaymentDiscount: ppd,
    lowUserEligible,
    conditions,
    sourceUrl,
  };
}

/**
 * Selector-drift check: given an array of (fixture-html, expected-money-field-count)
 * pairs, returns true if the fraction of missing required money fields across
 * the sample exceeds MONEY_FIELD_MISSING_THRESHOLD. Used by the drift test.
 */
export function detectSelectorDrift(
  samples: ReadonlyArray<{ html: string }>
): { drift: boolean; missingRatio: number } {
  let totalMoneyFields = 0;
  let missing = 0;
  for (const { html } of samples) {
    const cPerKwh = extractMoney(html, ['variable-rate', 'c-per-kwh']);
    const cPerDay = extractMoney(html, ['daily-charge', 'c-per-day']);
    const fields = [cPerKwh, cPerDay];
    totalMoneyFields += fields.length;
    missing += fields.filter((v) => v === null).length;
  }
  const missingRatio = totalMoneyFields === 0 ? 1 : missing / totalMoneyFields;
  return { drift: missingRatio > MONEY_FIELD_MISSING_THRESHOLD, missingRatio };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractFirstMatch(html: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) return match[1];
  }
  return null;
}

function extractMoney(html: string, dataKeys: string[]): number | null {
  for (const key of dataKeys) {
    const pattern = new RegExp(
      `data-${key}=["']([0-9]+(?:\\.[0-9]+)?)["']`,
      'i'
    );
    const match = html.match(pattern);
    if (match && match[1]) {
      const n = Number(match[1]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

const RETAILER_MAP: Record<string, string> = {
  contact: 'Contact Energy',
  mercury: 'Mercury',
  genesis: 'Genesis Energy',
  meridian: 'Meridian Energy',
  trustpower: 'Trustpower',
  nova: 'Nova Energy',
  'electric kiwi': 'Electric Kiwi',
  powershop: 'Powershop',
  flick: 'Flick Electric',
  pulse: 'Pulse Energy',
};

function normaliseRetailer(name: string): string {
  const lower = name.trim().toLowerCase();
  return RETAILER_MAP[lower] ?? name.trim();
}

function retailerNameToId(name: string): string {
  const lower = normaliseRetailer(name).toLowerCase();
  for (const [key, value] of Object.entries(RETAILER_MAP)) {
    if (value.toLowerCase() === lower) return key.split(' ')[0]!;
  }
  return lower.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/**
 * #223 — the tracked plan fields the Powerswitch scraper owns. Recorded as the
 * changed_fields sentinel in the diff payload: upsertPowerswitchPlan returns no
 * field-level diff, so the consumer (planDiffConsumer.ts) only uses this for
 * observability/logging. Listed to keep parity with eiep14a's field-level diffs.
 */
const TRACKED_PLAN_FIELDS = [
  'c_per_kwh',
  'c_per_day',
  'prompt_payment_discount',
  'conditions_json',
  'low_user_eligible',
];

/**
 * #223 — write one per-retailer KV diff for each retailer with ≥1 changed plan.
 * Mirrors eiep14a.ts writePlanDiffs: format
 * `{ retailer_id, changed_fields: [...], detected_at: <iso> }` at key
 * `plans:diff:{retailer_id}`. Retailers with zero changes are NOT written.
 */
async function writePlanDiffs(
  kv: KVNamespace,
  changedRetailers: Set<string>,
  detectedAt: string
): Promise<void> {
  for (const retailerId of changedRetailers) {
    try {
      await kv.put(
        `${DIFF_KEY_PREFIX}${retailerId}`,
        JSON.stringify({
          retailer_id: retailerId,
          changed_fields: TRACKED_PLAN_FIELDS,
          detected_at: detectedAt,
        })
      );
    } catch {
      // KV may not be available in all environments; non-fatal.
    }
  }
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

interface ProvenanceAuditInput {
  source: string;
  fetchedAt: string;
  rawHash: string;
  fileUrl: string;
  counts: ScrapeCounts;
}

/**
 * Insert one run-level audit row into plan_data_provenance. Mirrors the
 * eiep14a.ts audit shape; counts map to record_count/upserted_count.
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
      input.counts.fetched + input.counts.parsed,
      input.counts.parsed
    ).run();
  } catch (error) {
    console.log(JSON.stringify({
      type: 'powerswitch_provenance_audit_error',
      error: error instanceof Error ? error.message : 'unknown',
      timestamp: new Date().toISOString(),
    }));
  }
}
