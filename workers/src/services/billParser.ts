import { getBillById, updateBillStatus, updateBillParsedData } from '../models/bills';
import { getUserById } from '../models/users';
import { sendAndLog } from './messaging';
import { getRetailerById } from '../models/retailers';
import { renderTemplate } from './sentTemplates';
import type { BillStatus, MeterType } from '../types/bill';

interface ParseServiceRequest {
  readonly file_bytes: string;
  readonly user_id: string;
  readonly retailer_id: string;
}

interface ParseServiceResponse {
  readonly retailer_id?: string;
  readonly plan_name?: string;
  readonly meter_type?: string;
  readonly period_start?: string;
  readonly period_end?: string;
  readonly days?: number;
  readonly usage_kwh?: number;
  readonly total_cents?: number;
  readonly c_per_kwh?: number;
  readonly c_per_day?: number;
  readonly fixed_term_expiry?: string | null;
  readonly break_fee_cents?: number;
  readonly confidence: number;
  readonly error?: string;
}

interface ParseEnv {
  readonly DB: D1Database;
  readonly BILLS: R2Bucket;
  readonly COMPARE_QUEUE: Queue<{ userId: string; billId: string }>;
  readonly SENT_API_KEY: string;
  readonly ENCRYPTION_KEY: string;
  readonly PYTHON_SERVICE_URL?: string;
  readonly PYTHON_SERVICE_AUTH_TOKEN?: string;
  /**
   * Bills whose parser confidence falls below this value are routed to manual
   * review (status=needs_review) instead of auto-accepted. Tunable via env so
   * the threshold can be adjusted without redeploying code. Issue #41.
   */
  readonly F1_HINT_CONFIDENCE_THRESHOLD?: string;
}

/** Default confidence threshold when F1_HINT_CONFIDENCE_THRESHOLD is unset. */
const DEFAULT_CONFIDENCE_THRESHOLD = 0.85;
const VALID_METER_TYPES: readonly string[] = ['standard', 'low_user', 'day_night', 'controlled'];
const PARSE_TIMEOUT_MS = 30_000;

function validateMeterType(raw: string | undefined): MeterType | undefined {
  if (!raw) return undefined;
  const normalized = raw.toLowerCase().trim();
  return VALID_METER_TYPES.includes(normalized) ? (normalized as MeterType) : undefined;
}

/**
 * Error thrown by parseBill. Carries a short no-PII error_code for the bills
 * table and a `transient` flag: transient errors (5xx, network, timeout) are
 * retryable by the queue consumer; terminal errors (4xx, extract_failed,
 * no_media) are not. Issue #39.
 */
export class ParseError extends Error {
  readonly errorCode: string;
  readonly transient: boolean;

  constructor(errorCode: string, message: string, transient: boolean) {
    super(message);
    this.name = 'ParseError';
    this.errorCode = errorCode;
    this.transient = transient;
  }
}

/**
 * Single-shot POST to the Python /parse endpoint. Retries are handled at the
 * queue-consumer level (Cloudflare Queues max_retries + DLQ), so this function
 * does NOT retry internally — it classifies the failure and throws ParseError.
 * Forwards user_id (for the parser's per-user context) and retailer_id hint.
 */
