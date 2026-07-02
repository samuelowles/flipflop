// Durable Object for atomic rate limiting.
//
// Why DO instead of KV?  KV's read-modify-write cycle is racy under load —
// concurrent requests can both observe `count < limit`, both increment,
// and both pass.  The audit flagged this in PR #151 as HIGH severity.  A
// Durable Object serialises writes per-key via single-threaded execution,
// eliminating the race at the cost of an extra hop.
//
// Storage shape: one entry per (rate-limit key) holding an array of
// millisecond timestamps for the active window.  Old timestamps are
// trimmed on every read, which gives an approximate sliding window.

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface RateLimiterEnv {
  // Bound in wrangler.toml via [[durable_objects.bindings]].
}

interface CheckRequest {
  key: string;
  limit: number;
  windowMs: number;
  now: number; // injected so tests can use a deterministic clock
}

interface CheckResponse {
  limited: boolean;
  remaining: number;
  retryAfterMs: number;
}

interface StatusRequest {
  key: string;
  limit: number;
  windowMs: number;
  now: number; // injected so tests can use a deterministic clock
}

interface StatusResponse {
  count: number;
  limit: number;
  windowMs: number;
  remaining: number;
  // Epoch-ms timestamp of the oldest request still inside the window, or
  // null if the window is empty.  Exposed so admins can see when the next
  // request would rotate out.
  oldestAt: number | null;
}

export class RateLimiter {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState, _env: RateLimiterEnv) {
    this.state = state;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/check') {
      const body = (await req.json()) as CheckRequest;
      const result = await this.checkAndRecord(
        body.key,
        body.limit,
        body.windowMs,
        body.now
      );
      return Response.json(result);
    }

    // Read-only current state for a key — used by the admin visibility
    // endpoint (issue #37 AC #4).  Does NOT append a timestamp; it only
    // reports what `/check` would see given the current stored window.
    if (url.pathname === '/status') {
      const body = (await req.json()) as StatusRequest;
      const result = await this.status(body.key, body.limit, body.windowMs, body.now);
      return Response.json(result);
    }

    return new Response('Not Found', { status: 404 });
  }

  // Trim expired timestamps; if the remaining count is below the limit,
  // append `now` and allow the request.  Atomic because DO methods are
  // single-threaded per instance.
  private async checkAndRecord(
    key: string,
    limit: number,
    windowMs: number,
    now: number
  ): Promise<CheckResponse> {
    const cutoff = now - windowMs;
    const stored = (await this.state.storage.get<number[]>(key)) ?? [];
    const active = stored.filter((t) => t > cutoff);

    if (active.length >= limit) {
      const oldest = active[0] as number;
      const retryAfterMs = Math.max(0, oldest + windowMs - now);
      return { limited: true, remaining: 0, retryAfterMs };
    }

    active.push(now);
    await this.state.storage.put(key, active);
    return {
      limited: false,
      remaining: Math.max(0, limit - active.length),
      retryAfterMs: 0,
    };
  }

  // Read-only view of the sliding window for admin visibility (#37 AC #4).
  // Trims expired timestamps exactly like `/check` so the count reflects
  // what the next `/check` would see, but does NOT append a new timestamp.
  private async status(
    key: string,
    limit: number,
    windowMs: number,
    now: number
  ): Promise<StatusResponse> {
    const cutoff = now - windowMs;
    const stored = (await this.state.storage.get<number[]>(key)) ?? [];
    const active = stored.filter((t) => t > cutoff);
    return {
      count: active.length,
      limit,
      windowMs,
      remaining: Math.max(0, limit - active.length),
      oldestAt: active.length > 0 ? (active[0] as number) : null,
    };
  }
}