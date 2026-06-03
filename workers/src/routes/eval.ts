/**
 * Web-based bill evaluation routes.
 *
 * Provides a browser-facing bill upload → parse → compare → result flow
 * that bypasses Sent and DeepSeek entirely. Reuses the existing Python
 * /parse and /compare endpoints synchronously.
 */

import type { Context } from 'hono';
import { parseBill } from '../services/billParser';
import { createBill, getBillsByUserId, updateBillParsedData } from '../models/bills';
import { createUser, findOrCreateByPhone } from '../models/users';
import { createComparison } from '../models/comparisons';
import { getPlansByRegion, getPlansByRetailer } from '../models/plans';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EvalEnv {
  DB: D1Database;
  KV: KVNamespace;
  BILLS: R2Bucket;
  ENCRYPTION_KEY: string;
  PYTHON_SERVICE_URL?: string;
  PYTHON_SERVICE_AUTH_TOKEN?: string;
}

interface BillSummary {
  readonly id: string;
  readonly usageKwh: number;
  readonly totalCents: number;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly days: number;
  readonly breakFeeCents?: number;
}

interface UsageProfile {
  readonly avgDailyKwh: number;
  readonly meterType: string;
  readonly seasonalWeights: { readonly summer: number; readonly winter: number };
}

interface ComparisonResultItem {
  readonly plan_name: string;
  readonly retailer_name: string;
  readonly retailer_id: string;
  readonly projected_cost_cents: number;
  readonly current_cost_cents: number;
  readonly saving_cents: number;
  readonly confidence: number;
  readonly stay_where_you_are: boolean;
}

// ---------------------------------------------------------------------------
// Helpers (extracted from planComparator.ts to avoid queue/Sent coupling)
// ---------------------------------------------------------------------------

function billToSummary(bill: {
  id: string;
  usageKwh: number | null;
  totalCents: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  days: number | null;
  breakFeeCents: number | null;
}): BillSummary | null {
  if (
    bill.usageKwh == null ||
    bill.totalCents == null ||
    !bill.periodStart ||
    !bill.periodEnd ||
    bill.days == null
  ) {
    return null;
  }
  return {
    id: bill.id,
    usageKwh: bill.usageKwh,
    totalCents: bill.totalCents,
    periodStart: bill.periodStart,
    periodEnd: bill.periodEnd,
    days: bill.days,
    breakFeeCents: bill.breakFeeCents ?? undefined,
  };
}

function computeAvgDailyKwh(summaries: readonly BillSummary[]): number {
  if (summaries.length === 0) return 0;
  const totalKwh = summaries.reduce((s, b) => s + b.usageKwh, 0);
  const totalDays = summaries.reduce((s, b) => s + b.days, 0);
  return totalDays > 0 ? Math.round((totalKwh / totalDays) * 100) / 100 : 0;
}

function getSeason(m: number): 'summer' | 'winter' | 'shoulder' {
  if (m === 11 || m === 0 || m === 1) return 'summer';
  if (m === 5 || m === 6 || m === 7) return 'winter';
  return 'shoulder';
}

