import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildAuthUrl,
  parseOAuthState,
  exchangeCodeForTokens,
  refreshAccessToken,
  revokeAccess,
  searchMessages,
  getMessage,
  downloadAttachment,
} from './gmailAuth';

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

describe('buildAuthUrl', () => {
  it('builds a valid Google OAuth URL with required params', () => {
    const url = buildAuthUrl({
      clientId: 'test-client-id',
      redirectUri: 'https://flip.example.com/auth/gmail/callback',
      state: { userId: 'user-1', phone: '+64211234567', nonce: 'nonce-abc' },
    });

    expect(url).toContain('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url).toContain('client_id=test-client-id');
    expect(url).toContain('response_type=code');
    expect(url).toContain('scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.readonly');
    expect(url).toContain('access_type=offline');
    expect(url).toContain('prompt=consent');
  });

  it('includes base64url-encoded state parameter', () => {
    const url = buildAuthUrl({
      clientId: 'test-client-id',
      redirectUri: 'http://localhost:8787/auth/gmail/callback',
      state: { userId: 'user-1', phone: '+64211234567', nonce: 'nonce-abc' },
    });

    expect(url).toContain('state=');
    // The state should contain userId and nonce when decoded
    const stateParam = new URL(url).searchParams.get('state');
    expect(stateParam).not.toBeNull();
    // base64url-encoded JSON should decode back
    const decoded = atob(
      stateParam!.replace(/-/g, '+').replace(/_/g, '/')
    );
    const parsed = JSON.parse(decoded) as { userId: string; phone: string; nonce: string };
    expect(parsed.userId).toBe('user-1');
    expect(parsed.phone).toBe('+64211234567');
    expect(parsed.nonce).toBe('nonce-abc');
  });

  it('uses correct redirect URI', () => {
    const url = buildAuthUrl({
      clientId: 'test-client-id',
      redirectUri: 'https://custom.example.com/oauth/callback',
      state: { userId: 'user-1', phone: '+64211234567', nonce: 'nonce-abc' },
    });

    expect(url).toContain(
      'redirect_uri=https%3A%2F%2Fcustom.example.com%2Foauth%2Fcallback'
    );
  });
});

describe('parseOAuthState', () => {
  it('parses valid base64url-encoded state', () => {
    const state = { userId: 'user-abc', phone: '+64211234567', nonce: 'nonce-xyz' };
    const encoded = btoa(JSON.stringify(state))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const result = parseOAuthState(encoded);
    expect(result).not.toBeInstanceOf(Error);
    if (!(result instanceof Error)) {
      expect(result.userId).toBe('user-abc');
      expect(result.phone).toBe('+64211234567');
      expect(result.nonce).toBe('nonce-xyz');
    }
  });

  it('returns Error for invalid JSON', () => {
    const result = parseOAuthState('not-valid-base64!!');
    expect(result).toBeInstanceOf(Error);
    if (result instanceof Error) {
      expect(result.message).toContain('Invalid OAuth state');
    }
  });

  it('returns Error for state missing userId', () => {
    const encoded = btoa(JSON.stringify({ phone: '+64', nonce: 'only-nonce' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const result = parseOAuthState(encoded);
    expect(result).toBeInstanceOf(Error);
    if (result instanceof Error) {
      expect(result.message).toContain('missing userId');
    }
  });

  it('returns Error for state missing phone', () => {
    const encoded = btoa(JSON.stringify({ userId: 'only-user', nonce: 'only-nonce' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const result = parseOAuthState(encoded);
    expect(result).toBeInstanceOf(Error);
    if (result instanceof Error) {
      expect(result.message).toContain('Invalid OAuth state');
    }
  });

  it('returns Error for state missing nonce', () => {
    const encoded = btoa(JSON.stringify({ userId: 'only-user', phone: '+64' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const result = parseOAuthState(encoded);
    expect(result).toBeInstanceOf(Error);
    if (result instanceof Error) {
      expect(result.message).toContain('Invalid OAuth state');
    }
  });
});

describe('exchangeCodeForTokens', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('exchanges code for tokens with correct parameters', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'access-token-123',
        expires_in: 3600,
        refresh_token: 'refresh-token-456',
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
        token_type: 'Bearer',
      }),
    } as unknown as Response);

    const result = await exchangeCodeForTokens({
      code: 'auth-code-abc',
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      redirectUri: 'https://flip.example.com/auth/gmail/callback',
    });

    expect(result.access_token).toBe('access-token-123');
    expect(result.expires_in).toBe(3600);
    expect(result.refresh_token).toBe('refresh-token-456');
    expect(result.scope).toContain('gmail.readonly');
    expect(result.token_type).toBe('Bearer');
  });

  it('posts to the correct Google token endpoint', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'tok',
        expires_in: 3600,
        scope: 'scope',
        token_type: 'Bearer' as const,
      }),
    } as unknown as Response);

    await exchangeCodeForTokens({
      code: 'auth-code',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://example.com/callback',
    });

    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('https://oauth2.googleapis.com/token');
    expect(call[1].method).toBe('POST');
    expect(call[1].headers).toHaveProperty(
      'Content-Type',
      'application/x-www-form-urlencoded'
    );
  });

  it('sends grant_type=authorization_code in body', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'tok',
        expires_in: 3600,
        scope: 'scope',
        token_type: 'Bearer' as const,
      }),
    } as unknown as Response);

    await exchangeCodeForTokens({
      code: 'auth-code',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://example.com/callback',
    });

    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = call[1].body as string;
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code=auth-code');
  });

  it('throws on non-ok response with status in message', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'invalid_grant',
    } as unknown as Response);

    await expect(
      exchangeCodeForTokens({
        code: 'bad-code',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'https://example.com/callback',
      })
    ).rejects.toThrow('Google token exchange error (400)');
  });
});

