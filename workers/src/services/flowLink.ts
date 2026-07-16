/**
 * Issue #241 — HMAC-signed links for /flow/status browser auth.
 *
 * The trace page 401-ed in a browser because adminAuth requires a Bearer header
 * a browser cannot send. These helpers mint and verify HMAC-SHA256 signed URLs
 * derived from ENCRYPTION_KEY (no new secret), with a 24h TTL matching
 * FLOW_TRACE_TTL_SECONDS. A signed link carries `u={userId}&exp={unix}&sig={hex}`.
 */
import { timingSafeEqual } from '../middleware/adminAuth';
import { FLOW_TRACE_TTL_SECONDS } from '../types/flowTrace';

/** Default TTL — matches FLOW_TRACE_TTL_SECONDS (24h). */
export const DEFAULT_FLOW_LINK_TTL = FLOW_TRACE_TTL_SECONDS;

/** Hex-encode a byte array (crypto.subtle.digest returns ArrayBuffer). */
function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** HMAC-SHA256(key, message) → hex digest, via the WebCrypto subtle API. */
async function hmacHex(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
  return toHex(sig);
}

/**
 * Mint a signed /flow/status link for `userId`, valid for `ttlSeconds`.
 * Returns a relative path with query string (caller prepends origin if needed).
 */
export async function mintFlowLink(
  encryptionKey: string,
  userId: string,
  ttlSeconds: number = DEFAULT_FLOW_LINK_TTL
): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = await hmacHex(encryptionKey, `${userId}|${exp}`);
  const u = encodeURIComponent(userId);
  return `/flow/status?u=${u}&exp=${exp}&sig=${sig}`;
}

/**
 * Verify a signed-link triple. Returns false when expired, tampered, or
 * malformed. Constant-time signature compare via timingSafeEqual.
 */
export async function verifyFlowLink(
  encryptionKey: string,
  u: string | undefined | null,
  exp: string | undefined | null,
  sig: string | undefined | null
): Promise<boolean> {
  if (!u || !exp || !sig) return false;
  const expNum = Number(exp);
  if (!Number.isInteger(expNum)) return false;
  if (expNum <= Math.floor(Date.now() / 1000)) return false;
  const expected = await hmacHex(encryptionKey, `${u}|${exp}`);
  return timingSafeEqual(sig, expected);
}
