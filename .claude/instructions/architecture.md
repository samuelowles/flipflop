# Flip — Architecture Guardrails

## Service Module Pattern

Every external API must have its own service module. Route handlers never call external APIs directly.

```
workers/src/services/
├── messaging.ts      # Sent (sent.dm) unified WhatsApp + SMS API
├── deepseek.ts       # DeepSeek v4 Flash/Pro NLU routing
├── parser.ts         # Bill parser interface (invokes Python)
├── comparator.ts     # Plan comparison interface (invokes Python)
├── switchService.ts  # Switch lifecycle management
├── notification.ts   # Notification evaluation + dispatch
├── conversation.ts   # Conversation state machine (KV-backed)
└── emailPoller.ts    # Gmail/Outlook bill polling (Cron)
```

Service module responsibilities:
1. Wrapping the external API call (auth, headers, timeout)
2. Retry logic (exponential backoff, max 3 retries)
3. Error normalization (external errors → Flip error format)
4. Structured logging (API call, duration, status, sanitised context)

## Conversation State Machine

The state machine is KV-backed for sub-millisecond lookup. Never query D1 for conversation state on the hot path.

States: NEW → ONBOARDING → ACTIVE (free_tier | paid) → {AWAITING_BILL, AWAITING_SWITCH_CONFIRM, SWITCHING} | INACTIVE | UNSUBSCRIBED

Rules:
- Every state transition must be validated.
- Invalid transitions must be logged and rejected (don't silently fail).
- State is updated atomically in KV.
- The state machine is defined in a single module (`workers/src/services/conversation.ts`).
- Adding a state requires: enum entry, transition rules, valid commands, and tests.

## Queue Pipeline

Three queues handle async processing:

1. **flip-parse-queue**: Bill received → R2 store → enqueue → Python parse → D1 store → confirm
   - Max concurrency: 3
   - Target: <30 seconds receipt-to-confirmation

2. **flip-compare-queue**: Trigger (new bill, plan refresh, user request) → enqueue → Python compare → D1 store → notification eval
   - Max concurrency: 2
   - Target: <60 seconds for full recompute

3. **flip-notify-queue**: Comparison complete → threshold eval → enqueue → Sent message dispatch
   - Max concurrency: 5
   - Includes: cooldown check, deduplication, channel routing

Queue consumers are idempotent — reprocessing the same message must be safe.

## Data Flow Boundaries

- **Hot path (synchronous):** Webhook validation → KV state lookup → DeepSeek Flash intent → response/acknowledge. Target <2 seconds.
- **Warm path (async):** Bill parsing, plan comparison. Target <60 seconds.
- **Cold path (Cron):** EIEP14A refresh (daily 3am + 2pm NZT), email polling (daily), switch status checks (daily).

## DeepSeek Boundaries

What DeepSeek handles:
- Intent classification (help, usage, bill, compare, switch, status, stop, unknown)
- Entity extraction (retailer names, timeframes, amounts)
- Sentiment detection (confused, frustrated, uncertain)
- Multi-turn disambiguation
- Notification content generation
- Free-text command parsing

What DeepSeek must NEVER do:
- Calculate projected costs (Python comparator)
- Extract data from bill PDFs (Python parsers)
- Make switching recommendations (threshold logic)
- Store or learn from user bill data (no fine-tuning)

## Plan Data Sources

Primary: EIEP14A (Electricity Authority NZ standard). Daily refresh via Cron.
Fallback: Manual plan entry for retailers not on EIEP14A.
Cache: KV for hot reads, D1 for persistence.

## Directory Boundaries

- TypeScript stays in `workers/src/`. Python stays in `python/`.
- No cross-directory imports between workers and python.
- Workers invoke Python via queue messages (JSON payloads), not direct imports.
- Web portal (Cloudflare Pages) is separate: `pages/`. Minimal — OAuth connect + account management + legal only.
