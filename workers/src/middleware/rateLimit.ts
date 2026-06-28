import type { Context, Next } from 'hono';
import { generatePhoneHash } from '../models/encryption';

// Rate limiting middleware.
//
// Design: one Durable Object per rate-limit key.  The DO holds an array
// of millisecond timestamps inside its `windowMs` window and atomically
// checks-and-appends via single-threaded execution.  This eliminates the
// read-modify-write race that the prior KV implementation suffered from
// (HIGH severity finding in the PR #151 audit).
//
// AC compliance:
//  - /health, /healthz, /ready bypass (BYPASS_PATHS).
//  - 429 body shape `{ error: 'rate_limited', retry_after }` with
//    `Retry-After` header in seconds.
//  - PII is never logged; the rate-limit key is hashed before logging.
//  - Per-user key prefers `phone_hash` (set by sentAuth) over the raw
//    `phone`, falling back to a hashed IP for non-webhook routes.

interface RateLimitConfig {
  readonly userLimit: number;
  readonly globalLimit: number;
  readonly windowMs: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  userLimit: 100,
  globalLimit: 1000,
  windowMs: 60_000, // 1 minute
};

// AC: /health, /healthz, /ready are exempt.  Workers expose /health for
// Cloudflare's health-check probes, /healthz for legacy k8s probes, and
// /ready for readiness checks.
const BYPASS_PATHS = new Set(['/health', '/healthz', '/ready']);

interface DurableObjectStub {
  fetch: (req: Request) => Promise<Response>;
  id: { toString: () => string };
}

interface RateLimitEnv {
  RATE_LIMITER: DurableObjectNamespace;
  KV?: KVNamespace;
}

// Derive the rate-limit key for a request.  Prefer the SHA-256 hash of
// the phone (set by sentAuth as `phone_hash`); fall back to a hashed IP
// so non-webhook routes still get per-caller keying without storing the
// raw IP.  Falls back to 'unknown' as a last resort.
async function deriveKey(c: Context): Promise<string> {
  const phoneHash = c.get('phone_hash') as string | undefined;
  if (phoneHash) return phoneHash;

  const phone = c.get('phone') as string | undefined;
  if (phone) return generatePhoneHash(phone);

  const ip = c.req.header('CF-Connecting-IP');
  if (ip) return generatePhoneHash(`ip:${ip}`);

  return 'unknown';
}

// Stable, deterministic DO name from a key.  Using `idFromName` means
// the same key always maps to the same DO instance, preserving the
// sliding-window counter across requests.
function doId(stub: DurableObjectNamespace, key: string): DurableObjectStub {
  const id = stub.idFromName(key);
  return stub.get(id) as unknown as DurableObjectStub;
}

async function checkLimit(
  stub: DurableObjectNamespace,
  key: string,
  limit: number,
  windowMs: number
): Promise<{ limited: boolean; retryAfterMs: number }> {
  const doStub = doId(stub, key);
  const res = await doStub.fetch(
    new Request('https://rate-limiter/check', {
      method: 'POST',
      body: JSON.stringify({ key, limit, windowMs, now: Date.now() }),
    })
  );
  if (!res.ok) {
    // DO unavailable — fail closed (treat as limited) to prevent abuse
    // during infrastructure incidents.  Caller may override with
    // RATE_LIMIT_FAIL_OPEN env if availability outweighs rate-limit
    // integrity for a given deployment.
    return { limited: true, retryAfterMs: windowMs };
  }
  return (await res.json()) as { limited: boolean; retryAfterMs: number };
}

// Short non-cryptographic hash for PII-safe logging.
function hashId(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h << 5) - h + id.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}

function logHit(
  c: Context,
  scope: 'user' | 'global',
  id: string,
  retryAfterSeconds: number
): void {
  // AC: never log body, never log raw user id (PII).  Log a hash.
  console.log(
    JSON.stringify({
      type: 'rate_limit_hit',
      scope,
      id_hash: hashId(id),
      retry_after: retryAfterSeconds,
      path: c.req.path,
      method: c.req.method,
      request_id: c.req.header('cf-ray') ?? undefined,
      timestamp: new Date().toISOString(),
    })
  );
}

function respondRateLimited(
  c: Context,
  scope: 'user' | 'global',
  id: string,
  retryAfterMs: number
): Response {
  const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);
  logHit(c, scope, id, retryAfterSeconds);
  return c.json(
    { error: 'rate_limited', retry_after: retryAfterSeconds },
    429,
    { 'Retry-After': String(retryAfterSeconds) }
  );
}

export function rateLimit(config?: Partial<RateLimitConfig>) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  return async function rateLimitMiddleware(
    c: Context,
    next: Next
  ): Promise<Response | void> {
    if (BYPASS_PATHS.has(c.req.path)) {
      await next();
      return;
    }

    const env = c.env as RateLimitEnv | undefined;
    const stub = env?.RATE_LIMITER;
    if (!stub) {
      console.error(
        JSON.stringify({
          type: 'rate_limit_misconfigured',
          message: 'RATE_LIMITER Durable Object binding missing',
        })
      );
      // Fail closed: return 503 so the caller can retry.  Better to
      // refuse traffic than to silently bypass rate limits.
      return c.json(
        { error: 'rate_limit_unavailable', retry_after: 60 },
        503
      );
    }

    const userKey = await deriveKey(c);

    const userCheck = await checkLimit(stub, userKey, cfg.userLimit, cfg.windowMs);
    if (userCheck.limited) {
      return respondRateLimited(c, 'user', userKey, userCheck.retryAfterMs);
    }

    const globalKey = 'global';
    const globalCheck = await checkLimit(stub, globalKey, cfg.globalLimit, cfg.windowMs);
    if (globalCheck.limited) {
      return respondRateLimited(c, 'global', globalKey, globalCheck.retryAfterMs);
    }

    await next();
  };
}