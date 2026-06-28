import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendText, sendTemplate, downloadMedia, SentAuthError, SentRateLimitError, SentServerError, SentClientError } from './messaging';
import { validateSentSignature } from '../middleware/sentAuth';

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += (bytes[i] as number).toString(16).padStart(2, '0');
  }
  return hex;
}

function mockResponse(status: number, body: Record<string, unknown> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

describe('sendText', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('sends message via Sent API and returns message ID', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { id: 'msg_123', channel: 'whatsapp' }));

    const result = await sendText('test-api-key', '+64211234567', 'Hello!');

    expect(result.messageId).toBe('msg_123');
    expect(result.channel).toBe('whatsapp');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toContain('/messages');
    expect(call[1].headers).toHaveProperty('Authorization', 'Bearer test-api-key');
  });

  it('sends message body and recipient correctly', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { id: 'msg_456', channel: 'sms' }));

    await sendText('key-1', '+64219876543', 'Hello NZ!', 'sms');

    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string) as {
      to: string;
      body: string;
      channel: string;
    };
    expect(body.to).toBe('+64219876543');
    expect(body.body).toBe('Hello NZ!');
    expect(body.channel).toBe('sms');
  });

  it('defaults to no channel if not specified', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { id: 'msg_789', channel: 'whatsapp' }));

    await sendText('key-1', '+64211234567', 'Hello');

    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty('channel');
  });

  it('calls the correct Sent API endpoint', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { id: 'msg_999', channel: 'whatsapp' }));

    await sendText('key-1', '+64211234567', 'Test');

    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('https://api.sent.dm/v1/messages');
  });

  it('throws SentAuthError on 401', async () => {
    mockFetch.mockResolvedValue(mockResponse(401, { error: 'invalid api key' }));

    await expect(sendText('bad-key', '+64211234567', 'hi')).rejects.toBeInstanceOf(SentAuthError);
    await expect(sendText('bad-key', '+64211234567', 'hi')).rejects.toMatchObject({ status: 401 });
  });

  it('throws SentAuthError on 403', async () => {
    mockFetch.mockResolvedValue(mockResponse(403, { error: 'forbidden' }));

    await expect(sendText('key', '+64211234567', 'hi')).rejects.toBeInstanceOf(SentAuthError);
  });

  it('throws SentRateLimitError on 429', async () => {
    mockFetch.mockResolvedValue(mockResponse(429, { error: 'rate limited' }));

    await expect(sendText('key', '+64211234567', 'hi')).rejects.toBeInstanceOf(SentRateLimitError);
    await expect(sendText('key', '+64211234567', 'hi')).rejects.toMatchObject({ status: 429 });
  });

  it('throws SentServerError on 5xx', async () => {
    mockFetch.mockResolvedValue(mockResponse(503, { error: 'unavailable' }));

    await expect(sendText('key', '+64211234567', 'hi')).rejects.toBeInstanceOf(SentServerError);
    await expect(sendText('key', '+64211234567', 'hi')).rejects.toMatchObject({ status: 503 });
  });

  it('throws SentClientError on 4xx other than 401/403/429', async () => {
    mockFetch.mockResolvedValue(mockResponse(400, { error: 'bad request' }));

    await expect(sendText('key', '+64211234567', 'hi')).rejects.toBeInstanceOf(SentClientError);
  });

  it('throws on network error (passes through underlying error)', async () => {
    mockFetch.mockRejectedValue(new Error('Network failure'));

    await expect(sendText('key', '+64211234567', 'hi')).rejects.toThrow('Network failure');
  });

  it('logs structured audit data (no PII)', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { id: 'msg_audit', channel: 'whatsapp' }));

    const spy = vi.spyOn(console, 'log');
    await sendText('key-1', '+64211234567', 'Private message body');

    const logCalls = spy.mock.calls.map((c) => {
      try { return JSON.parse(c[0] as string); } catch { return null; }
    });

    const sentLog = logCalls.find(
      (l): l is Record<string, unknown> => l !== null && (l as Record<string, unknown>).type === 'sent_message'
    );

    expect(sentLog).toBeDefined();
    expect(sentLog!.message_id).toBe('msg_audit');
    expect(sentLog!.channel).toBe('whatsapp');
    expect(JSON.stringify(sentLog!)).not.toContain('+64211234567');
    expect(JSON.stringify(sentLog!)).not.toContain('Private message body');

    spy.mockRestore();
  });
});

