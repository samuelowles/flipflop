# Flip -- AI Rules

## Identity

You are building **Flip**, an interfaceless B2C SaaS product that monitors NZ residential power bills and proactively notifies users when switching power plans would save them real money. Flip communicates with customers exclusively via WhatsApp and SMS -- there is no mobile app, no web dashboard, no reactive interface.

Flip is NOT a comparison website. It is a passive monitoring agent. Its most important recommendation is often "stay where you are."

## Stack

- **Backend:** Cloudflare Workers (TypeScript strict mode), Hono router
- **Database:** Cloudflare D1 (SQLite-compatible)
- **Async Processing:** Cloudflare Queues
- **KV Storage:** Cloudflare Workers KV (conversation state, rate limiting, plan data cache)
- **Object Storage:** Cloudflare R2 (bill images, PDFs -- encrypted at rest)
- **Messaging:** Sent (sent.dm) — unified WhatsApp Business API + SMS via single API with automatic channel routing
- **NLU/Conversation:** DeepSeek v4 Flash (intent routing) + DeepSeek v4 Pro (complex disambiguation, notification content)
- **Bill Parsing:** Python (Pyodide in Worker or external container -- TBD)
- **Plan Comparison:** Python (deterministic arithmetic -- no AI)
- **Payments:** Stripe (subscription billing, payment links)
- **Email Integration:** Gmail API + Microsoft Graph API (OAuth 2.0, read-only scope)
- **Plan Data:** EIEP14A standard (Electricity Authority NZ)
- **Infrastructure:** Wrangler CLI for all Cloudflare deployment

## Coding Standards

- TypeScript strict mode always (`"strict": true` in tsconfig)
- No `any` types except at external API boundaries (prefer `unknown` and narrow with type guards)
- Functional programming style -- pure functions, immutable data, no classes unless there is a compelling reason
- All external API calls go through service modules -- never call `fetch` directly from route handlers
- Every route handler wraps its logic in try/catch with structured error responses
- Environment variables for all secrets, keys, and endpoints -- never hardcoded
- D1 queries use parameterized statements -- never string interpolation
- All dates stored as ISO 8601 strings (`2026-05-14T09:30:00+12:00`)
- All monetary values stored as integer cents (NZD) -- never floats for money
- Structured JSON logging via `console.log` -- Cloudflare captures this; log level configurable via env
- No AI/LLM calls for bill parsing or plan comparison -- those are deterministic Python algorithms

## Voice & Tone (User-Facing Messages)

- Casual, direct, helpful -- like a financially-savvy friend, not a utility company
- NZ English spelling and conventions: "analyse" not "analyze", "behaviour" not "behavior", "$" means NZD
- Never hyperbolic: "you could save about $42" not "you're throwing away $42 every month!"
- Never pushy: "would you like me to switch you?" not "switch now!"
- "Stay where you are" is celebrated, not apologised for -- it is a first-class outcome
- Numbers rounded to nearest dollar for readability; exact figures available on request
- All estimates qualified: "based on your last 3 bills", "this is an estimate, not a guarantee"
- No marketing language, no urgency inflation, no dark patterns
- Messages are transactional, not promotional -- respect the sanctity of WhatsApp/SMS as personal channels

## File Naming

- Workers source: camelCase (`messagingWebhook.ts`, `billParser.ts`, `switchService.ts`)
- Route files: lowercase matching the route (`messaging.ts`, `stripe.ts`)
- Service files: descriptive camelCase (`deepseek.ts`, `emailPoller.ts`, `notification.ts`)
- Python: snake_case (`contact_parser.py`, `plan_comparator.py`, `eiep14a_ingest.py`)
- Test files: `*.test.ts` (workers) or `*_test.py` (python)
- Migration files: `NNNN_descriptive_name.sql` (e.g., `0001_initial.sql`, `0002_add_notifications.sql`)
- No index files with barrels -- import directly from the module

## Project Structure Rules

- All TypeScript in `workers/src/`
- All Python in `python/`
- All D1 migrations in `workers/migrations/`
- All legal documents in `legal/`
- All project documentation in `docs/`
- Do not create loose files in the project root except `README.md`, `logs.md`, `bugs.md`
- `package.json` only in `workers/` -- the root is not a Node project unless configured as a workspace
- `requirements.txt` only in `python/`

## Security

- Sent webhook signature validation on every inbound message
- Stripe webhook signature validation on every event: verify `stripe.webhooks.constructEvent()`
- OAuth tokens (Gmail, Outlook) encrypted at rest in D1 using WebCrypto API (AES-256-GCM)
- User PII encrypted at rest: phone number, email, name, ICP number, installation address
- Encryption key stored as Cloudflare secret (`ENCRYPTION_KEY`) -- 256-bit, generated via `crypto.getRandomValues`
- Bill images/PDFs encrypted at rest in R2 (server-side encryption enabled)
- All API endpoints require authentication: Sent signature, Stripe signature, or admin API key
- Admin endpoints additionally protected by Cloudflare Access or IP allowlisting
- Rate limiting: KV-based sliding window on all public endpoints (100 req/min per user, 1000 req/min global)
- No user data in logs -- redact phone numbers, emails, ICP numbers from log output
- Cloudflare Turnstile on any web-facing pages (OAuth connect portal, account management)
- WhatsApp: no freeform outbound messages outside the 24-hour customer service window -- template messages only
- Secrets: stored via `wrangler secret put`, never committed to source control, never in .env files