export async function parseBill(
  fileBytes: ArrayBuffer,
  userId: string,
  retailerId: string,
  pythonServiceUrl: string,
  authToken?: string
): Promise<ParseServiceResponse> {
  const bytes = new Uint8Array(fileBytes);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  const base64String = btoa(binary);

  const body: ParseServiceRequest = {
    file_bytes: base64String,
    user_id: userId,
    retailer_id: retailerId,
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PARSE_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${pythonServiceUrl}/parse`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    // Network failure, DNS, or abort (timeout) — transient, retryable.
    const isAbort = err instanceof DOMException && err.name === 'AbortError';
    throw new ParseError(
      isAbort ? 'parse_timeout' : 'python_network',
      isAbort ? 'Python /parse timed out' : `Python /parse network error: ${err instanceof Error ? err.message : String(err)}`,
      true
    );
  }
  clearTimeout(timeoutId);

  if (!response.ok) {
    const transient = response.status >= 500;
    const code = transient ? `python_${response.status}` : `python_${response.status}`;
    throw new ParseError(
      code,
      `Python parse service returned ${response.status}`,
      transient
    );
  }

  const result = await response.json() as ParseServiceResponse;

  // Parser returned a response but flagged an extraction failure — terminal.
  if (result.error) {
    throw new ParseError('extract_failed', `Parse error: ${result.error}`, false);
  }

  return result;
}

/**
 * Resolve the confidence threshold from env, falling back to the default when
 * unset or non-numeric. Issue #41: threshold is configurable via
 * F1_HINT_CONFIDENCE_THRESHOLD so it can be tuned without redeploying code.
 */
function resolveConfidenceThreshold(env: ParseEnv): number {
  const raw = env.F1_HINT_CONFIDENCE_THRESHOLD;
  if (raw === undefined || raw === '') return DEFAULT_CONFIDENCE_THRESHOLD;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_CONFIDENCE_THRESHOLD;
}

export async function handleParseJob(
  billId: string,
  r2Key: string,
  env: ParseEnv
): Promise<void> {
  const pythonUrl = env.PYTHON_SERVICE_URL ?? 'http://localhost:8000';
  const confidenceThreshold = resolveConfidenceThreshold(env);

  // 1. Fetch bill from D1
  const bill = await getBillById(env.DB, billId);
  if (!bill) {
    console.log(JSON.stringify({
      type: 'parse_error',
      billId,
      error: 'Bill not found in D1',
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  console.log(JSON.stringify({
    type: 'parse_start',
    billId,
    r2Key,
    retailerId: bill.retailerId,
    timestamp: new Date().toISOString(),
  }));

  // 2. Set bill status to 'parsing'
  await updateBillStatus(env.DB, billId, 'parsing');

  // 3. Download raw PDF from R2
  const r2Object = await env.BILLS.get(r2Key);
  if (!r2Object) {
    // No media to parse — terminal failure, not retryable.
    throw new ParseError('no_media', `R2 object not found: ${r2Key}`, false);
  }

  console.log(JSON.stringify({
    type: 'parse_r2_download',
    billId,
    r2Key,
    size: r2Object.size,
    timestamp: new Date().toISOString(),
  }));

  // 4. Get file bytes and POST to Python /parse endpoint (single-shot).
  //    Forwards user_id and retailer hint. Throws ParseError on failure.
  const fileBytes = await r2Object.arrayBuffer();
  const parseResult = await parseBill(
    fileBytes,
    bill.userId,
    bill.retailerId ?? '',
    pythonUrl,
    env.PYTHON_SERVICE_AUTH_TOKEN
  );

  // 5. Determine status from confidence
  const status: Extract<BillStatus, 'parsed' | 'needs_review'> =
    parseResult.confidence >= confidenceThreshold ? 'parsed' : 'needs_review';

  // 6. Update bill with parsed data (sets parsed_at via the model)
  await updateBillParsedData(env.DB, billId, {
    retailerId: parseResult.retailer_id ?? bill.retailerId ?? undefined,
    planName: parseResult.plan_name,
    meterType: validateMeterType(parseResult.meter_type),
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
    status,
  });

  // 7. Enqueue comparison if confidence is good
  if (status === 'parsed') {
    await env.COMPARE_QUEUE.send({ userId: bill.userId, billId });

    console.log(JSON.stringify({
      type: 'parse_enqueued_comparison',
      billId,
      userId: bill.userId,
      timestamp: new Date().toISOString(),
    }));
  }

  // 8. Send confirmation message to user (Epic #2 #42: bill_received template)
  const user = await getUserById(env.DB, { ENCRYPTION_KEY: env.ENCRYPTION_KEY }, bill.userId);
  const phone = user?.phone ?? null;
  if (phone) {
    // Resolve retailer display name from the bill's retailerId.
    const retailer = bill.retailerId
      ? await getRetailerById(env.DB, bill.retailerId)
      : null;
    const retailerName = retailer?.name ?? bill.retailerId ?? 'power';
    const usageKwh = parseResult.usage_kwh != null ? `${Math.round(parseResult.usage_kwh)}` : '0';
    const days = parseResult.days != null ? `${parseResult.days}` : '0';
    const totalDollars = parseResult.total_cents != null
      ? `${Math.round(parseResult.total_cents / 100)}`
      : '0';

    // Render the bill_received template body locally (PRD 7.7) and send via
    // sendAndLog so it gets channel-routed + persisted to messages table.
    // We render here (rather than via Sent's template API) so we keep parity
    // with the free-text path when Sent hasn't approved the template yet.
    const confirmMsg = renderTemplate('bill_received', {
      retailer: retailerName,
      usage_kwh: usageKwh,
      days,
      total_dollars: totalDollars,
    });

    await sendAndLog(
      env.SENT_API_KEY, env.DB, { ENCRYPTION_KEY: env.ENCRYPTION_KEY },
      bill.userId, phone, confirmMsg
    );
  }

  // 9. Log completion
  console.log(JSON.stringify({
    type: 'parse_complete',
    billId,
    status,
    confidence: parseResult.confidence,
    timestamp: new Date().toISOString(),
  }));
}
