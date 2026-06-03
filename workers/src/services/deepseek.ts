import type { Intent, IntentClassification } from '../types/conversation';

const DEEPSEEK_API_BASE = 'https://api.deepseek.com/v1';
const FLASH_MODEL = 'deepseek-chat';
const PRO_MODEL = 'deepseek-reasoner';
const FLASH_TIMEOUT_MS = 500;
const PRO_TIMEOUT_MS = 3000;
const LOW_CONFIDENCE_THRESHOLD = 0.85;
const MAX_RETRIES = 3;
const PROMPT_VERSION = '1.0.0';

interface DeepSeekMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

const SYSTEM_PROMPT = `You are Flip, an NZ power bill monitoring assistant. You communicate via WhatsApp and SMS.

Your job is to classify user messages into one of these intents:
- help: User is asking what you can do, or needs assistance
- usage: User wants to know their power usage or bill details
- bill: User has a new bill to share, or mentions their bill
- compare: User wants to compare plans or check if they can save
- switch: User wants to switch plans
- confirm_switch: User confirms they want to switch (yes, go ahead, etc.)
- decline: User declines a suggestion (no, not now, stay, etc.)
- status: User asks about their switch status or account status
- stop: User wants to unsubscribe or stop the service
- unknown: Cannot determine intent

Respond with a JSON object:
{
  "intent": "<intent>",
  "confidence": <0.0-1.0>,
  "entities": {}
}

You are casual, direct, and helpful — like a financially-savvy friend. NZ English.
You NEVER calculate costs, extract bill data, or make switching recommendations.
You NEVER use hyperbolic or pushy language.`;

export async function classifyIntent(
  message: string,
  apiKey: string,
  history?: DeepSeekMessage[]
): Promise<IntentClassification> {
  const start = Date.now();
  const messages: DeepSeekMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(history ?? []),
    { role: 'user', content: message },
  ];

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FLASH_TIMEOUT_MS);

      const response = await fetch(`${DEEPSEEK_API_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: FLASH_MODEL,
          messages,
          temperature: 0,
          max_tokens: 256,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`DeepSeek API error: ${response.status}`);
      }

      const data = await response.json() as {
        choices: Array<{ message: { content: string } }>;
      };
      const content = data.choices[0]?.message?.content ?? '{}';
      const parsed = JSON.parse(content) as {
        intent?: string;
        confidence?: number;
        entities?: Record<string, unknown>;
      };

      const intent = validateIntent(parsed.intent);
      const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
      const latencyMs = Date.now() - start;

      logLLMCall('flash', intent, latencyMs, confidence, PROMPT_VERSION);

      return {
        intent,
        confidence,
        entities: parsed.entities ?? {},
        needsDisambiguation: confidence < LOW_CONFIDENCE_THRESHOLD,
      };
    } catch (err) {
      lastError = err as Error;
      if (attempt < MAX_RETRIES - 1) {
        await sleep(Math.pow(2, attempt) * 100); // exponential backoff
      }
    }
  }

  // After all retries exhausted, log and return unknown
  const latencyMs = Date.now() - start;
  logLLMCall('flash', 'unknown', latencyMs, 0, PROMPT_VERSION);
  console.log(JSON.stringify({
    level: 'error',
    message: 'DeepSeek Flash failed after retries',
    error: lastError?.message,
    timestamp: new Date().toISOString(),
  }));

  return {
    intent: 'unknown',
    confidence: 0,
    entities: {},
    needsDisambiguation: true,
  };
}

// Pro model for complex disambiguation
export async function disambiguate(
  message: string,
  context: { readonly currentState: string; readonly recentMessages: string[] },
  apiKey: string
): Promise<IntentClassification & { readonly clarification?: string }> {
  const start = Date.now();
  const contextStr = `Current state: ${context.currentState}. Recent messages: ${context.recentMessages.join(' | ')}`;

  const messages: DeepSeekMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Context: ${contextStr}\n\nUser message: ${message}\n\nDisambiguate the user's intent. If unclear, include a "clarification" field with a follow-up question.` },
  ];

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PRO_TIMEOUT_MS);

    const response = await fetch(`${DEEPSEEK_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: PRO_MODEL,
        messages,
        temperature: 0.3,
        max_tokens: 512,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`DeepSeek Pro API error: ${response.status}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    const content = data.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(content) as {
      intent?: string;
      confidence?: number;
      entities?: Record<string, unknown>;
      clarification?: string;
    };

    const intent = validateIntent(parsed.intent);
    const latencyMs = Date.now() - start;

    logLLMCall('pro', intent, latencyMs, parsed.confidence ?? 0, PROMPT_VERSION);

    return {
      intent,
      confidence: parsed.confidence ?? 0,
      entities: parsed.entities ?? {},
      needsDisambiguation: false,
      clarification: parsed.clarification,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    logLLMCall('pro', 'unknown', latencyMs, 0, PROMPT_VERSION);
    console.log(JSON.stringify({
      level: 'error',
      message: 'DeepSeek Pro failed',
      error: (err as Error).message,
      timestamp: new Date().toISOString(),
    }));
    return {
      intent: 'unknown',
      confidence: 0,
      entities: {},
      needsDisambiguation: true,
    };
  }
}

// Pure function: validate and normalize intent strings
function validateIntent(raw?: string): Intent {
  const validIntents: Intent[] = [
    'help', 'usage', 'bill', 'compare', 'switch',
    'confirm_switch', 'decline', 'status', 'stop', 'unknown',
  ];
  if (typeof raw !== 'string') return 'unknown';
  const normalized = raw.toLowerCase().trim();
  return validIntents.includes(normalized as Intent) ? (normalized as Intent) : 'unknown';
}

// Audit logging — structured JSON, NO PII, NO full message text
function logLLMCall(
  model: 'flash' | 'pro',
  intent: Intent,
  latencyMs: number,
  confidence: number,
  promptVersion: string
): void {
  console.log(JSON.stringify({
    type: 'llm_call',
    model,
    intent_result: intent,
    latency_ms: latencyMs,
    confidence,
    prompt_version: promptVersion,
    timestamp: new Date().toISOString(),
  }));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
