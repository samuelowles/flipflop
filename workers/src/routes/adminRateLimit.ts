/**
 * Admin endpoint for per-user rate-limit visibility (issue #37 AC #4).
 *
 * Surfaces the current sliding-window counter for a rate-limit key from the
 * `RATE_LIMITER` Durable Object.  Auth-gated via `ADMIN_API_KEY` (Bearer
 * header) — the same secret is provisioned in production but was previously
 * unreferenced in code.  This is the first admin surface to actually enforce
 * it; the older `/admin/templates` routes remain unauthenticated to avoid a
 * drive-by scope change here.
 */
import type { Context } from 'hono';

interface RateLimitEnv {
  readonly ADMIN_API_KEY: string;
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

// Constant-time-ish Bearer comparison.  Avoids early-return byte comparison
// to limit timing oracle on the secret.  Both strings must be equal length
// for the loop to be meaningful; we equalise by comparing over the longer.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false;
  let result = a.length ^ b.length;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const ac = a.charCodeAt(i % a.length);
    const bc = b.charCodeAt(i % b.length);
    result |= ac ^ bc;
  }
  return result === 0;
}

export async function adminRateLimitStatus(c: Context): Promise<Response> {
  const env = c.env as RateLimitEnv;

  // Auth: require `Authorization: Bearer <ADMIN_API_KEY>`.
  const authHeader = c.req.header('Authorization') ?? '';
  const provided = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : '';
  if (!env.ADMIN_API_KEY || !provided || !timingSafeEqual(provided, env.ADMIN_API_KEY)) {
    console.log(
      JSON.stringify({
        type: 'admin_auth_failed',
        path: c.req.path,
        method: c.req.method,
        timestamp: new Date().toISOString(),
      })
    );
    return c.json(
      { error: 'Unauthorized', code: 'unauthorized', status: 401 },
      401
    );
  }

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
