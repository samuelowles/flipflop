import type { Context, Next } from 'hono';

// PII patterns stripped from error messages before logging.
// - phone: NZ/international phone numbers (with spaces, dashes, or parens)
// - email: standard email pattern
// - ICP: NZ Installation Control Point identifier (8-15 digit numeric)
// - address: numeric street address (e.g. "42 Lambton Quay")
const PII_PATTERNS: RegExp[] = [
  // phone: optional + then 8-15 digits/separators
  /\+?\d[\d\s\-()]{7,18}\d/g,
  /[\w.+-]+@[\w-]+\.[\w.-]+/g, // email
  /\b\d{8,15}\b/g, // ICP / long numeric ID
  /\b\d+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Quay)\b/g, // address
];

function stripPII(message: string): string {
  let stripped = message;
  for (const pattern of PII_PATTERNS) {
    stripped = stripped.replace(pattern, '[REDACTED]');
  }
  return stripped;
}

// Hono v4 internally catches route-handler errors before they propagate through
// await next() — the error is stored in c.error and the default error handler
// sets a 500 response. We check c.error after next() resolves and override the
// response with a structured error.
export async function errorHandler(c: Context, next: Next): Promise<Response | void> {
  await next();

  if (c.error) {
    const err = (c.error as { message?: string })?.message
      ? (c.error as Error)
      : new Error('Internal error');

    const requestId =
      (c.get('requestId') as string | undefined) ??
      (typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

    console.log(
      JSON.stringify({
        level: 'error',
        message: stripPII(err.message),
        code: mapErrorToCode(err),
        path: c.req.path,
        method: c.req.method,
        timestamp: new Date().toISOString(),
        request_id: requestId,
        stack: err.stack,
      })
    );

    const status = mapErrorToStatus(err);
    const body = mapErrorToResponseBody(err, status);

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

// Per AC: production 500 responses must be { error: 'internal_error' } with no internals leaked.
// For non-500 errors we surface a short, safe user-facing message.
function mapErrorToResponseBody(
  err: Error,
  status: number
): { error: string; code: string; status: number } {
  if (status === 500) {
    return { error: 'internal_error', code: 'internal_error', status: 500 };
  }
  return {
    error: mapErrorToUserMessage(err),
    code: mapErrorToCode(err),
    status,
  };
}

function mapErrorToUserMessage(err: Error): string {
  const status = mapErrorToStatus(err);
  if (status === 401) return 'Unauthorized.';
  return err.message;
}