describe('refreshAccessToken', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('refreshes token with refresh_token grant', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'new-access-token',
        expires_in: 3600,
      }),
    } as unknown as Response);

    const result = await refreshAccessToken({
      refreshToken: 'refresh-token-abc',
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
    });

    expect(result.accessToken).toBe('new-access-token');
    expect(result.expiry).toBeTruthy();
    // Expiry should be in the future
    expect(new Date(result.expiry).getTime()).toBeGreaterThan(Date.now());
  });

  it('uses refresh_token grant type in body', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'new-tok',
        expires_in: 3600,
      }),
    } as unknown as Response);

    await refreshAccessToken({
      refreshToken: 'refresh-token-abc',
      clientId: 'client-id',
      clientSecret: 'client-secret',
    });

    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = call[1].body as string;
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=refresh-token-abc');
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
    } as unknown as Response);

    await expect(
      refreshAccessToken({
        refreshToken: 'expired-token',
        clientId: 'client-id',
        clientSecret: 'client-secret',
      })
    ).rejects.toThrow('Google token refresh error (401)');
  });
});

describe('revokeAccess', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('sends revoke request to Google revoke URL', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
    } as unknown as Response);

    await revokeAccess({ accessToken: 'token-to-revoke' });

    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('https://oauth2.googleapis.com/revoke');
    expect(call[1].method).toBe('POST');
    const body = call[1].body as string;
    expect(body).toContain('token=token-to-revoke');
  });
});

describe('searchMessages', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('searches Gmail with query string', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        messages: [{ id: 'msg_1' }, { id: 'msg_2' }],
        resultSizeEstimate: 2,
      }),
    } as unknown as Response);

    const result = await searchMessages({
      accessToken: 'access-token',
      query: 'from:contact.co.nz has:attachment',
    });

    expect(result.messages).toHaveLength(2);
    expect(result.resultSizeEstimate).toBe(2);
  });

  it('uses Authorization Bearer header', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [], resultSizeEstimate: 0 }),
    } as unknown as Response);

    await searchMessages({
      accessToken: 'access-token',
      query: 'test query',
    });

    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(call[1].headers).toHaveProperty(
      'Authorization',
      'Bearer access-token'
    );
  });

  it('calls correct Gmail API endpoint', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [], resultSizeEstimate: 0 }),
    } as unknown as Response);

    await searchMessages({
      accessToken: 'tok',
      query: 'test',
    });

    const call = mockFetch.mock.calls[0] as [string];
    expect(call[0]).toContain('/users/me/messages');
    expect(call[0]).toContain('q=test');
  });

  it('supports pageToken for pagination', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [], resultSizeEstimate: 0 }),
    } as unknown as Response);

    await searchMessages({
      accessToken: 'tok',
      query: 'test',
      pageToken: 'next-page-token',
    });

    const call = mockFetch.mock.calls[0] as [string];
    expect(call[0]).toContain('pageToken=next-page-token');
  });

  it('uses maxResults from params or default', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [], resultSizeEstimate: 0 }),
    } as unknown as Response);

    await searchMessages({
      accessToken: 'tok',
      query: 'test',
      maxResults: 10,
    });

    const call = mockFetch.mock.calls[0] as [string];
    expect(call[0]).toContain('maxResults=10');
  });

  it('throws on API error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
    } as unknown as Response);

    await expect(
      searchMessages({ accessToken: 'bad-token', query: 'test' })
    ).rejects.toThrow('Gmail search error (403)');
  });
});

describe('getMessage', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('fetches a single message by ID', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'msg_123',
        threadId: 'thread_456',
        internalDate: '1715644800000',
      }),
    } as unknown as Response);

    const result = await getMessage({
      accessToken: 'access-token',
      messageId: 'msg_123',
    });

    expect(result.id).toBe('msg_123');
    expect(result.threadId).toBe('thread_456');
  });

  it('requests full format', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'msg_1', threadId: 't1', internalDate: '0' }),
    } as unknown as Response);

    await getMessage({
      accessToken: 'access-token',
      messageId: 'msg_123',
    });

    const call = mockFetch.mock.calls[0] as [string];
    expect(call[0]).toContain('format=full');
  });

  it('throws on API error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
    } as unknown as Response);

    await expect(
      getMessage({ accessToken: 'tok', messageId: 'nonexistent' })
    ).rejects.toThrow('Gmail get message error (404)');
  });
});

describe('downloadAttachment', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('downloads and decodes base64url attachment data', async () => {
    // "hello" in base64
    const testData = btoa('hello').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: testData, size: 5 }),
    } as unknown as Response);

    const result = await downloadAttachment({
      accessToken: 'access-token',
      messageId: 'msg_123',
      attachmentId: 'att_456',
    });

    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(result.byteLength).toBe(5);
    const bytes = new Uint8Array(result);
    const text = new TextDecoder().decode(bytes);
    expect(text).toBe('hello');
  });

  it('decodes base64url with padding correctly', async () => {
    // "ab" is 2 bytes, base64 would be "YWI=" (with padding)
    const raw = btoa('ab');
    const base64url = raw.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: base64url, size: 2 }),
    } as unknown as Response);

    const result = await downloadAttachment({
      accessToken: 'access-token',
      messageId: 'msg_1',
      attachmentId: 'att_1',
    });

    const text = new TextDecoder().decode(new Uint8Array(result));
    expect(text).toBe('ab');
  });

  it('throws on download error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
    } as unknown as Response);

    await expect(
      downloadAttachment({
        accessToken: 'invalid-token',
        messageId: 'msg_1',
        attachmentId: 'att_1',
      })
    ).rejects.toThrow('Gmail attachment download error (403)');
  });
});
