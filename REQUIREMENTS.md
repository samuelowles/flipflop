# Flip — Project Requirements

> Extracted from previous `.claude/CLAUDE.md`. This is the working requirements document for Flip.

## Identity

You are building **Flip**, an interfaceless B2C SaaS that monitors NZ residential power bills and proactively notifies users via WhatsApp/SMS when switching plans would save them real money. Flip is NOT a comparison website. Its most important recommendation is often "stay where you are."

## Stack

- **Runtime:** Cloudflare Workers (TypeScript strict, Hono router)
- **Database:** Cloudflare D1 (SQLite-compatible)
- **Async:** Cloudflare Queues (flip-parse-queue, flip-compare-queue, flip-notify-queue)
- **KV:** Conversation state, rate limiting, plan data cache
- **R2:** Encrypted bill images/PDFs
- **Messaging:** Sent (sent.dm) unified WhatsApp + SMS API
- **NLU:** DeepSeek v4 Flash (intent classification, <500ms) + Pro (complex disambiguation)
- **Bill Parsing:** Python (deterministic — NO AI/LLM)
- **Plan Comparison:** Python (deterministic arithmetic — NO AI/LLM)
- **Payments:** Stripe ($30 NZD/year "Always On" subscription)
- **Email:** Gmail API + Microsoft Graph API (OAuth 2.0, read-only)

## Coding Standards

- TypeScript strict mode always (`"strict": true`). No `any` — prefer `unknown` and narrow with type guards.
- Functional programming style — pure functions, immutable data. No classes unless compelling reason.
- All external API calls go through service modules — never `fetch` directly from route handlers.
- D1 queries use parameterized statements — never string interpolation.
- All dates: ISO 8601 strings (`2026-05-14T09:30:00+12:00`).
- All monetary values: **integer cents (NZD)** — never floats for money.
- Structured JSON logging via `console.log`.
- Route handlers wrap logic in try/catch with structured error responses.
- Secrets via `wrangler secret put` — never in source control.

## File Naming

- Workers source: camelCase (`messagingWebhook.ts`, `switchService.ts`)
- Route files: lowercase matching route (`messaging.ts`, `stripe.ts`)
- Python: snake_case (`contact_parser.py`, `plan_comparator.py`)
- Tests: `*.test.ts` (workers) or `*_test.py` (python)
- Migrations: `NNNN_descriptive_name.sql` (e.g., `0001_initial.sql`)
- No barrel/index files — import directly from the module.

## Project Structure

- All TypeScript in `workers/src/`
- All Python in `python/`
- All D1 migrations in `workers/migrations/`
- All docs in `docs/`
- All legal in `legal/`
- `package.json` only in `workers/`
- `requirements.txt` only in `python/`
- No loose files in project root except `README.md`, `logs.md`, `bugs.md`

## Architecture Rules

- Conversation state machine is KV-backed — no D1 query on the hot path.
- Bill parsing is async via Queues: R2 store → enqueue → Python parse → D1 store → confirm.
- DeepSeek Flash runs in the request path (target <500ms). Pro is for low-confidence fallback.
- DeepSeek NEVER does financial calculations. NEVER extracts bill data. NEVER makes switching decisions.
- Acknowledge WhatsApp messages within 2 seconds. Processing happens async.
- "Stay where you are" is a first-class outcome with equal priority to saving alerts.

## Voice & Tone (User-Facing)

- Casual, direct, helpful — like a financially-savvy friend. NZ English throughout.
- Never hyperbolic, never pushy. "You could save about $42" not "You're throwing away $42!"
- "Stay where you are" is celebrated, not apologised for.
- Numbers rounded to nearest dollar for readability.
- All estimates qualified: "based on your last 3 bills", "this is an estimate, not a guarantee".
- Transactional, not promotional — respect WhatsApp/SMS as personal channels.

## Security (Critical)

- Sent webhook signature validation on every inbound message.
- Stripe webhook signature validation on every event.
- PII encrypted at rest: phone, email, name, ICP number, installation address (AES-256-GCM via WebCrypto).
- OAuth tokens encrypted at rest in D1.
- R2 server-side encryption enabled for all bill files.
- Rate limiting: KV-based sliding window (100 req/min per user, 1000 req/min global).
- No user data in logs — redact phone numbers, emails, ICP numbers.
- `ENCRYPTION_KEY` is a 256-bit secret via `wrangler secret put`.

## Testing Requirements

- Every Worker route: integration test (Vitest + miniflare).
- Every Python parser: unit tests with real anonymised sample PDFs.
- Plan comparator: deterministic tests with known inputs/outputs.
- State machine: exhaustive test of every valid transition plus rejection of invalid ones.
- DeepSeek: mocked for unit tests, test API key for integration tests.
- Coverage targets: 80%+ TypeScript, 90%+ Python parsers and comparator.
- Zero failing tests before deploy.

## What NOT to Build

- No AI/LLM-based bill parsing or plan recommendations.
- No web dashboard or full web application (minimal Cloudflare Pages portal only).
- No mobile app (iOS or Android).
- No comparison website or on-demand comparison tool.
- No scraping of retailer websites, Billy, or Powerswitch.
- No discount codes or promotional deals.
- No pay-to-rank, sponsored rankings, or data monetisation.
- No marketing messages via WhatsApp/SMS.

## Current Phase

**Phase 1 (Weeks 1-2): Core Infrastructure**
- Scaffold Cloudflare Workers + Hono + TypeScript strict
- D1 database with initial schema (all 9 tables)
- KV namespace, Queues (3), R2 bucket
- Sent unified messaging webhook
- Conversation state machine (KV-backed)
- DeepSeek Flash intent classification
- Health endpoint + wrangler deploy to workers.dev

See `docs/PLAN.md` for full 7-phase plan. See `docs/ARCHITECTURE.md` for data flows and schema. See `docs/AI_RULES.md` for detailed rules.

## Ruflo Agent Usage

This project is built using ruflo agents. When spawning agents:
- Use `.claude/agents/coder.json` for TypeScript/Workers code
- Use `.claude/agents/python-dev.json` for Python bill parsers
- Use `.claude/agents/reviewer.json` for code review and AI_RULES compliance
- Use `.claude/agents/tester.json` for test creation and coverage
- Use `.claude/agents/security-auditor.json` for security and privacy review
