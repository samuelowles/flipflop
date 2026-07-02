/**
 * Admin endpoint for per-user rate-limit visibility (issue #37 AC #4).
 *
 * Surfaces the current sliding-window counter for a rate-limit key from the
 * `RATE_LIMITER` Durable Object.  Auth-gated via the shared `adminAuth`
 * middleware applied to `/admin/*` in index.ts (requires `ADMIN_API_KEY`
 * Bearer header).
 */
import type { Context } from 'hono';

interface RateLimitEnv {
  readonly RATE_LIMITER: DurableObjectNamespace;
}

interface StatusResponse {
  count: number;
  limit: number;
  windowMs: number;
  remaining: number;
  oldestAt: number | null;
}

// Default config mirrors middleware/rateLimit.ts DEFAULT_CONFIG.
const DEFAULT_USER_LIMIT = 100;
const DEFAULT_WINDOW_MS = 60_000;

export async function adminRateLimitStatus(c: Context): Promise<Response> {
  const env = c.env as RateLimitEnv;

  // The rate-limit key is a hashed phone/IP (see rateLimit.ts deriveKey).
  // Admins look it up by that hash; raw phone numbers are never accepted
  // here to avoid turning this endpoint into a PII lookup.
  const userKey = c.req.param('userKey');
  if (!userKey) {
    return c.json(
      { error: 'Missing userKey parameter', code: 'bad_request', status: 400 },
      400
    );
  }

  const stub = env.RATE_LIMITER;
  if (!stub) {
    return c.json(
      { error: 'Rate limiter unavailable', code: 'misconfigured', status: 503 },
      503
    );
  }

  const id = stub.idFromName(userKey);
  const doStub = stub.get(id);
  const limit = Number(c.req.query('limit') ?? DEFAULT_USER_LIMIT);
  const windowMs = Number(c.req.query('windowMs') ?? DEFAULT_WINDOW_MS);

  const res = await doStub.fetch(
    new Request('https://rate-limiter/status', {
      method: 'POST',
      body: JSON.stringify({
        key: userKey,
        limit,
        windowMs,
        now: Date.now(),
      }),
    })
  );

  if (!res.ok) {
    return c.json(
      { error: 'Rate limiter read failed', code: 'upstream_error', status: 502 },
      502
    );
  }

  const status = (await res.json()) as StatusResponse;
  return c.json({ userKey, ...status });
}