function computeSeasonalWeights(
  summaries: readonly BillSummary[]
): { summer: number; winter: number } {
  const seasonal = { summer: 0, winter: 0 };
  const counts = { summer: 0, winter: 0 };

  for (const b of summaries) {
    const month = new Date(b.periodStart).getMonth();
    const season = getSeason(month);
    if (season === 'summer') {
      seasonal.summer += b.usageKwh;
      counts.summer++;
    } else if (season === 'winter') {
      seasonal.winter += b.usageKwh;
      counts.winter++;
    }
  }

  return {
    summer: counts.summer > 0 ? seasonal.summer / counts.summer : 0,
    winter: counts.winter > 0 ? seasonal.winter / counts.winter : 0,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

function formatSavings(cents: number): string {
  if (cents <= 0) return '$0';
  return '$' + Math.round(cents / 100).toString();
}

// ---------------------------------------------------------------------------
// KV-based rate limiter (inline, no dependency on middleware/rateLimit.ts)
// ---------------------------------------------------------------------------

async function checkEvalRateLimit(
  kv: KVNamespace,
  ip: string
): Promise<boolean> {
  const key = `rate:eval:${ip}`;
  const windowMs = 60_000;
  const limit = 5;

  const existing = await kv.get(key);
  if (!existing) {
    await kv.put(key, '1', { expirationTtl: Math.ceil(windowMs / 1000) });
    return true;
  }
  const count = parseInt(existing, 10);
  if (isNaN(count) || count < limit) {
    await kv.put(key, String(count + 1), {
      expirationTtl: Math.ceil(windowMs / 1000),
    });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// HTML renderers
// ---------------------------------------------------------------------------

function renderUploadPage(error?: string): string {
  const errorHtml = error
    ? `<div class="error-msg">${escapeHtml(error)}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Flip — Evaluate a Power Bill</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 24px; background: #fafafa; }
    h1 { font-size: 1.25rem; margin-bottom: 4px; }
    .subtitle { color: #666; margin-bottom: 24px; font-size: 0.9rem; }
    .card { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 16px; }
    label { display: block; font-weight: 600; margin-bottom: 6px; font-size: 0.9rem; }
    input[type="file"], input[type="text"] { width: 100%; padding: 10px 12px; border: 1px solid #ccc; border-radius: 6px; font-size: 0.95rem; box-sizing: border-box; margin-bottom: 16px; }
    input[type="file"]::file-selector-button { padding: 8px 16px; border: none; border-radius: 4px; background: #1a73e8; color: #fff; cursor: pointer; font-size: 0.85rem; margin-right: 10px; }
    button { width: 100%; padding: 12px; background: #1a73e8; color: #fff; border: none; border-radius: 6px; font-size: 1rem; font-weight: 600; cursor: pointer; }
    button:hover { background: #1557b0; }
    .error-msg { color: #d93025; background: #fce8e6; border: 1px solid #f5c6cb; padding: 10px 14px; border-radius: 6px; margin-bottom: 16px; font-size: 0.85rem; }
    .help-text { color: #888; font-size: 0.75rem; margin-top: -12px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <h1>Evaluate a power bill</h1>
  <p class="subtitle">Upload a NZ power bill PDF. We&rsquo;ll parse it, compare plans, and show you if there are savings — no account needed.</p>

  ${errorHtml}

  <form method="POST" action="/eval/upload" enctype="multipart/form-data" class="card">
    <label for="file">Bill (PDF)</label>
    <input type="file" id="file" name="file" accept=".pdf,application/pdf" required>
    <label for="phone">Mobile number <span style="font-weight:400;color:#888;">(optional — helps us match your existing account)</span></label>
    <input type="text" id="phone" name="phone" placeholder="+64211234567" pattern="^\\+?64\\d{8,10}$" inputmode="tel">
    <p class="help-text">NZ mobile numbers only. Leave blank for a one-off evaluation.</p>
    <button type="submit">Evaluate bill</button>
  </form>
</body>
</html>`;
}

function renderResultPage(
  token: string,
  parsedData: Record<string, unknown> | null,
  comparisons: readonly Record<string, unknown>[] | null,
  isAnonymous: boolean,
  error?: string
): string {
  if (error || !parsedData) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Flip — Evaluation Error</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 24px; background: #fafafa; }
    h1 { font-size: 1.25rem; }
    .card { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 16px; }
    .error-msg { color: #d93025; background: #fce8e6; border: 1px solid #f5c6cb; padding: 14px; border-radius: 6px; font-size: 0.9rem; }
    a { color: #1a73e8; }
  </style>
</head>
<body>
  <h1>Evaluation error</h1>
  <div class="card">
    <div class="error-msg">${escapeHtml(error ?? 'Could not load evaluation results.')}</div>
  </div>
  <p><a href="/eval">Try another bill</a></p>
</body>
</html>`;
  }

  // --- Parsed bill section ---
  const billFields: [string, string][] = [
    ['Retailer', String(parsedData.retailer_name ?? parsedData.retailer ?? '—')],
    ['Plan', String(parsedData.plan_name ?? '—')],
    ['Period', parsedData.period_start && parsedData.period_end
      ? `${parsedData.period_start} — ${parsedData.period_end}`
      : '—'],
    ['Days', parsedData.days != null ? String(parsedData.days) : '—'],
    ['Usage', parsedData.usage_kwh != null ? `${parsedData.usage_kwh} kWh` : '—'],
    ['Total cost', parsedData.total_cents != null ? `$${formatCents(Number(parsedData.total_cents))}` : '—'],
    ['Effective rate', parsedData.c_per_kwh != null
      ? `${Number(parsedData.c_per_kwh).toFixed(1)} c/kWh + ${Number(parsedData.c_per_day ?? 0).toFixed(1)} c/day`
      : '—'],
    ['Meter type', String(parsedData.meter_type ?? '—')],
    ['ICP number', isAnonymous && parsedData.icp_number
      ? 'Available (sign in to view)'
      : String(parsedData.icp_number ?? '—')],
    ['Parse confidence', parsedData.confidence != null
      ? `${Math.round(Number(parsedData.confidence) * 100)}%`
      : '—'],
  ];

  const billRows = billFields
    .map(
      ([label, value]) =>
        `<div class="stat"><span class="stat-label">${escapeHtml(label)}</span><span class="stat-value">${escapeHtml(value)}</span></div>`
    )
    .join('');

  // --- Comparison table ---
  let comparisonHtml = '<p>No comparisons available.</p>';

  if (comparisons && comparisons.length > 0) {
    const rows = comparisons
      .map((c) => {
        const planName = String(c.plan_name ?? '—');
        const retailer = String(c.retailer_name ?? c.retailer_id ?? '—');
        const projected = Number(c.projected_cost_cents ?? 0);
        const saving = Number(c.saving_cents ?? 0);
        const confidence = Number(c.confidence ?? 0);
        const stay = Boolean(c.stay_where_you_are);

        const savingClass = stay ? 'saving-neutral' : 'saving-positive';
        const badge = stay
          ? '<span class="badge badge-stay">Stay where you are</span>'
          : '<span class="badge badge-switch">Could save</span>';

        return `<tr class="${stay ? 'row-stay' : ''}">
          <td>${escapeHtml(planName)}<br><span class="retailer-sub">${escapeHtml(retailer)}</span></td>
          <td class="num">$${formatCents(projected)}</td>
          <td class="num ${savingClass}">${saving > 0 ? '$' + formatSavings(saving) : '$0'}</td>
          <td class="num">${Math.round(confidence * 100)}%</td>
          <td>${badge}</td>
        </tr>`;
      })
      .join('');

    comparisonHtml = `
    <table>
      <thead>
        <tr>
          <th>Plan</th>
          <th class="num">Projected / year</th>
          <th class="num">Savings / year</th>
          <th class="num">Confidence</th>
          <th>Recommendation</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Flip — Evaluation Results</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 24px; background: #fafafa; }
    h1 { font-size: 1.25rem; margin-bottom: 4px; }
    .subtitle { color: #666; margin-bottom: 24px; font-size: 0.9rem; }
    .card { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 16px; }
    .stat { display: flex; justify-content: space-between; padding: 5px 0; border-bottom: 1px solid #f5f5f5; }
    .stat:last-child { border-bottom: none; }
    .stat-label { color: #666; font-size: 0.85rem; }
    .stat-value { font-weight: 600; font-size: 0.9rem; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th { text-align: left; padding: 8px 6px; border-bottom: 2px solid #e0e0e0; color: #666; font-weight: 600; }
    th.num { text-align: right; }
    td { padding: 8px 6px; border-bottom: 1px solid #f0f0f0; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
    .retailer-sub { color: #888; font-size: 0.75rem; }
    .saving-positive { color: #1e8e3e; font-weight: 600; }
    .saving-neutral { color: #888; }
    .badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 0.7rem; font-weight: 600; white-space: nowrap; }
    .badge-stay { background: #d4edda; color: #155724; }
    .badge-switch { background: #fff3cd; color: #856404; }
    .row-stay { background: #f9fff9; }
    .actions { text-align: center; margin-top: 24px; }
    .actions a { color: #1a73e8; }
  </style>
</head>
<body>
  <h1>Evaluation results</h1>
  <p class="subtitle">Based on your uploaded bill. This is an estimate, not a guarantee.</p>

  <div class="card">
    <h3>Parsed bill</h3>
    ${billRows}
  </div>

  <div class="card">
    <h3>Plan comparison</h3>
    ${comparisonHtml}
  </div>

  <div class="actions">
    <a href="/eval">Evaluate another bill</a>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Shared comparison runner — used by both /eval and Gmail callback flows
// ---------------------------------------------------------------------------

export async function runEvalComparison(
  env: EvalEnv,
  userId: string
): Promise<{
  parsedData: Record<string, unknown> | null;
  comparisons: readonly Record<string, unknown>[];
}> {
  const pythonUrl = env.PYTHON_SERVICE_URL ?? 'http://localhost:8000';
  const allBills = await getBillsByUserId(env.DB, userId);
  const parsedBills = allBills.filter(b => b.status === 'parsed');

  if (parsedBills.length === 0) {
    return { parsedData: null, comparisons: [] };
  }

  const billSummaries = parsedBills
    .map(billToSummary)
    .filter(Boolean) as BillSummary[];

  const avgDailyKwh = computeAvgDailyKwh(billSummaries);
  const seasonalWeights = computeSeasonalWeights(billSummaries);
  const latestBill = parsedBills[0]!;

  const usageProfile: UsageProfile = {
    avgDailyKwh,
    meterType: latestBill.meterType ?? 'standard',
    seasonalWeights,
  };

  const currentPlan: Record<string, unknown> = {
    plan_name: latestBill.planName ?? 'Unknown',
    retailer_id: latestBill.retailerId,
    c_per_kwh: latestBill.cPerKwh,
    c_per_day: latestBill.cPerDay,
    meter_type: latestBill.meterType,
    break_fee_cents: latestBill.breakFeeCents,
    fixed_term_expiry: latestBill.fixedTermExpiry,
  };

  // Derive region
  let region = 'National';
  if (latestBill.retailerId) {
    const retailerPlans = await getPlansByRetailer(env.DB, latestBill.retailerId);
    if (retailerPlans.length > 0) {
      const matchingPlan = latestBill.planName
        ? retailerPlans.find(p => p.name === latestBill.planName)
        : undefined;
      region = matchingPlan?.region ?? retailerPlans[0]!.region ?? 'National';
    }
  }

  const availablePlans = await getPlansByRegion(env.DB, region);

  if (latestBill.retailerId && latestBill.planName) {
    const matched = availablePlans.find(
      p => p.retailerId === latestBill.retailerId && p.name === latestBill.planName
    );
    if (matched) currentPlan.id = matched.id;
  }

  const planDicts = availablePlans.map(p => ({
    id: p.id,
    retailer_id: p.retailerId,
    name: p.name,
    region: p.region,
    c_per_kwh: p.cPerKwh,
    c_per_day: p.cPerDay,
    tier_thresholds_json: p.tierThresholdsJson,
    prompt_payment_discount: p.promptPaymentDiscount,
    conditions_json: p.conditionsJson,
    low_user_eligible: p.lowUserEligible,
  }));

  // Call Python /compare
  const compareHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (env.PYTHON_SERVICE_AUTH_TOKEN) {
    compareHeaders['Authorization'] = `Bearer ${env.PYTHON_SERVICE_AUTH_TOKEN}`;
  }

  const compareController = new AbortController();
  const compareTimeout = setTimeout(() => compareController.abort(), 30000);

  let compareResponse: Response;
  try {
    compareResponse = await fetch(`${pythonUrl}/compare`, {
      method: 'POST',
      headers: compareHeaders,
      body: JSON.stringify({
        usageProfile,
        currentPlan,
        availablePlans: planDicts,
        billHistory: billSummaries,
      }),
      signal: compareController.signal,
    });
  } finally {
    clearTimeout(compareTimeout);
  }

  if (!compareResponse.ok) {
    throw new Error(`Comparison service returned ${compareResponse.status}`);
  }

  const compareResult = (await compareResponse.json()) as {
    comparisons: ComparisonResultItem[];
  };

  // Store comparison results and build the parsed data snapshot
  const storedComparisons: Record<string, unknown>[] = [];
  for (const item of compareResult.comparisons) {
    const matchedPlan = availablePlans.find(
      p => p.retailerId === item.retailer_id && p.name === item.plan_name
    );
    if (!matchedPlan) continue;

    await createComparison(env.DB, {
      userId,
      planId: matchedPlan.id,
      billIdsJson: JSON.stringify(billSummaries.map(b => b.id)),
      projectedCostCents: item.projected_cost_cents,
      currentCostCents: item.current_cost_cents,
      savingCents: item.saving_cents,
      confidence: item.confidence,
    });

    storedComparisons.push({ ...item });
  }

  // Build parsed data snapshot from latest bill
  const parsedData: Record<string, unknown> = {
    retailer_name: latestBill.retailerId,
    plan_name: latestBill.planName,
    meter_type: latestBill.meterType,
    icp_number: '', // not stored on bills table
    period_start: latestBill.periodStart,
    period_end: latestBill.periodEnd,
    days: latestBill.days,
    usage_kwh: latestBill.usageKwh,
    total_cents: latestBill.totalCents,
    c_per_kwh: latestBill.cPerKwh,
    c_per_day: latestBill.cPerDay,
    fixed_term_expiry: latestBill.fixedTermExpiry,
    break_fee_cents: latestBill.breakFeeCents,
    confidence: latestBill.confidence,
  };

  return { parsedData, comparisons: storedComparisons };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * GET /eval — renders the bill upload form.
 */
export async function evalUploadPage(c: Context): Promise<Response> {
  const error = c.req.query('error');
  const html = renderUploadPage(error ?? undefined);
  return c.html(html);
}

/**
 * POST /eval/upload — accepts a PDF bill, processes it synchronously
 * through parse → compare, stores results in KV, and redirects to the
 * result page.
 */
export async function evalUploadHandler(c: Context): Promise<Response> {
  const env = c.env as unknown as EvalEnv;
  const now = Date.now();

  // Rate limiting
  const ip =
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-forwarded-for') ??
    'unknown';
  const rateOk = await checkEvalRateLimit(env.KV, ip);
  if (!rateOk) {
    return c.html(
      renderUploadPage('Too many uploads. Try again in a minute.'),
      429
    );
  }

  // CSRF: reject cross-origin POSTs
  const origin = c.req.header('Origin') ?? '';
  const host = c.req.header('Host') ?? '';
  if (origin && host && !origin.includes(host)) {
    return c.html(
      renderUploadPage('Cross-origin requests are not allowed.'),
      403
    );
  }

  let body: Record<string, string | File>;
  try {
    body = (await c.req.parseBody()) as Record<string, string | File>;
  } catch {
    return c.redirect('/eval?error=' + encodeURIComponent('Could not read the uploaded form data.'));
  }

  const file = body.file;
  const phone = body.phone;

  // Validate file
  if (!file || !(file instanceof File)) {
    return c.redirect('/eval?error=' + encodeURIComponent('Please select a PDF file to upload.'));
  }

  if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
    return c.redirect('/eval?error=' + encodeURIComponent('Only PDF files are accepted.'));
  }

  if (file.size > 10 * 1024 * 1024) {
    return c.redirect('/eval?error=' + encodeURIComponent('File is too large. Maximum size is 10 MB.'));
  }

  const token = crypto.randomUUID();
  const pythonUrl = env.PYTHON_SERVICE_URL ?? 'http://localhost:8000';

  try {
    // 1. Create or find user
    const phoneStr = typeof phone === 'string' && phone.trim()
      ? phone.trim()
      : '';

    const NZ_MOBILE_REGEX = /^\+64\d{7,11}$/;
    const isRealPhone = phoneStr && NZ_MOBILE_REGEX.test(phoneStr);
    let userId: string;
    let isAnonymous: boolean;

    if (isRealPhone) {
      const { user } = await findOrCreateByPhone(env.DB, { ENCRYPTION_KEY: env.ENCRYPTION_KEY }, phoneStr);
      userId = user.id;
      isAnonymous = false;
    } else {
      // Reuse a single shared anonymous user to avoid unbounded D1 growth
      const { user } = await findOrCreateByPhone(env.DB, { ENCRYPTION_KEY: env.ENCRYPTION_KEY }, 'eval-anonymous');
      userId = user.id;
      isAnonymous = true;
    }

    // 2. Store PDF in R2
    const r2Key = `bills/${userId}/${now}.pdf`;
    const pdfBuffer = await file.arrayBuffer();

    // Verify PDF magic bytes before storing
    const header = new Uint8Array(pdfBuffer.slice(0, 5));
    const isPdfMagic =
      header[0] === 0x25 && header[1] === 0x50 &&
      header[2] === 0x44 && header[3] === 0x46 && header[4] === 0x2d; // %PDF-
    if (!isPdfMagic) {
      return c.redirect('/eval?error=' + encodeURIComponent('File does not appear to be a valid PDF.'));
    }

    await env.BILLS.put(r2Key, pdfBuffer);

    // 3. Create bill record
    const bill = await createBill(env.DB, {
      userId,
      rawR2Key: r2Key,
      source: 'web',
    });

    // 4. Parse bill via Python
    const parseResult = await parseBill(
      pdfBuffer,
      '', // empty retailer_id triggers GenericParser auto-detection
      pythonUrl,
      env.PYTHON_SERVICE_AUTH_TOKEN
    );

    if (parseResult.error) {
      throw new Error(`Parsing failed: ${parseResult.error}`);
    }

    // 5. Update bill with parsed data
    const meterType = parseResult.meter_type &&
      ['standard', 'low_user', 'day_night', 'controlled'].includes(parseResult.meter_type)
      ? (parseResult.meter_type as 'standard' | 'low_user' | 'day_night' | 'controlled')
      : undefined;

    await updateBillParsedData(env.DB, bill.id, {
      retailerId: parseResult.retailer_id,
      planName: parseResult.plan_name,
      meterType,
      periodStart: parseResult.period_start,
      periodEnd: parseResult.period_end,
      days: parseResult.days,
      usageKwh: parseResult.usage_kwh,
      totalCents: parseResult.total_cents,
      cPerKwh: parseResult.c_per_kwh,
      cPerDay: parseResult.c_per_day,
      fixedTermExpiry: parseResult.fixed_term_expiry ?? null,
      breakFeeCents: parseResult.break_fee_cents,
      confidence: parseResult.confidence,
      parsedJson: JSON.stringify(parseResult),
      status: parseResult.confidence >= 0.6 ? 'parsed' : 'needs_review',
    });

    // 6. Run comparison (shared with Gmail callback flow)
    let comparisons: readonly Record<string, unknown>[] = [];
    try {
      const evalResult = await runEvalComparison(env, userId);
      comparisons = evalResult.comparisons;
    } catch (compareErr) {
      // Comparison failure is non-fatal — still show parsed results
      console.log(JSON.stringify({
        type: 'eval_compare_failed',
        token,
        error: (compareErr as Error).message,
        timestamp: new Date().toISOString(),
      }));
    }

    // 7. Store in KV and redirect
    await env.KV.put(
      `eval:${token}`,
      JSON.stringify({ parsedData: parseResult, comparisons, isAnonymous }),
      { expirationTtl: 86400 }
    );

    console.log(JSON.stringify({
      type: 'eval_complete',
      token,
      userId,
      billId: bill.id,
      plansCompared: comparisons.length,
      durationMs: Date.now() - now,
      timestamp: new Date().toISOString(),
    }));

    return c.redirect(`/eval/result?token=${token}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'An unexpected error occurred.';
    console.log(JSON.stringify({
      type: 'eval_error',
      token,
      error: msg,
      durationMs: Date.now() - now,
      timestamp: new Date().toISOString(),
    }));

    // Store error in KV so the result page can display it
    await env.KV.put(
      `eval:${token}`,
      JSON.stringify({ parsedData: null, comparisons: null, error: msg }),
      { expirationTtl: 86400 }
    ).catch(() => { /* best-effort */ });

    return c.redirect(
      `/eval/result?token=${token}&error=${encodeURIComponent(msg)}`
    );
  }
}

/**
 * GET /eval/result — displays the evaluation results from KV.
 */
export async function evalResultPage(c: Context): Promise<Response> {
  const env = c.env as unknown as EvalEnv;
  const token = c.req.query('token') ?? '';
  const errorParam = c.req.query('error') ?? undefined;

  if (!token) {
    return c.html(renderResultPage('', null, null, false, 'Missing evaluation token.'));
  }

  let error = errorParam ? decodeURIComponent(errorParam) : undefined;

  try {
    const stored = await env.KV.get(`eval:${token}`);
    if (!stored) {
      return c.html(
        renderResultPage(token, null, null, false, 'Evaluation not found or has expired. Results are available for 24 hours.')
      );
    }

    const data = JSON.parse(stored) as {
      parsedData: Record<string, unknown> | null;
      comparisons: readonly Record<string, unknown>[] | null;
      isAnonymous?: boolean;
      error?: string;
    };

    if (data.error && !error) error = data.error;

    if (!data.parsedData && !error) {
      error = 'No parsed data available for this evaluation.';
    }

    return c.html(renderResultPage(token, data.parsedData, data.comparisons, data.isAnonymous ?? false, error));
  } catch {
    return c.html(
      renderResultPage(token, null, null, false, 'Could not read evaluation results.')
    );
  }
}

/**
 * GET /eval/status — JSON endpoint returning evaluation progress/result.
 */
export async function evalStatus(c: Context): Promise<Response> {
  const env = c.env as unknown as EvalEnv;
  const token = c.req.query('token') ?? '';

  if (!token) {
    return c.json({ found: false, error: 'Missing token' }, 400);
  }

  try {
    const stored = await env.KV.get(`eval:${token}`);
    if (!stored) {
      return c.json({ found: false }, 404);
    }

    const data = JSON.parse(stored);
    return c.json({ found: true, ...data });
  } catch {
    return c.json({ found: false, error: 'Could not read results' }, 500);
  }
}
