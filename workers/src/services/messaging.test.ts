import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendMessage, sendTemplate, downloadMedia } from './messaging';
import { validateSentSignature } from '../middleware/sentAuth';

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

describe('sendMessage', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('sends message via Sent API and returns message ID', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'msg_123', channel: 'whatsapp' }),
    } as unknown as Response);

    const result = await sendMessage('test-api-key', '+64211234567', 'Hello!');

    expect(result.messageId).toBe('msg_123');
    expect(result.channel).toBe('whatsapp');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toContain('/messages');
    expect(call[1].headers).toHaveProperty(
      'Authorization',
      'Bearer test-api-key'
    );
  });

  it('sends message body and recipient correctly', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'msg_456', channel: 'sms' }),
    } as unknown as Response);

    await sendMessage('key-1', '+64219876543', 'Hello NZ!', 'sms');

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
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'msg_789', channel: 'whatsapp' }),
    } as unknown as Response);

    await sendMessage('key-1', '+64211234567', 'Hello');

    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty('channel');
  });

  it('calls the correct Sent API endpoint', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'msg_999', channel: 'whatsapp' }),
    } as unknown as Response);

    await sendMessage('key-1', '+64211234567', 'Test');

    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('https://api.sent.dm/v1/messages');
  });

  it('throws on API error with status code in message', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'Bad request',
    } as unknown as Response);

    await expect(
      sendMessage('test-api-key', '+64211234567', 'Hello!')
    ).rejects.toThrow('Sent API error (400): Bad request');
  });

  it('throws on network error', async () => {
    mockFetch.mockRejectedValue(new Error('Network failure'));

    await expect(
      sendMessage('test-api-key', '+64211234567', 'Hello!')
    ).rejects.toThrow('Network failure');
  });

  it('logs structured audit data (no PII)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'msg_audit', channel: 'whatsapp' }),
    } as unknown as Response);

    const spy = vi.spyOn(console, 'log');
    await sendMessage('key-1', '+64211234567', 'Private message body');

    const logCalls = spy.mock.calls
      .map((c) => {
        try {
          return JSON.parse(c[0] as string);
        } catch {
          return null;
        }
      });

    const sentLog = logCalls.find(
      (l): l is Record<string, unknown> =>
        l !== null && (l as Record<string, unknown>).type === 'sent_message'
    );

    expect(sentLog).toBeDefined();
    expect(sentLog!.message_id).toBe('msg_audit');
    expect(sentLog!.channel).toBe('whatsapp');
    // Must NOT log phone or body
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
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'msg_456', channel: 'whatsapp' }),
    } as unknown as Response);

    const result = await sendTemplate('test-api-key', '+64211234567', 'bill_received', {
      '1': 'Contact Energy',
      '2': '847',
      '3': '31',
      '4': '$212',
    });

    expect(result.messageId).toBe('msg_456');
  });

  it('calls the correct Sent template endpoint', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'tmpl_1', channel: 'whatsapp' }),
    } as unknown as Response);

    await sendTemplate('key-1', '+64211234567', 'welcome', { '1': 'Flip' });

    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('https://api.sent.dm/v1/messages/template');
  });

  it('sends template name and variables in body', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'tmpl_2', channel: 'sms' }),
    } as unknown as Response);

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

  it('throws on template API error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'Template not found',
    } as unknown as Response);

    await expect(
      sendTemplate('key-1', '+64211234567', 'nonexistent', {})
    ).rejects.toThrow('Sent template API error (404): Template not found');
  });

  it('logs template audit data without PII', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'tmpl_audit', channel: 'whatsapp' }),
    } as unknown as Response);

    const spy = vi.spyOn(console, 'log');
    await sendTemplate('key-1', '+64211234567', 'bill_received', { '1': 'Contact' });

    const logCalls = spy.mock.calls
      .map((c) => {
        try {
          return JSON.parse(c[0] as string);
        } catch {
          return null;
        }
      });

    const log = logCalls.find(
      (l): l is Record<string, unknown> =>
        l !== null && (l as Record<string, unknown>).type === 'sent_template'
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

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sigBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
    const signature = btoa(String.fromCharCode(...new Uint8Array(sigBytes)));

    const valid = await validateSentSignature(body, signature, secret);
    expect(valid).toBe(true);
  });

  it('rejects an incorrect signature', async () => {
    const valid = await validateSentSignature(
      'test body',
      'wrongsignature==',
      'test-secret'
    );
    expect(valid).toBe(false);
  });

  it('rejects signature for empty body', async () => {
    const valid = await validateSentSignature(
      '',
      'anysig==',
      'test-secret'
    );
    expect(valid).toBe(false);
  });

  it('rejects signature with different secret', async () => {
    const body = 'test body';

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode('wrong-secret'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sigBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
    const signature = btoa(String.fromCharCode(...new Uint8Array(sigBytes)));

    const valid = await validateSentSignature(body, signature, 'test-secret');
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

    const result = await downloadMedia(
      'test-api-key',
      'https://cdn.sent.dm/media/bill.pdf'
    );

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
    expect(call[1].headers).toHaveProperty(
      'Authorization',
      'Bearer test-api-key'
    );
  });

  it('throws on media download error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
    } as unknown as Response);

    await expect(
      downloadMedia('test-api-key', 'https://cdn.sent.dm/media/expired.pdf')
    ).rejects.toThrow('Sent media download error (403)');
  });
});
