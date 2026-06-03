# Flip — Security Requirements

## Webhook Validation (Critical)

### Sent Webhook
- Every inbound message to `POST /webhook/messaging` must validate the Sent signature.
- Use the Sent webhook secret stored in Cloudflare secrets (`SENT_WEBHOOK_SECRET`).
- Reject with 401 if signature is missing or invalid.
- This is the first check in the route handler — before any processing.

### Stripe Webhook
- Every Stripe event must be verified via `stripe.webhooks.constructEvent()`.
- Use `STRIPE_WEBHOOK_SECRET` from Cloudflare secrets.
- Reject with 400 if signature is invalid (Stripe expects 400 for bad signatures).
- Never trust `event.type` from an unverified payload.

## Encryption at Rest

### User PII
The following fields MUST be encrypted before writing to D1:
- `users.phone` (NZ mobile number)
- `users.email`
- `users.name`
- `users.icp_number` (Installation Control Point — uniquely identifies a property)
- `users.installation_address`

Encryption: AES-256-GCM via WebCrypto API.
Key: `ENCRYPTION_KEY` — 256-bit, stored via `wrangler secret put`, never in source control.
Key generation: `crypto.getRandomValues(new Uint8Array(32))` → hex-encoded.

### OAuth Tokens
- `oauth_tokens.access_token_encrypted` and `oauth_tokens.refresh_token_encrypted` must be encrypted.
- Same encryption scheme as PII (AES-256-GCM).
- Tokens must be refreshed before expiry. Handle refresh token rotation.

### R2 Bill Files
- Server-side encryption enabled on the `flip-bills` bucket.
- Presigned URLs for direct access must have short TTLs (max 5 minutes).
- Never proxy large bill files through Workers.

## Rate Limiting

- KV-based sliding window rate limiter on all public endpoints.
- Limits: 100 requests/minute per user (by phone number or IP), 1000 requests/minute global.
- Rate limit middleware runs after webhook validation, before route handler logic.
- Return 429 with a Retry-After header when limit is exceeded.

## Authentication

- All API endpoints require authentication: Sent signature, Stripe signature, or Admin API key.
- Admin endpoints (`/admin/*`) additionally protected by Cloudflare Access or IP allowlisting.
- `ADMIN_API_KEY` stored as Cloudflare secret.
- Cloudflare Turnstile on all web-facing Pages (OAuth connect, account management).

## Logging Security

- Never log: phone numbers, emails, ICP numbers, names, addresses, access tokens, bill contents.
- Redact PII from log output before `console.log`. Use a sanitize utility.
- LLM audit logs: log intent + confidence, NOT the full message text.
- Prompt + response pairs retained max 30 days, then purged.

## Secrets Management

All secrets via `wrangler secret put`:

| Secret | Purpose | Length/Bits |
|--------|---------|-------------|
| `SENT_API_KEY` | Sent API authentication | Provider-issued |
| `SENT_WEBHOOK_SECRET` | Sent webhook HMAC validation | Provider-issued |
| `DEEPSEEK_API_KEY` | DeepSeek v4 API (via OpenRouter) | Provider-issued |
| `STRIPE_SECRET_KEY` | Stripe API server-side key | Provider-issued |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signature | Provider-issued |
| `ENCRYPTION_KEY` | AES-256-GCM PII encryption | 256-bit, self-generated |
| `ADMIN_API_KEY` | Admin endpoint access | Self-generated |

Never store secrets in: source control, .env files, wrangler.toml (use secret references), or any committed file.

## WhatsApp Compliance

- No freeform outbound messages outside the 24-hour customer service window.
- Template messages only for proactive outreach (saving alerts, check-ins, switch updates).
- All 6 templates must be approved by Meta before production use.
- Template content must follow Flip's voice & tone rules.

## NZ Privacy Act 2020

- Data minimization: only collect what's needed for bill monitoring and comparison.
- User consent: record when and how consent was given (first message = implicit consent to monitor).
- Right to access: user can request all their data via text ("what data do you have on me").
- Right to delete: user can request deletion via text ("delete my data"). Full account + data purge.
- No data sold, shared, or monetised — ever.
- Privacy Policy must be accessible at `flip.nz/privacy`.

## Build-Time Checks

Before every deploy, verify:
- [ ] All secrets present via `wrangler secret list`
- [ ] Encryption key is 256-bit (64 hex chars)
- [ ] R2 bucket encryption enabled
- [ ] D1 queries are parameterized (no string interpolation found by grep)
- [ ] No PII in console.log calls (grep for phone/email patterns in log statements)
- [ ] Rate limit middleware on all public routes
- [ ] Webhook signature validation on both Sent and Stripe routes
