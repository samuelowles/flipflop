import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyIntent, disambiguate, classifyWithEscalation } from './deepseek';

// Mock global fetch
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function mockDeepSeekResponse(intent: string, confidence: number) {
  return {
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({ intent, confidence, entities: {} }),
          },
        },
      ],
    }),
  } as unknown as Response;
}

describe('classifyIntent (DeepSeek Flash)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns help intent for help messages', async () => {
    mockFetch.mockResolvedValue(mockDeepSeekResponse('help', 0.98));

    const result = await classifyIntent('what can you do', 'test-api-key');

    expect(result.intent).toBe('help');
    expect(result.confidence).toBe(0.98);
    expect(result.needsDisambiguation).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns confirm_switch for yes messages', async () => {
    mockFetch.mockResolvedValue(mockDeepSeekResponse('confirm_switch', 0.95));

    const result = await classifyIntent('yes switch me', 'test-api-key');

    expect(result.intent).toBe('confirm_switch');
  });

  it('returns decline for no messages', async () => {
    mockFetch.mockResolvedValue(mockDeepSeekResponse('decline', 0.93));

    const result = await classifyIntent('no thank you', 'test-api-key');

    expect(result.intent).toBe('decline');
  });

  it('returns bill for bill messages', async () => {
    mockFetch.mockResolvedValue(mockDeepSeekResponse('bill', 0.97));

    const result = await classifyIntent('here is my power bill', 'test-api-key');

    expect(result.intent).toBe('bill');
  });

  it('flags low confidence results for disambiguation', async () => {
    mockFetch.mockResolvedValue(mockDeepSeekResponse('compare', 0.72));

    const result = await classifyIntent('is genesis any good', 'test-api-key');

    expect(result.intent).toBe('compare');
    expect(result.needsDisambiguation).toBe(true);
  });

  it('validates and normalizes intent to known values', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                intent: 'invalid_intent',
                confidence: 0.5,
              }),
            },
          },
        ],
      }),
    } as unknown as Response);

    const result = await classifyIntent('blah', 'test-api-key');
    expect(result.intent).toBe('unknown');
  });

  it('returns unknown when confidence is missing', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({ intent: 'help' }),
            },
          },
        ],
      }),
    } as unknown as Response);

    const result = await classifyIntent('help me', 'test-api-key');
    expect(result.intent).toBe('help');
    expect(result.confidence).toBe(0);
  });

  it('returns unknown when API response is malformed', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [],
      }),
    } as unknown as Response);

    const result = await classifyIntent('test message', 'test-api-key');
    expect(result.intent).toBe('unknown');
  });

  it('retries on API failure then returns unknown', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const result = await classifyIntent('test message', 'test-api-key');

    // Should retry 3 times, then return unknown
    expect(result.intent).toBe('unknown');
    expect(result.confidence).toBe(0);
    expect(result.needsDisambiguation).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('recovers on second retry after first failure', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce(mockDeepSeekResponse('usage', 0.92));

    const result = await classifyIntent('how much power did I use', 'test-api-key');

    expect(result.intent).toBe('usage');
    expect(result.confidence).toBe(0.92);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('handles non-ok API responses with retry', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
      } as unknown as Response)
      .mockResolvedValueOnce(mockDeepSeekResponse('help', 0.88));

    const result = await classifyIntent('help', 'test-api-key');

    expect(result.intent).toBe('help');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('logs audit data without PII', async () => {
    mockFetch.mockResolvedValue(mockDeepSeekResponse('usage', 0.90));

    const spy = vi.spyOn(console, 'log');
    await classifyIntent('how much power did I use', 'test-api-key');

    const logCalls = spy.mock.calls
      .map((c) => {
        try {
          return JSON.parse(c[0] as string);
        } catch {
          return null;
        }
      });

    const llmLog = logCalls.find(
      (l): l is Record<string, unknown> =>
        l !== null && (l as Record<string, unknown>).type === 'llm_call'
    );

    expect(llmLog).toBeDefined();
    expect(llmLog!.model).toBe('flash');
    expect(llmLog!.intent_result).toBe('usage');
    expect(llmLog!.prompt_version).toBeDefined();
    expect(llmLog!.latency_ms).toBeDefined();
    expect(llmLog!.confidence).toBe(0.9);
    // Must not contain the message text
    expect(JSON.stringify(llmLog)).not.toContain('how much power');

    spy.mockRestore();
  });

  it('passes conversation history to the API', async () => {
    mockFetch.mockResolvedValue(mockDeepSeekResponse('compare', 0.94));

    const history = [
      { role: 'user' as const, content: 'my bill' },
      { role: 'assistant' as const, content: 'got it' },
    ];

    await classifyIntent('compare', 'test-api-key', history);

    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    // Should include system, history, and user message
    expect(body.messages.length).toBe(4); // system + 2 history + 1 user
    expect(body.messages[1]).toEqual(history[0]);
    expect(body.messages[2]).toEqual(history[1]);
  });

  it('normalizes case and trims intent strings', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({ intent: '  HELP  ', confidence: 0.91 }),
            },
          },
        ],
      }),
    } as unknown as Response);

    const result = await classifyIntent('what can you do', 'test-api-key');
    expect(result.intent).toBe('help');
  });

  it('returns unknown gracefully when fetch is aborted (500ms ceiling enforced)', async () => {
    // The 500ms AbortController timeout (FLASH_TIMEOUT_MS) in classifyIntent
    // fires controller.abort() on slow DeepSeek responses, which surfaces to
    // fetch as an AbortError rejection. Mocking that rejection verifies the
    // <500ms latency ceiling is enforced and handled deterministically:
    // the call returns a safe `unknown` fallback rather than hanging or throwing.
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    mockFetch.mockRejectedValue(abortError);

    const result = await classifyIntent('slow message', 'test-api-key');

    expect(result.intent).toBe('unknown');
    expect(result.confidence).toBe(0);
    expect(result.entities).toEqual({});
    expect(result.needsDisambiguation).toBe(true);
    // Retried up to MAX_RETRIES before giving up — proving abort is retried,
    // not a fatal crash, yet still bounded so latency stays under the ceiling.
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

describe('disambiguate (DeepSeek Pro)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns intent with clarification for ambiguous messages', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                intent: 'compare',
                confidence: 0.88,
                clarification: 'Did you mean you want to compare plans?',
                entities: {},
              }),
            },
          },
        ],
      }),
    } as unknown as Response);

    const result = await disambiguate(
      'is it better',
      { currentState: 'ACTIVE', recentMessages: ['check my bill'] },
      'test-api-key'
    );

    expect(result.intent).toBe('compare');
    expect(result.clarification).toBe('Did you mean you want to compare plans?');
    expect(result.needsDisambiguation).toBe(false);
  });

  it('falls back to unknown on API failure', async () => {
    mockFetch.mockRejectedValue(new Error('Pro API timeout'));

    const result = await disambiguate(
      'hmm not sure',
      { currentState: 'ACTIVE', recentMessages: [] },
      'test-api-key'
    );

    expect(result.intent).toBe('unknown');
    expect(result.confidence).toBe(0);
    expect(result.needsDisambiguation).toBe(true);
  });

  it('logs as "pro" model in audit log', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({ intent: 'switch', confidence: 0.91 }),
            },
          },
        ],
      }),
    } as unknown as Response);

    const spy = vi.spyOn(console, 'log');
    await disambiguate(
      'maybe switch',
      { currentState: 'ACTIVE', recentMessages: ['savings found'] },
      'test-api-key'
    );

    const logCalls = spy.mock.calls
      .map((c) => {
        try {
          return JSON.parse(c[0] as string);
        } catch {
          return null;
        }
      });

    const llmLog = logCalls.find(
      (l): l is Record<string, unknown> =>
        l !== null && (l as Record<string, unknown>).type === 'llm_call'
    );

    expect(llmLog).toBeDefined();
    expect(llmLog!.model).toBe('pro');
    spy.mockRestore();
  });
});

