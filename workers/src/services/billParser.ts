import { getBillById, updateBillStatus, updateBillParsedData } from '../models/bills';
import { getUserById } from '../models/users';
import { sendMessage } from './messaging';
import type { BillStatus, MeterType } from '../types/bill';

interface ParseServiceRequest {
  readonly file_bytes: string;
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
}

const CONFIDENCE_THRESHOLD = 0.6;
const VALID_METER_TYPES: readonly string[] = ['standard', 'low_user', 'day_night', 'controlled'];

function validateMeterType(raw: string | undefined): MeterType | undefined {
  if (!raw) return undefined;
  const normalized = raw.toLowerCase().trim();
  return VALID_METER_TYPES.includes(normalized) ? (normalized as MeterType) : undefined;
}

export async function parseBill(
  fileBytes: ArrayBuffer,
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

  const body: ParseServiceRequest = { file_bytes: base64String, retailer_id: retailerId };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const maxAttempts = 2;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(`${pythonServiceUrl}/parse`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        // 4xx — do NOT retry, throw immediately
        if (response.status >= 400 && response.status < 500) {
          throw new Error(`Python parse service returned ${response.status}`);
        }
        // 5xx — retry once with 1s backoff
        if (attempt === 0) {
          console.log(JSON.stringify({
            type: 'parse_retry',
            status: response.status,
            attempt,
            timestamp: new Date().toISOString(),
          }));
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
        throw new Error(`Python parse service returned ${response.status}`);
      }

      return response.json() as Promise<ParseServiceResponse>;
    } catch (err) {
      clearTimeout(timeoutId);

      // Network error, timeout, or other transient failure on first attempt — retry once
      if (attempt === 0) {
        console.log(JSON.stringify({
          type: 'parse_retry',
          error: err instanceof Error ? err.message : String(err),
          attempt,
          timestamp: new Date().toISOString(),
        }));
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }

      throw err;
    }
  }

  // Unreachable — either returned from try or threw from catch
  throw new Error('parseBill: exhausted retries');
}

export async function handleParseJob(
  billId: string,
  r2Key: string,
  env: ParseEnv
): Promise<void> {
  const pythonUrl = env.PYTHON_SERVICE_URL ?? 'http://localhost:8000';

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
    throw new Error(`R2 object not found: ${r2Key}`);
  }

  console.log(JSON.stringify({
    type: 'parse_r2_download',
    billId,
    r2Key,
    size: r2Object.size,
    timestamp: new Date().toISOString(),
  }));

  // 4. Get file bytes and POST to Python /parse endpoint
  const fileBytes = await r2Object.arrayBuffer();
  const parseResult = await parseBill(fileBytes, bill.retailerId ?? '', pythonUrl, env.PYTHON_SERVICE_AUTH_TOKEN);

  // 5. Handle parser-level errors
  if (parseResult.error) {
    throw new Error(`Parse error: ${parseResult.error}`);
  }

  // 6. Determine status from confidence
  const status: Extract<BillStatus, 'parsed' | 'needs_review'> =
    parseResult.confidence >= CONFIDENCE_THRESHOLD ? 'parsed' : 'needs_review';

  // 7. Update bill with parsed data
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

  // 8. Enqueue comparison if confidence is good
  if (status === 'parsed') {
    await env.COMPARE_QUEUE.send({ userId: bill.userId, billId });

    console.log(JSON.stringify({
      type: 'parse_enqueued_comparison',
      billId,
      userId: bill.userId,
      timestamp: new Date().toISOString(),
    }));
  }

  // 9. Send confirmation message to user
  const user = await getUserById(env.DB, { ENCRYPTION_KEY: env.ENCRYPTION_KEY }, bill.userId);
  const phone = user?.phone ?? null;
  if (phone) {
    const usageKwh = parseResult.usage_kwh != null ? `${Math.round(parseResult.usage_kwh)} kWh` : '';
    const amount = parseResult.total_cents != null
      ? `$${Math.round(parseResult.total_cents / 100)}`
      : '';
    const retailerName = bill.retailerId ?? 'power';
    const periodMonth = parseResult.period_start
      ? new Date(parseResult.period_start).toLocaleString('en-NZ', { month: 'long' })
      : 'your recent';

    const confirmMsg = status === 'parsed'
      ? `Got your ${retailerName} bill for ${periodMonth}: ${amount} for ${usageKwh}. I'm comparing it now.`
      : `Got your ${retailerName} bill for ${periodMonth}: ${amount} for ${usageKwh}. I'll review it and get back to you.`;

    await sendMessage(env.SENT_API_KEY, phone, confirmMsg);
  }

  // 10. Log completion
  console.log(JSON.stringify({
    type: 'parse_complete',
    billId,
    status,
    confidence: parseResult.confidence,
    timestamp: new Date().toISOString(),
  }));
}
