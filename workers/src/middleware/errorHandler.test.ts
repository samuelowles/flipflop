import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { errorHandler } from './errorHandler';

describe('errorHandler middleware', () => {
  it('passes through successful responses', async () => {
    const app = new Hono();
    app.use('*', errorHandler);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('returns 500 for unhandled errors with generic message', async () => {
    const app = new Hono();
    app.use('*', errorHandler);
    app.get('/test', () => {
      throw new Error('Something broke');
    });

    const res = await app.request('/test');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; code: string; status: number };
    expect(body.code).toBe('internal_error');
    expect(body.status).toBe(500);
    // AC: production 500 response is { error: 'internal_error' } — no internals leaked
    expect(body.error).toBe('internal_error');
    expect(body.error).not.toContain('Something broke');
  });

  it('returns 404 for "not found" errors', async () => {
    const app = new Hono();
    app.use('*', errorHandler);
    app.get('/test', () => {
      throw new Error('User not found');
    });

    const res = await app.request('/test');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; code: string; status: number };
    expect(body.code).toBe('not_found');
    expect(body.status).toBe(404);
  });

  it('returns 401 for "unauthorized" errors', async () => {
    const app = new Hono();
    app.use('*', errorHandler);
    app.get('/test', () => {
      throw new Error('Unauthorized access');
    });

    const res = await app.request('/test');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; code: string; status: number };
    expect(body.code).toBe('unauthorized');
    expect(body.error).toBe('Unauthorized.');
  });

  it('returns 400 for "validation" errors', async () => {
    const app = new Hono();
    app.use('*', errorHandler);
    app.get('/test', () => {
      throw new Error('Invalid input - validation failed');
    });

    const res = await app.request('/test');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string; status: number };
    expect(body.code).toBe('validation_error');
  });

  it('returns 429 for "rate limit" errors', async () => {
    const app = new Hono();
    app.use('*', errorHandler);
    app.get('/test', () => {
      throw new Error('too many requests - rate limit exceeded');
    });

    const res = await app.request('/test');
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; code: string; status: number };
    expect(body.code).toBe('rate_limited');
  });

  it('never exposes stack traces or internal details in 500 responses', async () => {
    const app = new Hono();
    app.use('*', errorHandler);
    app.get('/test', () => {
      const err = new Error('secret details: api_key=sk-12345 db_password=super_secret');
      throw err;
    });

    const res = await app.request('/test');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; code: string };
    // AC: production 500 response shape — no internals leaked, no secret content
    expect(body.error).toBe('internal_error');
    expect(body.code).toBe('internal_error');
    expect(JSON.stringify(body)).not.toContain('sk-12345');
    expect(JSON.stringify(body)).not.toContain('super_secret');
    expect(JSON.stringify(body)).not.toContain('secret details');
  });

  it('includes timestamp in structured error response', async () => {
    const app = new Hono();
    app.use('*', errorHandler);
    app.get('/test', () => {
      throw new Error('Validation failed');
    });

    const res = await app.request('/test');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string; status: number };
    expect(body.status).toBe(400);
    expect(body.code).toBe('validation_error');
  });

  it('handles errors thrown in nested middleware', async () => {
    const app = new Hono();
    app.use('*', errorHandler);
    app.use('/test', async () => {
      throw new Error('Not found in middleware');
    });
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(404);
  });

  it('handles promise rejections', async () => {
    const app = new Hono();
    app.use('*', errorHandler);
    app.get('/test', async () => {
      await Promise.reject(new Error('Unauthorized promise rejection'));
    });

    const res = await app.request('/test');
    expect(res.status).toBe(401);
  });

  it('logs structured error data on console with stack + request_id', async () => {
    const app = new Hono();
    app.use('*', errorHandler);
    app.get('/test', () => {
      throw new Error('Internal database failure');
    });

    const spy = vi.spyOn(console, 'log');
    await app.request('/test');

    const logCalls = spy.mock.calls.map((c) => {
      try {
        return JSON.parse(c[0] as string);
      } catch {
        return null;
      }
    });
    const errorLog = logCalls.find(
      (l): l is Record<string, unknown> =>
        l !== null && (l as Record<string, unknown>).level === 'error'
    );

    expect(errorLog).toBeDefined();
    expect(errorLog!.message).toBe('Internal database failure');
    expect(errorLog!.code).toBe('internal_error');
    expect(errorLog!.path).toBe('/test');
    expect(errorLog!.method).toBe('GET');
    expect(errorLog!.timestamp).toBeDefined();
    // AC: stack trace logged at level=error with request_id
    expect(errorLog!.stack).toBeDefined();
    expect(typeof errorLog!.stack).toBe('string');
    expect((errorLog!.stack as string).length).toBeGreaterThan(0);
    expect(errorLog!.request_id).toBeDefined();
    expect(typeof errorLog!.request_id).toBe('string');
    expect((errorLog!.request_id as string).length).toBeGreaterThan(0);

    spy.mockRestore();
  });

  it('strips PII (phone, email, ICP, address) from logged message', async () => {
    const app = new Hono();
    app.use('*', errorHandler);
    app.get('/test', () => {
      throw new Error(
        'Failed for user phone +64 21 555 0123 email sam@example.com ICP 12345678 at 42 Lambton Quay'
      );
    });

    const spy = vi.spyOn(console, 'log');
    await app.request('/test');

    const logCalls = spy.mock.calls.map((c) => {
      try {
        return JSON.parse(c[0] as string);
      } catch {
        return null;
      }
    });
    const errorLog = logCalls.find(
      (l): l is Record<string, unknown> =>
        l !== null && (l as Record<string, unknown>).level === 'error'
    );

    expect(errorLog).toBeDefined();
    // AC: PII stripped from error.message before logging
    expect(errorLog!.message).toBe(
      'Failed for user phone [REDACTED] email [REDACTED] ICP [REDACTED] at [REDACTED]'
    );
    expect(errorLog!.message).not.toContain('+64 21 555 0123');
    expect(errorLog!.message).not.toContain('sam@example.com');
    expect(errorLog!.message).not.toContain('12345678');
    expect(errorLog!.message).not.toContain('42 Lambton Quay');

    spy.mockRestore();
  });

  it('uses c.get(requestId) when set by upstream middleware', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      (c as unknown as { set: (k: string, v: unknown) => void }).set(
        'requestId',
        'rid-fixed-123'
      );
      await next();
    });
    app.use('*', errorHandler);
    app.get('/test', () => {
      throw new Error('failure');
    });

    const spy = vi.spyOn(console, 'log');
    await app.request('/test');

    const logCalls = spy.mock.calls.map((c) => {
      try {
        return JSON.parse(c[0] as string);
      } catch {
        return null;
      }
    });
    const errorLog = logCalls.find(
      (l): l is Record<string, unknown> =>
        l !== null && (l as Record<string, unknown>).level === 'error'
    );

    expect(errorLog).toBeDefined();
    expect(errorLog!.request_id).toBe('rid-fixed-123');

    spy.mockRestore();
  });

  it('passes through non-error responses intact (e.g. 302 redirects)', async () => {
    const app = new Hono();
    app.use('*', errorHandler);
    app.get('/test', (c) => c.redirect('/other'));

    const res = await app.request('/test', { redirect: 'manual' });
    expect(res.status).toBe(302);
  });
});
