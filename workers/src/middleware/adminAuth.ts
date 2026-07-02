/**
 * Shared admin auth middleware (issue #37 follow-up — security gap closure).
 *
 * Gates every `/admin/*` route behind `Authorization: Bearer <ADMIN_API_KEY>`.
 * DRY single source of truth — replaces the inline Bearer check that was added
 * inline to adminRateLimit.ts in PR #171, and extends the same protection to
 * the older `/admin/templates` routes that were previously unauthenticated.
 *
 * Returns 401 if the secret is unset, the header is missing/malformed, or the
 * constant-time comparison fails.
 */
import type { Context, MiddlewareHandler } from 'hono';

interface AdminAuthEnv {
  readonly ADMIN_API_KEY?: string;
}

// Constant-time-ish Bearer comparison.  Avoids early-return byte comparison
// to limit timing oracle on the secret.  Both strings must be equal length
// for the loop to be meaningful; we equalise by comparing over the longer.
export function timingSafeEqual(a: string, b: string): boolean {
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

export const adminAuth: MiddlewareHandler = async (
  c: Context,
  next: () => Promise<void>
): Promise<Response | void> => {
  const env = c.env as AdminAuthEnv;

  const authHeader = c.req.header('Authorization') ?? '';
  const provided = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : '';

  if (
    !env.ADMIN_API_KEY ||
    !provided ||
    !timingSafeEqual(provided, env.ADMIN_API_KEY)
  ) {
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

  await next();
};
