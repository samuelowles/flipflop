/**
 * Usage intelligence — DeepSeek-powered usage trend analysis and insights.
 *
 * DeepSeek analyzes usage patterns, detects seasonal trends, and generates
 * conversational insights. It NEVER calculates costs or extracts bill data.
 * All numerical values come from the deterministic usageTracker service.
 */

interface UsageInsights {
  readonly trendDirection: 'up' | 'down' | 'stable';
  readonly trendDescription: string;
  readonly seasonalPattern: string;
  readonly anomalyNotes: readonly string[];
  readonly efficiencyTips: readonly string[];
}

interface UsageContext {
  readonly avgDailyKwh: number;
  readonly avgMonthlyCostDollars: number;
  readonly monthCount: number;
  readonly seasonalDiff: number; // positive = winter higher
  readonly yoyKwhChangePct: number | null;
  readonly yoyCostChangePct: number | null;
  readonly anomalyCount: number;
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
            content: 'You are a NZ energy analyst. You ONLY provide usage insights — never calculate costs, recommend switching, or extract bill data. Respond with JSON only.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 384,
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

/**
 * Analyze usage trends across a user's bill history.
 * Takes computed metrics from usageTracker and adds contextual analysis.
 */
export async function analyzeUsageTrends(
  ctx: UsageContext,
  apiKey?: string
): Promise<UsageInsights> {
  if (!apiKey) {
    // Deterministic fallback analysis
    const trendDirection: 'up' | 'down' | 'stable' =
      ctx.yoyKwhChangePct !== null
        ? ctx.yoyKwhChangePct > 10 ? 'up' : ctx.yoyKwhChangePct < -10 ? 'down' : 'stable'
        : 'stable';

    const trendDescription = ctx.yoyKwhChangePct !== null
      ? `Your usage is ${trendDirection} about ${Math.abs(ctx.yoyKwhChangePct)}% compared to last year.`
      : `Based on ${ctx.monthCount} months of data, you use about ${Math.round(ctx.avgDailyKwh)} kWh per day on average.`;

    const seasonalPattern = ctx.seasonalDiff > 0
      ? `Winter usage is about ${Math.round(ctx.seasonalDiff)} kWh/day higher than summer.`
      : `Your usage is fairly consistent across seasons.`;

    const efficiencyTips: string[] = [];
    if (ctx.avgDailyKwh > 30) {
      efficiencyTips.push('Your daily usage is above the NZ average of ~22 kWh/day. Check hot water and heating.');
    }

    return {
      trendDirection,
      trendDescription,
      seasonalPattern,
      anomalyNotes: ctx.anomalyCount > 0
        ? [`${ctx.anomalyCount} unusual bill${ctx.anomalyCount > 1 ? 's' : ''} detected.`]
        : [],
      efficiencyTips,
    };
  }

  try {
    const response = await callDeepSeek(
      `Analyze this NZ household's power usage and provide insights. Be conversational, NZ English, like a financially-savvy friend. Never hyperbolic.\n\n${JSON.stringify(ctx)}\n\nRespond: {"trend_direction": "up/down/stable", "trend_description": "...", "seasonal_pattern": "...", "anomaly_notes": ["..."], "efficiency_tips": ["..."]}`,
      apiKey
    );
    const parsed = JSON.parse(response) as {
      trend_direction?: string;
      trend_description?: string;
      seasonal_pattern?: string;
      anomaly_notes?: string[];
      efficiency_tips?: string[];
    };

    return {
      trendDirection: (parsed.trend_direction as 'up' | 'down' | 'stable') ?? 'stable',
      trendDescription: parsed.trend_description ?? `Based on ${ctx.monthCount} months of data.`,
      seasonalPattern: parsed.seasonal_pattern ?? 'No seasonal data available yet.',
      anomalyNotes: parsed.anomaly_notes ?? [],
      efficiencyTips: parsed.efficiency_tips ?? [],
    };
  } catch {
    return {
      trendDirection: 'stable',
      trendDescription: 'Not enough data to analyze trends yet.',
      seasonalPattern: '',
      anomalyNotes: [],
      efficiencyTips: [],
    };
  }
}

/**
 * Generate a conversational usage insight message for the user.
 * Uses trend analysis to create a natural, non-pushy update.
 */
export async function generateUsageInsight(
  ctx: UsageContext,
  apiKey?: string
): Promise<string> {
  if (!apiKey) {
    const parts: string[] = [];
    parts.push(`Based on ${ctx.monthCount} bills, you use about ${Math.round(ctx.avgDailyKwh)} kWh per day.`);

    if (ctx.yoyKwhChangePct !== null) {
      const dir = ctx.yoyKwhChangePct > 0 ? 'up' : 'down';
      parts.push(`That's ${dir} ${Math.abs(ctx.yoyKwhChangePct)}% compared to last year.`);
    }

    if (ctx.seasonalDiff > 1) {
      parts.push(`Winter tends to be higher by about ${Math.round(ctx.seasonalDiff)} kWh/day.`);
    }

    return parts.join(' ');
  }

  try {
    const response = await callDeepSeek(
      `Write a casual, friendly NZ English usage update message. Be conversational, like a financially-savvy friend. Never hyperbolic or pushy. Do NOT suggest switching plans.\n\nContext: ${JSON.stringify(ctx)}\n\nOne or two sentences:`,
      apiKey
    );
    const parsed = JSON.parse(response) as { message?: string };
    return typeof parsed.message === 'string'
      ? parsed.message
      : `Based on ${ctx.monthCount} bills, you use about ${Math.round(ctx.avgDailyKwh)} kWh per day.`;
  } catch {
    return `Based on ${ctx.monthCount} bills, you use about ${Math.round(ctx.avgDailyKwh)} kWh per day.`;
  }
}
