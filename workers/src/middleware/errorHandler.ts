import type { Context, Next } from 'hono';

interface StructuredError {
  readonly error: string;
  readonly code: string;
  readonly status: number;
}

// Hono v4 internally catches route-handler errors before they propagate through
// await next() — the error is stored in c.error and the default error handler
// sets a 500 response. We check c.error after next() resolves and override the
// response with a structured error.
export async function errorHandler(c: Context, next: Next): Promise<Response | void> {
  await next();

  if (c.error) {
    const err = (c.error as { message?: string })?.message
      ? c.error as Error
      : new Error('Internal error');

    console.log(JSON.stringify({
      level: 'error',
      message: err.message,
      code: mapErrorToCode(err),
      path: c.req.path,
      method: c.req.method,
      timestamp: new Date().toISOString(),
    }));

    const status = mapErrorToStatus(err);
    const body: StructuredError = {
      error: mapErrorToUserMessage(err),
      code: mapErrorToCode(err),
      status,
    };

    c.res = new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

function mapErrorToStatus(err: Error): number {
  const msg = err.message.toLowerCase();
  if (msg.includes('not found')) return 404;
  if (msg.includes('validation') || msg.includes('invalid')) return 400;
  if (msg.includes('unauthorized')) return 401;
  if (msg.includes('rate limit') || msg.includes('too many')) return 429;
  return 500;
}

function mapErrorToCode(err: Error): string {
  const msg = err.message.toLowerCase();
  if (msg.includes('not found')) return 'not_found';
  if (msg.includes('validation') || msg.includes('invalid')) return 'validation_error';
  if (msg.includes('unauthorized')) return 'unauthorized';
  if (msg.includes('rate limit') || msg.includes('too many')) return 'rate_limited';
  return 'internal_error';
}

function mapErrorToUserMessage(err: Error): string {
  const status = mapErrorToStatus(err);
  if (status === 500) return 'Something went wrong. Please try again later.';
  if (status === 401) return 'Unauthorized.';
  return err.message;
}
