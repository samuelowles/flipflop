import type { Intent, IntentClassification } from '../types/conversation';
import {
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  INTENT_CLASSIFICATION_PROMPT,
  ENTITY_EXTRACTION_PROMPT,
} from './prompts';

const DEEPSEEK_API_BASE = 'https://api.deepseek.com/v1';
const FLASH_MODEL = 'deepseek-chat';
const PRO_MODEL = 'deepseek-reasoner';
const FLASH_TIMEOUT_MS = 500;
const PRO_TIMEOUT_MS = 3000;
const LOW_CONFIDENCE_THRESHOLD = 0.85;
const MAX_RETRIES = 3;

interface DeepSeekMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/** Combined system prompt: shared persona + intent classification instructions. */
const CLASSIFY_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

${INTENT_CLASSIFICATION_PROMPT}`;

/** Combined system prompt: shared persona + entity extraction/disambiguation. */
const DISAMBIGUATE_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

${ENTITY_EXTRACTION_PROMPT}`;

export async function classifyIntent(
  message: string,
  apiKey: string,
  history?: DeepSeekMessage[]
): Promise<IntentClassification> {
  const start = Date.now();
  const messages: DeepSeekMessage[] = [
    { role: 'system', content: CLASSIFY_SYSTEM_PROMPT },
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

/**
 * Orchestrates Flash→Pro escalation. Runs the cheap Flash classification,
 * then escalates to Pro only when confidence is low or multi-turn context
 * is required. High-confidence simple intents skip Pro entirely.
 *
 * Escalation triggers (per #34):
 *  - Flash confidence < LOW_CONFIDENCE_THRESHOLD (0.85)
 *  - multi-turn conversation (options.multiTurn === true)
 *  - notification content generation — deferred to Epic 8
 *    (ponytail: that trigger will call disambiguate directly or extend
 *    shouldEscalate with a `notificationContent: true` flag).
 */
export async function classifyWithEscalation(
  message: string,
  apiKey: string,
  options?: { readonly multiTurn?: boolean; readonly history?: DeepSeekMessage[] }
): Promise<IntentClassification> {
  const flash = await classifyIntent(message, apiKey, options?.history);

  if (!shouldEscalate(flash, options?.multiTurn ?? false)) {
    return flash;
  }

  const recentMessages = (options?.history ?? [])
    .filter((m) => m.role === 'user')
    .map((m) => m.content);
  const pro = await disambiguate(
    message,
    { currentState: 'AWAITING_INPUT', recentMessages },
    apiKey
  );
  // Disambiguate returns clarification optionally; strip it to match the
  // IntentClassification shape callers of classify expect.
  const { clarification: _clarification, ...classification } = pro;
  return classification;
}

/** Pure escalation gate — extracted so Epic 8 can extend it (notification trigger). */
function shouldEscalate(
  flash: IntentClassification,
  multiTurn: boolean
): boolean {
  return flash.confidence < LOW_CONFIDENCE_THRESHOLD || multiTurn;
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
    { role: 'system', content: DISAMBIGUATE_SYSTEM_PROMPT },
    { role: 'user', content: `Context: ${contextStr}\n\nUser message: ${message}\n\n${ENTITY_EXTRACTION_PROMPT}` },
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
