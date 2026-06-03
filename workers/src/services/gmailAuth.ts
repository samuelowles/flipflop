import type {
  GmailOAuthState,
  GoogleTokenResponse,
  GmailMessageList,
  GmailMessage,
} from '../types/gmail';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GMAIL_API_BASE = 'https://www.googleapis.com/gmail/v1';
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const DEFAULT_MAX_RESULTS = 500;

function base64UrlEncode(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Build the Google OAuth authorization URL
export function buildAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  state: GmailOAuthState;
}): string {
  const stateStr = base64UrlEncode(JSON.stringify(params.state));
  const query = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state: stateStr,
  });
  return `${GOOGLE_AUTH_URL}?${query.toString()}`;
}

// Parse and validate OAuth state from callback
export function parseOAuthState(stateStr: string): GmailOAuthState | Error {
  try {
    const decoded = atob(
      stateStr.replace(/-/g, '+').replace(/_/g, '/')
    );
    const parsed = JSON.parse(decoded) as GmailOAuthState;
    if (!parsed.userId || !parsed.phone || !parsed.nonce) {
      return new Error('Invalid OAuth state: missing userId, phone, or nonce');
    }
    return parsed;
  } catch {
    return new Error('Invalid OAuth state: decode failed');
  }
}

// Exchange an authorization code for tokens
export async function exchangeCodeForTokens(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<GoogleTokenResponse> {
  const start = Date.now();
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: params.code,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google token exchange error (${response.status}): ${errorText}`);
  }

  const data = await response.json() as GoogleTokenResponse;

  console.log(JSON.stringify({
    type: 'gmail_token_exchange',
    scope: data.scope,
    hasRefreshToken: !!data.refresh_token,
    expiresIn: data.expires_in,
    latencyMs: Date.now() - start,
    timestamp: new Date().toISOString(),
  }));

  return data;
}

// Refresh an expired access token
export async function refreshAccessToken(params: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ accessToken: string; expiry: string }> {
  const start = Date.now();
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: params.refreshToken,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      grant_type: 'refresh_token',
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(`Google token refresh error (${response.status})`);
  }

  const data = await response.json() as {
    access_token: string;
    expires_in: number;
  };

  const expiry = new Date(Date.now() + data.expires_in * 1000).toISOString();

  console.log(JSON.stringify({
    type: 'gmail_token_refresh',
    expiresIn: data.expires_in,
    latencyMs: Date.now() - start,
    timestamp: new Date().toISOString(),
  }));

  return { accessToken: data.access_token, expiry };
}

// Revoke a user's access (disconnect Gmail)
export async function revokeAccess(params: {
  accessToken: string;
}): Promise<void> {
  await fetch(GOOGLE_REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: params.accessToken }).toString(),
  });
}

// Search Gmail inbox using Gmail API query syntax
export async function searchMessages(params: {
  accessToken: string;
  query: string;
  maxResults?: number;
  pageToken?: string;
}): Promise<GmailMessageList> {
  const start = Date.now();
  const queryParams = new URLSearchParams({
    q: params.query,
    maxResults: String(params.maxResults ?? DEFAULT_MAX_RESULTS),
  });
  if (params.pageToken) {
    queryParams.set('pageToken', params.pageToken);
  }

  const response = await fetch(
    `${GMAIL_API_BASE}/users/me/messages?${queryParams.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        Accept: 'application/json',
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Gmail search error (${response.status})`);
  }

  const data = await response.json() as GmailMessageList;

  console.log(JSON.stringify({
    type: 'gmail_search',
    resultCount: data.resultSizeEstimate,
    latencyMs: Date.now() - start,
    timestamp: new Date().toISOString(),
    // Never log query (contains email domains) or tokens
  }));

  return data;
}

// Fetch a single message by ID (with full payload)
export async function getMessage(params: {
  accessToken: string;
  messageId: string;
}): Promise<GmailMessage> {
  const response = await fetch(
    `${GMAIL_API_BASE}/users/me/messages/${params.messageId}?format=full`,
    {
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        Accept: 'application/json',
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Gmail get message error (${response.status})`);
  }

  return response.json() as unknown as GmailMessage;
}

// Download a specific attachment from a message
export async function downloadAttachment(params: {
  accessToken: string;
  messageId: string;
  attachmentId: string;
}): Promise<ArrayBuffer> {
  const start = Date.now();
  const response = await fetch(
    `${GMAIL_API_BASE}/users/me/messages/${params.messageId}/attachments/${params.attachmentId}`,
    {
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        Accept: 'application/json',
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Gmail attachment download error (${response.status})`);
  }

  const data = await response.json() as { data: string; size: number };
  // Gmail returns base64url-encoded attachment data
  const binary = atob(data.data.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  console.log(JSON.stringify({
    type: 'gmail_attachment_download',
    messageId: params.messageId, // Not PII
    size: data.size,
    latencyMs: Date.now() - start,
    timestamp: new Date().toISOString(),
  }));

  return bytes.buffer;
}