## Performance

- Bill parsing: target <30 seconds from receipt to confirmation message (async via Queues)
- WhatsApp acknowledgment: respond within 2 seconds to acknowledge receipt; processing happens async
- Plan comparison: target <60 seconds for full recompute against all available plans
- DeepSeek Flash intent routing: target <500ms from message receipt to intent classification
- Conversation state: KV lookup for sub-millisecond state retrieval (no D1 query on the hot path)
- Plan data: cache EIEP14A data in KV, refresh daily via Cron trigger
- D1 queries: ensure indexes on `user_id`, `phone`, `status`, `created_at` columns
- Queue consumer concurrency: start at 3, tune based on load
- R2 object retrieval: use presigned URLs with short TTLs for any direct access (avoid proxying large files through Workers)

## DeepSeek v4 Rules

### Model Selection
- **Flash model:** Use for every inbound message's initial intent classification. Fast path -- must complete in <500ms. Temperature 0 for deterministic routing.
- **Pro model:** Use when Flash confidence is below 0.85, or when the user's message requires multi-turn context, complex disambiguation, or notification content generation. Acceptable latency up to 3 seconds.

### What DeepSeek Handles
- Intent classification from natural language (help, usage, bill, compare, switch, stop, status)
- Entity extraction (retailer names, timeframes, amounts)
- Sentiment detection (user seems confused, frustrated, or uncertain)
- Multi-turn disambiguation ("that seems high" → clarify meaning)
- Notification content generation (variable-rich template filling with natural language polish)
- Free-text command parsing ("can you check if Mercury would be cheaper for me now that I'm working from home")

### What DeepSeek Does NOT Handle
- Bill data extraction from PDFs/images (Python parsers)
- Plan cost calculations (Python comparator)
- Switch eligibility decisions (threshold logic in TypeScript)
- Payment processing (Stripe)
- Authentication (Sent/Stripe signature validation)

### Prompt Management
- All DeepSeek prompts are versioned in source control (`workers/src/services/prompts/`)
- Prompt changes require code review -- they are code, not configuration
- System prompts define Flip's voice, boundaries, and what the model must not do
- No user bill data is included in the system prompt -- only passed in the specific request context

### Audit
- Every LLM call logged: `{ timestamp, model (flash|pro), intent_result, latency_ms, confidence, prompt_version }`
- No user bill data in LLM logs -- log the intent and confidence, not the full message text
- Prompt + response pairs retained for 30 days for debugging, then purged
- No fine-tuning on user data -- DeepSeek is used as a zero-shot classifier

## Testing

- Every Cloudflare Worker route must have an integration test (Wrangler `--test` or Vitest with `miniflare`)
- Python bill parsers must have unit tests with real (anonymised) sample PDFs for each retailer
- Plan comparator must have deterministic tests with known inputs and expected outputs
- Conversation state machine must be exhaustively tested -- every valid transition, invalid transitions rejected
- DeepSeek integration: mock the API for unit tests; integration tests use a test API key
- Before deploying: run full test suite; zero failures required
- Test coverage target: 80%+ on workers TypeScript, 90%+ on Python parsers and comparator

## What NOT to Build

- No AI/LLM-based bill parsing -- deterministic Python parsers only
- No AI/LLM-based plan recommendations -- mathematical comparison only
- No web dashboard or full web application (just the minimal Cloudflare Pages portal for OAuth, account, legal)
- No mobile app (iOS or Android)
- No comparison website or on-demand comparison tool
- No scraping of Billy (Electricity Authority), Powerswitch (Consumer NZ), or any retailer website
- No scraping of retailer pricing pages -- use EIEP14A or public rate cards only

<!-- #66 TEMPORARY OVERRIDE (approved 2026-06-19): Powerswitch plan-listing scrape.
     Scope: public plan-listing pages on https://www.powerswitch.org.nz ONLY.
     Zero PII submitted (no ICP, address, or user data). Gated behind
     POWERSWITCH_SCRAPER_ENABLED (defaults false — ships INERT).
     Why: the EIEP14A feed (#64) is not available until October 2026 and
     Powerswitch is the temporary live plan-data path.
     Sunset trigger: set POWERSWITCH_SCRAPER_ENABLED="false" and remove the
     bridge module (workers/src/services/powerswitchScraper.ts) + its cron
     branch once #64 is live AND EIEP14A coverage is sufficient.
     The original no-scraping rules above REMAIN IN FORCE for all other sources. -->
- No discount code repository or promotional deals
- No marketing messages or promotional content via WhatsApp/SMS
- No "recommended" or "sponsored" plan rankings
- No pay-to-rank, no hidden steering, no dark patterns
- No switching for switching's sake -- "stay where you are" is always a valid outcome
- No sharing, selling, or monetising user bill data
