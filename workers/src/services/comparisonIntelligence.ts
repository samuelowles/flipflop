/**
 * Comparison intelligence — DeepSeek-powered explanation of plan comparisons.
 *
 * DeepSeek turns ranked comparison results into conversational explanations.
 * It NEVER calculates costs, makes switching decisions, or extracts bill data.
 * All dollar values come from Python's deterministic pricing engine.
 */

interface ComparisonExplanationContext {
  readonly bestPlanName: string;
  readonly bestRetailerName: string;
  readonly savingDollarsPerYear: number; // rounded to nearest dollar
  readonly currentPlanName: string;
  readonly currentAnnualCostDollars: number;
  readonly stayWhereYouAre: boolean;
  readonly runnerUpPlanName?: string;
  readonly runnerUpSavingDollars?: number;
  readonly confidence: number;
  readonly billCount: number;
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
            content: 'You are Flip, a NZ power bill monitoring service. You communicate via WhatsApp/SMS in casual, friendly NZ English. You NEVER calculate costs, make switching decisions, or use hyperbolic language. "Stay where you are" is a first-class, celebrated outcome. All dollar values are provided to you. Respond with JSON only.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.4,
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
 * Generate a natural-language explanation of comparison results.
 * Explains which plan is cheapest, by how much, and any caveats.
 */
export async function explainComparison(
  ctx: ComparisonExplanationContext,
  apiKey?: string
): Promise<string> {
  if (!apiKey) {
    if (ctx.stayWhereYouAre) {
      return `Good news — you're already on the best plan for your usage. Your current plan (${ctx.currentPlanName}) would cost about $${ctx.currentAnnualCostDollars}/year. The closest alternative would be about the same.`;
    }
    return `Based on your last ${ctx.billCount} bills, you could save about $${ctx.savingDollarsPerYear}/year by switching to ${ctx.bestRetailerName}'s ${ctx.bestPlanName} plan. This is an estimate, not a guarantee.`;
  }

  try {
    const response = await callDeepSeek(
      `Turn this NZ plan comparison into a casual, friendly WhatsApp/SMS message. NZ English. If staying put is best, celebrate it. If there's a saving, present it calmly — never pushy. Always qualify with "based on your last N bills, this is an estimate."\n\nContext: ${JSON.stringify(ctx)}\n\nMessage (1-2 sentences):`,
      apiKey
    );
    const parsed = JSON.parse(response) as { message?: string };
    return typeof parsed.message === 'string' ? parsed.message : buildFallbackMessage(ctx);
  } catch {
    return buildFallbackMessage(ctx);
  }
}

function buildFallbackMessage(ctx: ComparisonExplanationContext): string {
  if (ctx.stayWhereYouAre) {
    return `Good news — you're already on the best plan for your usage. Based on your last ${ctx.billCount} bills, your current plan is the most cost-effective option.`;
  }
  return `Based on your last ${ctx.billCount} bills, you could save about $${ctx.savingDollarsPerYear}/year by switching to ${ctx.bestRetailerName}'s ${ctx.bestPlanName} plan. This is an estimate, not a guarantee.`;
}

/**
 * Generate a "stay where you are" message.
 * Celebrates that the user is already on the best plan.
 */
export async function generateStayPutMessage(
  ctx: ComparisonExplanationContext,
  apiKey?: string
): Promise<string> {
  if (!apiKey) {
    return `Good news — you're already on the best plan for your usage. Sticking with ${ctx.currentPlanName} is the smart choice. I'll keep watching and let you know if anything changes.`;
  }

  try {
    const response = await callDeepSeek(
      `Write a "stay where you are" WhatsApp/SMS message. The user is ALREADY on the best plan — celebrate this. NZ English, casual, friendly. Do NOT suggest switching or comparing further.\n\nContext: ${JSON.stringify(ctx)}\n\nMessage:`,
      apiKey
    );
    const parsed = JSON.parse(response) as { message?: string };
    return typeof parsed.message === 'string'
      ? parsed.message
      : `Good news — you're already on the best plan. I'll keep watching for changes.`;
  } catch {
    return `Good news — you're already on the best plan. I'll keep watching for changes.`;
  }
}

/**
 * Generate a savings alert message.
 * Calmly presents the saving opportunity without being pushy.
 */
export async function generateSavingMessage(
  ctx: ComparisonExplanationContext,
  apiKey?: string
): Promise<string> {
  if (!apiKey) {
    return `You could save about $${ctx.savingDollarsPerYear}/year by switching to ${ctx.bestRetailerName}'s ${ctx.bestPlanName} plan. Based on your last ${ctx.billCount} bills. Want me to look into switching?`;
  }

  try {
    const response = await callDeepSeek(
      `Write a savings alert WhatsApp/SMS message. Present the saving calmly — never pushy or hyperbolic. Always say "you could save about $X" not "you're wasting $X". Always qualify as an estimate. End by asking if they'd like to explore switching.\n\nContext: ${JSON.stringify(ctx)}\n\nMessage:`,
      apiKey
    );
    const parsed = JSON.parse(response) as { message?: string };
    return typeof parsed.message === 'string'
      ? parsed.message
      : `You could save about $${ctx.savingDollarsPerYear}/year by switching to ${ctx.bestRetailerName}'s ${ctx.bestPlanName} plan. Based on your last ${ctx.billCount} bills. Want me to look into switching?`;
  } catch {
    return `You could save about $${ctx.savingDollarsPerYear}/year by switching to ${ctx.bestRetailerName}'s ${ctx.bestPlanName} plan. Based on your last ${ctx.billCount} bills. Want me to look into switching?`;
  }
}