describe('sendTemplate', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('sends template message with variables', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { id: 'msg_456', channel: 'whatsapp' }));

    const result = await sendTemplate('test-api-key', '+64211234567', 'bill_received', {
      '1': 'Contact Energy',
      '2': '847',
      '3': '31',
      '4': '$212',
    });

    expect(result.messageId).toBe('msg_456');
  });

  it('calls the correct Sent template endpoint', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { id: 'tmpl_1', channel: 'whatsapp' }));

    await sendTemplate('key-1', '+64211234567', 'welcome', { '1': 'Flip' });

    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('https://api.sent.dm/v1/messages/template');
  });

  it('sends template name and variables in body', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { id: 'tmpl_2', channel: 'sms' }));

    await sendTemplate('key-1', '+64211234567', 'bill_alert', {
      '1': 'Genesis',
      '2': '$45',
      '3': '3 months',
    });

    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string) as {
      to: string;
      template_name: string;
      variables: Record<string, string>;
    };
    expect(body.to).toBe('+64211234567');
    expect(body.template_name).toBe('bill_alert');
    expect(body.variables).toEqual({ '1': 'Genesis', '2': '$45', '3': '3 months' });
  });

  it('throws SentClientError on 404 template-not-found', async () => {
    mockFetch.mockResolvedValue(mockResponse(404, { error: 'Template not found' }));

    await expect(
      sendTemplate('key-1', '+64211234567', 'nonexistent', {})
    ).rejects.toBeInstanceOf(SentClientError);
  });

  it('throws SentRateLimitError on 429', async () => {
    mockFetch.mockResolvedValue(mockResponse(429, { error: 'rate limited' }));

    await expect(
      sendTemplate('key-1', '+64211234567', 'bill_received', { '1': 'X' })
    ).rejects.toBeInstanceOf(SentRateLimitError);
  });

  it('logs template audit data without PII', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { id: 'tmpl_audit', channel: 'whatsapp' }));

    const spy = vi.spyOn(console, 'log');
    await sendTemplate('key-1', '+64211234567', 'bill_received', { '1': 'Contact' });

    const logCalls = spy.mock.calls.map((c) => {
      try { return JSON.parse(c[0] as string); } catch { return null; }
    });

    const log = logCalls.find(
      (l): l is Record<string, unknown> => l !== null && (l as Record<string, unknown>).type === 'sent_template'
    );

    expect(log).toBeDefined();
    expect(log!.template).toBe('bill_received');
    expect(log!.message_id).toBe('tmpl_audit');

    spy.mockRestore();
  });
});

describe('validateSentSignature', () => {
  it('validates a correct HMAC-SHA256 signature', async () => {
    const secret = 'test-secret';
    const body = 'test body';
    const ts = '1700000000';

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sigBytes = await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(`${ts}.${body}`)
    );
    const signature = bytesToHex(new Uint8Array(sigBytes));

    const valid = await validateSentSignature(body, signature, secret, ts);
    expect(valid).toBe(true);
  });

  it('rejects an incorrect signature', async () => {
    const valid = await validateSentSignature(
      'test body',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'test-secret',
      '1700000000'
    );
    expect(valid).toBe(false);
  });

  it('rejects signature for empty body', async () => {
    const valid = await validateSentSignature(
      '',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'test-secret',
      '1700000000'
    );
    expect(valid).toBe(false);
  });

  it('rejects signature with different secret', async () => {
    const body = 'test body';
    const ts = '1700000000';

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode('wrong-secret'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sigBytes = await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(`${ts}.${body}`)
    );
    const signature = bytesToHex(new Uint8Array(sigBytes));

    const valid = await validateSentSignature(body, signature, 'test-secret', ts);
    expect(valid).toBe(false);
  });
});

describe('downloadMedia', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('downloads media and returns ArrayBuffer', async () => {
    const mockBuffer = new ArrayBuffer(8);
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => mockBuffer,
    } as unknown as Response);

    const result = await downloadMedia('test-api-key', 'https://cdn.sent.dm/media/bill.pdf');

    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(result.byteLength).toBe(8);
  });

  it('uses Authorization header for media download', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(4),
    } as unknown as Response);

    await downloadMedia('test-api-key', 'https://cdn.sent.dm/media/bill.pdf');

    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(call[1].headers).toHaveProperty('Authorization', 'Bearer test-api-key');
  });

  it('throws SentAuthError on 403 expired media', async () => {
    mockFetch.mockResolvedValue(mockResponse(403, { error: 'expired' }));

    await expect(
      downloadMedia('test-api-key', 'https://cdn.sent.dm/media/expired.pdf')
    ).rejects.toBeInstanceOf(SentAuthError);
  });
});