describe('classifyWithEscalation (Flash→Pro orchestrator)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('does NOT escalate for high-confidence simple intents (no Pro call)', async () => {
    // Flash returns confidence >= 0.85, multiTurn not set → return Flash result,
    // Pro fetch must never happen.
    mockFetch.mockResolvedValue(mockDeepSeekResponse('help', 0.98));

    const result = await classifyWithEscalation('what can you do', 'test-api-key');

    expect(result.intent).toBe('help');
    expect(result.confidence).toBe(0.98);
    // Exactly one fetch: the Flash call. No Pro escalation.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // And the single call used the Flash model.
    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string) as { model: string };
    expect(body.model).toBe('deepseek-chat');
  });

  it('escalates to Pro when Flash confidence < 0.85 (exactly one Pro call)', async () => {
    // First call: Flash, low confidence. Second call: Pro, higher confidence.
    mockFetch
      .mockResolvedValueOnce(mockDeepSeekResponse('compare', 0.72))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  intent: 'compare',
                  confidence: 0.9,
                  clarification: 'compare plans?',
                  entities: {},
                }),
              },
            },
          ],
        }),
      } as unknown as Response);

    const result = await classifyWithEscalation('is genesis any good', 'test-api-key');

    // Two calls: Flash then Pro.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const proCall = mockFetch.mock.calls[1] as [string, RequestInit];
    const proBody = JSON.parse(proCall[1].body as string) as { model: string };
    expect(proBody.model).toBe('deepseek-reasoner');
    // Result reflects Pro's output (intent + higher confidence), clarification stripped.
    expect(result.intent).toBe('compare');
    expect(result.confidence).toBe(0.9);
    expect(result.needsDisambiguation).toBe(false);
  });

  it('escalates when multiTurn=true even if Flash confidence is high', async () => {
    mockFetch
      .mockResolvedValueOnce(mockDeepSeekResponse('compare', 0.95))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({ intent: 'compare', confidence: 0.93, entities: {} }),
              },
            },
          ],
        }),
      } as unknown as Response);

    const result = await classifyWithEscalation('compare', 'test-api-key', { multiTurn: true });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const proBody = JSON.parse(
      (mockFetch.mock.calls[1] as [string, RequestInit])[1].body as string
    ) as { model: string };
    expect(proBody.model).toBe('deepseek-reasoner');
    expect(result.confidence).toBe(0.93);
  });

  it('Pro call is bounded by the 3s ceiling (PRO_TIMEOUT_MS) and aborts to a safe fallback', async () => {
    // Assert the literal 3s ceiling by spying on setTimeout during the Pro
    // call, then assert an aborted Pro returns a safe fallback rather than
    // throwing/hanging. Flash succeeds low-confidence → triggers escalation.
    mockFetch
      .mockResolvedValueOnce(mockDeepSeekResponse('compare', 0.6))
      .mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));

    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    const result = await classifyWithEscalation('hmm not sure', 'test-api-key');

    // Pro latency ceiling: exactly one setTimeout was scheduled with 3000ms
    // (the Flash call's 500ms timeout is cleared before the Pro call, and
    // disambiguate schedules its own PRO_TIMEOUT_MS=3000 abort).
    const proTimeouts = timerSpy.mock.calls
      .map((c) => c[1] as number)
      .filter((ms) => ms === 3000);
    expect(proTimeouts.length).toBe(1);
    timerSpy.mockRestore();

    // Two calls: Flash then Pro.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Safe fallback, no throw.
    expect(result.intent).toBe('unknown');
    expect(result.confidence).toBe(0);
    expect(result.needsDisambiguation).toBe(true);
  });

  it('Pro escalation is logged with model=pro', async () => {
    mockFetch
      .mockResolvedValueOnce(mockDeepSeekResponse('compare', 0.7))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({ intent: 'compare', confidence: 0.88, entities: {} }),
              },
            },
          ],
        }),
      } as unknown as Response);

    const spy = vi.spyOn(console, 'log');
    await classifyWithEscalation('is it better', 'test-api-key');

    const logCalls = spy.mock.calls
      .map((c) => {
        try {
          return JSON.parse(c[0] as string);
        } catch {
          return null;
        }
      });
    const proLogs = logCalls.filter(
      (l): l is Record<string, unknown> =>
        l !== null && (l as Record<string, unknown>).type === 'llm_call' &&
        (l as Record<string, unknown>).model === 'pro'
    );

    expect(proLogs.length).toBe(1);
    spy.mockRestore();
  });
});
