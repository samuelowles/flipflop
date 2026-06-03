/**
 * Ingestion intelligence — DeepSeek-powered validation and classification.
 *
 * DeepSeek classifies retailers, validates parser output against NZ norms,
 * and generates user-facing bill summaries. It NEVER extracts bill data
 * or calculates costs — Python handles all deterministic extraction.
 */

interface ValidationResult {
  readonly valid: boolean;
  readonly warnings: readonly string[];
  readonly anomalyFlags: readonly string[];
}

interface RetailerClassification {
  readonly retailerId: string;
  readonly confidence: number;
}

interface BillSummaryContext {
  readonly retailerName: string;
  readonly planName: string;
  readonly periodMonth: string;
  readonly usageKwh: number;
  readonly totalDollars: number; // rounded to nearest dollar
  readonly days: number;
}

const DEEPSEEK_FLASH_TIMEOUT = 800;

async function callDeepSeek(prompt: string, apiKey: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEEPSEEK_FLASH_TIMEOUT);

  try {
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content: 'You are a NZ electricity market expert. You ONLY classify and validate — never calculate costs or extract data. Respond with JSON only, no markdown.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0,
        max_tokens: 256,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`DeepSeek API error: ${response.status}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices[0]?.message?.content ?? '{}';
  } finally {
    clearTimeout(timeout);
  }
}

const RETAILER_LIST = [
  'contact', 'mercury', 'genesis', 'meridian', 'trustpower',
  'nova', 'electrickiwi', 'powershop', 'flick', 'pulse',
  'orcon', 'slingshot', 'energyclubnz',
];

/**
 * Detect which NZ retailer a bill is from based on filename and optional text snippet.
 * Used as a fallback when the email sender domain isn't a clean match.
 */
export async function detectRetailer(
  filename: string,
  pdfText?: string,
  apiKey?: string
): Promise<RetailerClassification> {
  if (!apiKey) {
    // Fallback: check filename for known retailer keywords
    const lower = filename.toLowerCase();
    for (const retailer of RETAILER_LIST) {
      if (lower.includes(retailer)) {
        return { retailerId: retailer, confidence: 0.6 };
      }
    }
    return { retailerId: 'unknown', confidence: 0 };
  }

  try {
    const textSnippet = pdfText ? pdfText.slice(0, 500) : filename;
    const response = await callDeepSeek(
      `Classify which NZ electricity retailer this bill is from. Known retailers: ${RETAILER_LIST.join(', ')}.\n\nFilename: ${filename}\nText snippet: ${textSnippet}\n\nRespond: {"retailer_id": "<id>", "confidence": <0-1>}`,
      apiKey
    );
    const parsed = JSON.parse(response) as { retailer_id?: string; confidence?: number };
    const retailerId = typeof parsed.retailer_id === 'string' ? parsed.retailer_id.toLowerCase() : 'unknown';
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;

    if (RETAILER_LIST.includes(retailerId)) {
      return { retailerId, confidence };
    }

    return { retailerId: 'unknown', confidence: 0 };
  } catch {
    return { retailerId: 'unknown', confidence: 0 };
  }
}

/**
 * Validate a parser result against NZ electricity norms.
 * Flags impossibly low/high values, unusual patterns, and data-quality issues.
 * DeepSeek NEVER extracts data — it only sanity-checks what Python already extracted.
 */
export async function validateParserResult(
  result: Record<string, unknown>,
  apiKey?: string
): Promise<ValidationResult> {
  if (!apiKey) {
    // Offline validation against known NZ norms
    const warnings: string[] = [];
    const anomalyFlags: string[] = [];

    const kwh = Number(result.usage_kwh ?? 0);
    const cents = Number(result.total_cents ?? 0);
    const cPerKwh = Number(result.c_per_kwh ?? 0);
    const cPerDay = Number(result.c_per_day ?? 0);

    if (kwh < 0 || kwh > 10000) anomalyFlags.push(`usage_kwh ${kwh} outside NZ residential range (0-10000)`);
    if (cents < 0 || cents > 500000) anomalyFlags.push(`total_cents ${cents} outside NZ residential range (0-500000)`);
    if (cPerKwh < 0 || cPerKwh > 80) warnings.push(`c_per_kwh ${cPerKwh} outside typical NZ range (0-80)`);
    if (cPerDay < 0 || cPerDay > 500) warnings.push(`c_per_day ${cPerDay} outside typical NZ range (0-500)`);

    return {
      valid: anomalyFlags.length === 0,
      warnings,
      anomalyFlags,
    };
  }

  try {
    const response = await callDeepSeek(
      `Validate these NZ bill parser results against known norms. Flag anything unusual.\n\n${JSON.stringify(result)}\n\nRespond: {"valid": true/false, "warnings": ["..."], "anomaly_flags": ["..."]}`,
      apiKey
    );
    const parsed = JSON.parse(response) as {
      valid?: boolean;
      warnings?: string[];
      anomaly_flags?: string[];
    };

    return {
      valid: parsed.valid ?? true,
      warnings: parsed.warnings ?? [],
      anomalyFlags: parsed.anomaly_flags ?? [],
    };
  } catch {
    return { valid: true, warnings: [], anomalyFlags: [] };
  }
}

/**
 * Generate a casual, NZ-English summary of a parsed bill for the user.
 * DeepSeek crafts the message — it NEVER calculates any values.
 */
export async function generateBillSummary(
  ctx: BillSummaryContext,
  apiKey?: string
): Promise<string> {
  if (!apiKey) {
    // Offline template
    return `Your ${ctx.retailerName} ${ctx.planName} bill for ${ctx.periodMonth}: $${ctx.totalDollars} for ${ctx.usageKwh} kWh over ${ctx.days} days.`;
  }

  try {
    const response = await callDeepSeek(
      `Write a casual, friendly NZ English summary of this power bill. Be conversational, like a financially-savvy friend. Never hyperbolic or pushy.\n\nRetailer: ${ctx.retailerName}\nPlan: ${ctx.planName}\nMonth: ${ctx.periodMonth}\nUsage: ${ctx.usageKwh} kWh\nTotal: $${ctx.totalDollars} NZD\nDays: ${ctx.days}\n\nOne sentence summary from Flip (a bill monitoring service):`,
      apiKey
    );
    const parsed = JSON.parse(response) as { summary?: string };
    return typeof parsed.summary === 'string'
      ? parsed.summary
      : `Your ${ctx.retailerName} bill for ${ctx.periodMonth}: $${ctx.totalDollars} for ${ctx.usageKwh} kWh.`;
  } catch {
    return `Your ${ctx.retailerName} bill for ${ctx.periodMonth}: $${ctx.totalDollars} for ${ctx.usageKwh} kWh.`;
  }
}
