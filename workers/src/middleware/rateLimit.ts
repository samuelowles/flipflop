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

// Identifies a user: by phone from the Sent webhook body, or context (set by sentAuth)
async function getUserKey(c: Context): Promise<string> {
  // First check context (set by sentAuth middleware)
  const contextPhone = c.get('phone') as string | undefined;
  if (contextPhone) {
    return `rate:user:${contextPhone}`;
  }

  // Try to extract phone from the request body directly
  try {
    const body = await c.req.raw.clone().json() as { from?: string };
    if (body.from) {
      return `rate:user:${body.from}`;
    }
  } catch {
    // Body not JSON or not available — fall through
  }

  // Last resort: IP-based key (for non-webhook routes)
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  return `rate:user:${ip}`;
}

export function rateLimit(config?: Partial<RateLimitConfig>) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  return async function rateLimitMiddleware(c: Context, next: Next): Promise<Response | void> {
    const kv = c.env.KV as KVNamespace;
    const now = Date.now();
    const windowStart = now - cfg.windowMs;

    const userKey = await getUserKey(c);
    const globalKey = 'rate:global';

    // Check user limit
    const userHits = await getUserWindowHits(kv, userKey, now, cfg.windowMs);
    if (userHits >= cfg.userLimit) {
      return c.json(
        { error: 'Too many requests', code: 'rate_limited', status: 429, retryAfter: cfg.windowMs / 1000 },
        429,
        { 'Retry-After': String(cfg.windowMs / 1000) }
      );
    }

    // Check global limit
    const globalHits = await getUserWindowHits(kv, globalKey, now, cfg.windowMs);
    if (globalHits >= cfg.globalLimit) {
      return c.json(
        { error: 'Service busy, please try again', code: 'rate_limited', status: 429, retryAfter: cfg.windowMs / 1000 },
        429,
        { 'Retry-After': String(cfg.windowMs / 1000) }
      );
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

// Sliding window: store timestamps as sorted set, trim expired ones
async function getUserWindowHits(
  kv: KVNamespace,
  key: string,
  now: number,
  windowMs: number
): Promise<number> {
  const raw = await kv.get(key);
  if (!raw) return 0;
  const timestamps: number[] = JSON.parse(raw);
  // Filter to current window
  const cutoff = now - windowMs;
  const current = timestamps.filter(t => t > cutoff);
  return current.length;
}

async function recordHit(
  kv: KVNamespace,
  key: string,
  now: number,
  windowMs: number
): Promise<void> {
  const raw = await kv.get(key);
  const timestamps: number[] = raw ? JSON.parse(raw) : [];
  const cutoff = now - windowMs;
  const current = timestamps.filter(t => t > cutoff);
  current.push(now);
  // Store with TTL slightly longer than window
  await kv.put(key, JSON.stringify(current), { expirationTtl: Math.ceil(windowMs / 1000) + 10 });
}
