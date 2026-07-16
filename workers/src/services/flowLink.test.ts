/**
 * Issue #241 — flowLink service tests (HMAC-signed /flow/status links).
 *
 * AC coverage:
 *   - valid link verifies (round-trip mint → verify)
 *   - expired link fails
 *   - tampered u / exp / sig each fail
 *   - malformed params (missing/empty/non-numeric exp) fail
 */
import { describe, it, expect } from 'vitest';
import { mintFlowLink, verifyFlowLink, DEFAULT_FLOW_LINK_TTL } from './flowLink';

const KEY = 'test-encryption-key-32-bytes-aaaaaa';
const USER_ID = 'u-123';

describe('flowLink — mintFlowLink', () => {
  it('produces a /flow/status URL with u, exp, sig params', async () => {
    const url = await mintFlowLink(KEY, USER_ID);
    expect(url.startsWith('/flow/status?u=')).toBe(true);
    expect(url).toContain('&exp=');
    expect(url).toContain('&sig=');
    // userId is URL-encoded in the u param.
    expect(url).toContain(`u=${encodeURIComponent(USER_ID)}`);
  });

  it('default TTL matches FLOW_TRACE_TTL_SECONDS (24h)', () => {
    expect(DEFAULT_FLOW_LINK_TTL).toBe(24 * 60 * 60);
  });

  it('honours a custom ttlSeconds', async () => {
    const now = Math.floor(Date.now() / 1000);
    const url = await mintFlowLink(KEY, USER_ID, 60);
    const expStr = new URL('http://x' + url).searchParams.get('exp');
    expect(Number(expStr)).toBeGreaterThanOrEqual(now + 59);
    expect(Number(expStr)).toBeLessThanOrEqual(now + 61);
  });
});

describe('flowLink — verifyFlowLink', () => {
  it('verifies a freshly minted link', async () => {
    const url = await mintFlowLink(KEY, USER_ID);
    const params = new URL('http://x' + url).searchParams;
    const ok = await verifyFlowLink(
      KEY,
      params.get('u'),
      params.get('exp'),
      params.get('sig')
    );
    expect(ok).toBe(true);
  });

  it('fails when the link is expired (exp in the past)', async () => {
    // Mint a link whose sig matches an explicit past exp, so the ONLY failure
    // is expiry (not a sig mismatch). This isolates the expiry check.
    const pastExp = Math.floor(Date.now() / 1000) - 3600;
    const expiredUrl = await mintExpiredLink(KEY, USER_ID, pastExp);
    const params = new URL('http://x' + expiredUrl).searchParams;
    const ok = await verifyFlowLink(
      KEY,
      params.get('u'),
      params.get('exp'),
      params.get('sig')
    );
    expect(ok).toBe(false);
  });

  it('fails when userId (u) is tampered', async () => {
    const url = await mintFlowLink(KEY, USER_ID);
    const params = new URL('http://x' + url).searchParams;
    const ok = await verifyFlowLink(
      KEY,
      'u-tampered',
      params.get('exp'),
      params.get('sig')
    );
    expect(ok).toBe(false);
  });

  it('fails when exp is tampered', async () => {
    const url = await mintFlowLink(KEY, USER_ID, 3600);
    const params = new URL('http://x' + url).searchParams;
    const tamperedExp = String(Number(params.get('exp')) + 100);
    const ok = await verifyFlowLink(
      KEY,
      params.get('u'),
      tamperedExp,
      params.get('sig')
    );
    expect(ok).toBe(false);
  });

  it('fails when sig is tampered', async () => {
    const url = await mintFlowLink(KEY, USER_ID);
    const params = new URL('http://x' + url).searchParams;
    const sig = params.get('sig')!;
    const tamperedSig = sig.slice(0, -2) + (sig.endsWith('0') ? '1' : '0');
    const ok = await verifyFlowLink(
      KEY,
      params.get('u'),
      params.get('exp'),
      tamperedSig
    );
    expect(ok).toBe(false);
  });

  it('fails when params are missing (undefined)', async () => {
    expect(await verifyFlowLink(KEY, undefined, undefined, undefined)).toBe(false);
    expect(await verifyFlowLink(KEY, USER_ID, undefined, undefined)).toBe(false);
    expect(await verifyFlowLink(KEY, USER_ID, '123', undefined)).toBe(false);
  });

  it('fails when params are empty strings', async () => {
    expect(await verifyFlowLink(KEY, '', '', '')).toBe(false);
  });

  it('fails when exp is non-numeric', async () => {
    const url = await mintFlowLink(KEY, USER_ID);
    const params = new URL('http://x' + url).searchParams;
    const ok = await verifyFlowLink(
      KEY,
      params.get('u'),
      'not-a-number',
      params.get('sig')
    );
    expect(ok).toBe(false);
  });

  it('fails with the wrong encryption key', async () => {
    const url = await mintFlowLink(KEY, USER_ID);
    const params = new URL('http://x' + url).searchParams;
    const ok = await verifyFlowLink(
      'wrong-key',
      params.get('u'),
      params.get('exp'),
      params.get('sig')
    );
    expect(ok).toBe(false);
  });
});

/**
 * Helper: mint a link whose sig matches an explicit (past) exp value.
 * Replicates the HMAC so we can test pure expiry without tampering the sig.
 */
async function mintExpiredLink(key: string, userId: string, exp: number): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(`${userId}|${exp}`));
  const sig = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `/flow/status?u=${encodeURIComponent(userId)}&exp=${exp}&sig=${sig}`;
}
