import type { Context, Next } from 'hono';

interface RateLimitConfig {
  readonly userLimit: number;    // requests per window per user
  readonly globalLimit: number;  // requests per window globally
  readonly windowMs: number;     // window size in milliseconds
}

const DEFAULT_CONFIG: RateLimitConfig = {
  userLimit: 100,
  globalLimit: 1000,
  windowMs: 60_000, // 1 minute
};

// Paths that bypass rate limiting (AC: /health, /healthz, /ready)
const BYPASS_PATHS = new Set(['/health', '/healthz', '/ready']);

// Identifies a user: by phone from the Sent webhook body, or context (set by sentAuth)
async function getUserId(c: Context): Promise<string> {
  // First check context (set by sentAuth middleware)
  const contextPhone = c.get('phone') as string | undefined;
  if (contextPhone) {
    return contextPhone;
  }

  // Try to extract phone from the request body directly
  try {
    const body = await c.req.raw.clone().json() as { from?: string };
    if (body.from) {
      return body.from;
    }
  } catch {
    // Body not JSON or not available — fall through
  }

  // Last resort: IP-based key (for non-webhook routes)
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  return ip;
}

// KV key format per AC: `ratelimit:{scope}:{id}:{minute}`
function makeKey(scope: 'user' | 'global', id: string, minute: number): string {
  return `ratelimit:${scope}:${id}:${minute}`;
}

// Returns the current minute bucket (epoch minutes) for the given timestamp
function currentMinute(now: number): number {
  return Math.floor(now / 60_000);
}

export function rateLimit(config?: Partial<RateLimitConfig>) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  return async function rateLimitMiddleware(c: Context, next: Next): Promise<Response | void> {
    // AC: bypass for /health, /healthz, /ready
    if (BYPASS_PATHS.has(c.req.path)) {
      await next();
      return;
    }

    const kv = c.env.KV as KVNamespace;
    const now = Date.now();
    const minute = currentMinute(now);

    const userId = await getUserId(c);
    const userKey = makeKey('user', userId, minute);
    const globalKey = makeKey('global', 'all', minute);

    // Check user limit
    const userHits = await getWindowHits(kv, userKey);
    if (userHits >= cfg.userLimit) {
      return respondRateLimited(c, 'user', userId, cfg.windowMs / 1000);
    }

    // Check global limit
    const globalHits = await getWindowHits(kv, globalKey);
    if (globalHits >= cfg.globalLimit) {
      return respondRateLimited(c, 'global', 'all', cfg.windowMs / 1000);
    }

    // Record hits (fire and forget — don't block the response)
    const recordPromise = Promise.all([
      recordHit(kv, userKey, now, cfg.windowMs),
      recordHit(kv, globalKey, now, cfg.windowMs),
    ]);
    // c.executionCtx may be unavailable in test environments
    try {
      c.executionCtx.waitUntil(recordPromise);
    } catch {
      void recordPromise;
    }

    await next();
  };
}

// AC: 429 body shape `{ error: 'rate_limited', retry_after }` + log the limit hit only (no body, no PII)
function respondRateLimited(
  c: Context,
  scope: 'user' | 'global',
  id: string,
  retryAfterSeconds: number
): Response {
  // AC: logs only the limit hit, not the body. No PII — log a hash of the id, not the raw value.
  const idHash = hashId(id);
  console.log(JSON.stringify({
    type: 'rate_limit_hit',
    scope,
    id_hash: idHash,
    retry_after: retryAfterSeconds,
    path: c.req.path,
    method: c.req.method,
    request_id: c.req.header('cf-ray') ?? undefined,
    timestamp: new Date(now()).toISOString(),
  }));

  return c.json(
    { error: 'rate_limited', retry_after: retryAfterSeconds },
    429,
    { 'Retry-After': String(retryAfterSeconds) }
  );
}

// Short non-cryptographic hash for PII-safe id logging
function hashId(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h << 5) - h + id.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}

function now(): number {
  return Date.now();
}

// Per-minute bucket counter in KV. Stored as a simple integer count (the bucket key
// itself encodes the minute, so no sliding-window trimming is required — buckets
// expire automatically via the per-key TTL).
async function getWindowHits(kv: KVNamespace, key: string): Promise<number> {
  const raw = await kv.get(key);
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

async function recordHit(
  kv: KVNamespace,
  key: string,
  _now: number,
  windowMs: number
): Promise<void> {
  const raw = await kv.get(key);
  const current = raw ? Number.parseInt(raw, 10) : 0;
  const next = Number.isFinite(current) ? current + 1 : 1;
  // Store with TTL slightly longer than the minute window so buckets self-expire
  await kv.put(key, String(next), { expirationTtl: Math.ceil(windowMs / 1000) + 10 });
}
