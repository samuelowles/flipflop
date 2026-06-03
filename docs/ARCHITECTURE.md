# Flip -- Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER INTERFACE LAYER                            │
│                                                                             │
│   ┌──────────────┐                              ┌──────────────┐            │
│   │   WhatsApp   │                              │     SMS      │            │
│   │  (primary)   │                              │  (fallback)  │            │
│   └──────┬───────┘                              └──────┬───────┘            │
│          │                                             │                    │
└──────────┼─────────────────────────────────────────────┼────────────────────┘
           │                                             │
           ▼                                             ▼
    ┌──────────────────────────────────────────────────────────┐
    │                      SENT LAYER                           │
    │                   (sent.dm unified API)                   │
    │                                                          │
    │  ┌──────────────────────────────────────────────────┐    │
    │  │  Single API — automatic channel routing           │    │
    │  │  WhatsApp ───► sent.message() ───► fallback SMS   │    │
    │  │  Unified webhook for all inbound messages         │    │
    │  │  Template management + approval tracking          │    │
    │  └──────────────────────┬───────────────────────────┘    │
    └─────────────────────────┼────────────────────────────────┘
                              │
                              ▼
    ┌──────────────────────────────────────────────────────────┐
    │                   CLOUDFLARE WORKERS                      │
    │                   (Hono + TypeScript)                     │
    │                                                          │
    │  ┌──────────────────────────────────────────────────┐    │
    │  │              Route Handlers                       │    │
    │  │  POST /webhook/messaging     (Sent unified)       │    │
    │  │  POST /webhook/stripe        GET  /webhook/email/*│    │
    │  │  GET  /admin/*               GET  /health          │    │
    │  └──────────────────────────────────────────────────┘    │
    │                         │                                │
    │  ┌──────────────────────────────────────────────────┐    │
    │  │                  Services                         │    │
    │  │  messaging.ts      (Sent API, channel routing)     │    │
    │  │  conversation.ts   (state machine, KV-backed)      │    │
    │  │  parser.ts         (bill parser interface)         │    │
    │  │  comparator.ts     (plan comparison interface)     │    │
    │  │  switchService.ts  (switch lifecycle)              │    │
    │  │  notification.ts   (threshold eval + dispatch)     │    │
    │  │  emailPoller.ts    (Gmail/Outlook bill polling)    │    │
    │  │  deepseek.ts       (Flash/Pro NLU routing)         │    │
    │  └──────────────────────────────────────────────────┘    │
    └──────────────────────────────────────────────────────────┘
           │              │              │              │
           ▼              ▼              ▼              ▼
    ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
    │    D1    │  │  Queues  │  │    KV    │  │    R2    │
    │ (SQLite) │  │ (async)  │  │ (state)  │  │ (files)  │
    └──────────┘  └────┬─────┘  └──────────┘  └──────────┘
                       │
                       ▼
    ┌──────────────────────────────────────────────────────────┐
    │                   PYTHON ENGINE                           │
    │                                                          │
    │  ┌──────────────────┐    ┌──────────────────────────┐    │
    │  │  Bill Parsers    │    │  Plan Comparator          │    │
    │  │  (retailer-      │    │  (deterministic math)     │    │
    │  │   specific)      │    │  - usage profile in       │    │
    │  │  - contact.py    │    │  - available plans in     │    │
    │  │  - mercury.py    │    │  - ranked costs out       │    │
    │  │  - genesis.py    │    │  - confidence score       │    │
    │  │  - ...            │    │                          │    │
    │  └──────────────────┘    └──────────────────────────┘    │
    │                                                          │
    │  ┌──────────────────────────────────────────────────┐    │
    │  │  EIEP14A Ingestion                                │    │
    │  │  - fetch product data from Electricity Authority   │    │
    │  │  - validate + transform to plans table             │    │
    │  │  - daily refresh via Cron trigger                  │    │
    │  └──────────────────────────────────────────────────┘    │
    └──────────────────────────────────────────────────────────┘
           │
           ▼
    ┌──────────────────────────────────────────────────────────┐
    │                    EXTERNAL APIs                          │
    │                                                          │
    │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
    │  │ DeepSeek │  │  Gmail   │  │ Outlook  │  │  Stripe  │ │
    │  │  v4 API  │  │   API    │  │  Graph   │  │          │ │
    │  │ (NLU)    │  │ (email)  │  │ (email)  │  │ (billing)│ │
    │  └──────────┘  └──────────┘  └──────────┘  └──────────┘ │
    └──────────────────────────────────────────────────────────┘
```

## Data Flow: Bill Ingestion

1. User forwards bill (PDF or photo) via WhatsApp to Flip's number
2. Sent receives the message, POSTs webhook to `POST /webhook/messaging`
3. Worker validates Sent webhook signature
4. Worker downloads media from Sent, stores raw file in R2 (`bills/{user_id}/{timestamp}.{ext}`)
5. Worker creates bill record in D1 (status: `pending_parse`)
6. Worker enqueues parse job to `flip-parse-queue` with `{ bill_id, r2_key, retailer_hint }`
7. Queue consumer invokes Python bill parser: retailer-specific parser if retailer is known, generic fallback otherwise
8. Python parser extracts structured data, returns JSON: `{ retailer, plan_name, meter_type, icp_number, usage_kwh, days, total_cents, c_per_kwh, c_per_day, fixed_term_expiry, break_fee, confidence }`
9. Worker validates extracted data (sanity checks on value ranges)
10. Worker updates bill record in D1 (status: `parsed` or `needs_review` based on confidence)
11. Worker sends confirmation message to user via Sent:

   > "Got your Contact Energy bill. 847 kWh over 31 days, $212.34 total. That's 25.1 c/kWh + $0.90/day. I'll compare your plans now."

12. If `needs_review`: bill enters manual review queue; admin dashboard flag raised. User is NOT told about the review -- they see the normal confirmation.

## Data Flow: Plan Comparison

1. Trigger: new bill parsed successfully (status `parsed`) OR monthly Cron trigger OR plan data refreshed OR user requests "compare"
2. Worker fetches user's full usage history (last 12 months) from D1 `bills` table
3. Worker fetches all active plans for user's region from D1 `plans` table (populated from EIEP14A + manual entry)
4. Worker enqueues comparison job to `flip-compare-queue` with `{ user_id, bill_ids[], plan_ids[] }`
5. Queue consumer invokes Python plan comparator
6. Python comparator computes projected cost for each plan against actual usage, produces ranked list with savings vs current plan
7. Results stored in D1 `plan_comparisons` table: `(user_id, plan_id, projected_cost, current_cost, saving_cents, confidence, compared_at)`
8. Notification evaluation: if best non-current plan saves > user's threshold AND user hasn't been notified in the cooldown period, enqueue notification to `flip-notify-queue`
9. If notification triggered, worker sends proactive message via Sent. Sent's intelligent routing selects the optimal channel (WhatsApp first, SMS fallback):

   > "You could save ~$84 over the next 3 months by switching from Contact to Mercury. Based on your last 3 bills (winter usage). Want me to switch you?"

## Data Flow: Switching

1. User replies "switch me" or "yes" to a plan recommendation
2. Worker looks up the most recent comparison for this user (within 30 days)
3. Worker validates: target plan is still available, user's current plan hasn't changed, savings still above threshold
4. Worker fetches user's account details: ICP number, installation address, current retailer
5. Worker initiates switch: submits to target retailer's switching API (if available) or sends structured email to retailer's switching desk
6. Worker creates switch record in D1 (status: `requested`, `from_retailer_id`, `to_plan_id`)
7. Cron-triggered switch tracker checks switch status daily (polls retailer API or checks for confirmation email)
8. Worker sends status updates at milestones:
   - "Switch requested with Mercury. They'll confirm within 2 business days."
   - "Switch confirmed! Mercury takes over from [date]. Your final Contact bill will be sent to you directly."
   - "Switch complete. You're now with Mercury on their [Plan Name] plan. I'll keep watching your bills."
9. On completion: worker updates user's `current_plan_id` in D1, closes switch record

## Data Flow: Email Integration

1. User connects email via OAuth flow on minimal Cloudflare Pages portal (`flip.nz/connect`)
2. OAuth flow completes: Gmail (`gmail.readonly` scope) or Outlook (`Mail.Read` scope)
3. OAuth tokens stored encrypted in D1 `oauth_tokens` table (encrypted via WebCrypto API)
4. Cron-triggered worker (`emailPoller.ts`) runs daily for each connected user:
   - Refreshes OAuth token if needed
   - Searches for emails from known retailer domains (e.g., `@contactenergy.co.nz`, `@mercury.co.nz`)
   - Searches for emails matching power bill patterns in subject/body
   - Downloads matching email attachments (PDFs)
5. Found bills enter the same pipeline as manual forwarding: store in R2 → create bill record → enqueue parse
6. Backdating: all historical bills found are parsed, building up to 12 months of usage baseline
7. User notified: "I found 3 new bills from Contact Energy in your Gmail -- analyzing now."

## Conversation State Machine

```
                          ┌─────────────┐
                          │     NEW     │ (first ever message)
                          └──────┬──────┘
                                 │ user sends first message
                                 ▼
                          ┌─────────────┐
                          │ ONBOARDING  │ (awaiting first bill)
                          └──────┬──────┘
                                 │ first bill parsed
                                 ▼
                    ┌────────────────────────┐
                    │        ACTIVE          │◄──────────────────────────────┐
                    │  (monitoring, can be   │                               │
                    │   free_tier or paid)   │                               │
                    └───┬────┬────┬────┬─────┘                               │
                        │    │    │    │                                      │
           ┌────────────┘    │    │    └────────────┐                         │
           ▼                 │    │                 ▼                         │
    ┌────────────┐           │    │          ┌────────────┐                   │
    │ AWAITING   │           │    │          │ SWITCHING  │                   │
    │ _BILL      │           │    │          │ (in        │                   │
    │ (user said │           │    │          │  progress) │                   │
    │  they'd    │           │    │          └─────┬──────┘                   │
    │  send one) │           │    │                │ switch complete          │
    └─────┬──────┘           │    │                └──────────────────────────┘
          │ bill received    │    │
          └──────────────────┘    │
                                  │ user requests switch
                                  ▼
                           ┌──────────────────┐
                           │ AWAITING_SWITCH  │
                           │ _CONFIRM         │
                           │ (plan recommended,│
                           │  awaiting "yes")  │
                           └────┬─────────────┘
                                │ user confirms
                                └──────► SWITCHING

          ┌────────────┐                    ┌────────────┐
          │ INACTIVE   │ (no bills in       │ UNSUBSCRIBED│ (user texted
          │ (6+ months)│  6+ months)        │             │  "stop")
          └────────────┘                    └────────────┘
```

| State | Trigger Events | Valid User Commands |
|---|---|---|
| NEW | First inbound message | help, any greeting |
| ONBOARDING | Registration complete, awaiting bill | help, bill |
| ACTIVE | Bill parsed, monitoring | help, usage, bill, compare, switch, status, stop |
| AWAITING_BILL | User said they'd send a bill | bill, help, status |
| AWAITING_SWITCH_CONFIRM | Plan recommended | yes/switch me, no/stay, help |
| SWITCHING | Switch in progress | status, help, stop |
| INACTIVE | No bills in 6+ months | help, bill (re-activates) |
| UNSUBSCRIBED | User texted "stop" | help (can re-subscribe) |

## DeepSeek v4 Integration

DeepSeek v4 is used for natural language understanding -- interpreting what the user means from free-text WhatsApp/SMS messages. It is categorically NOT used for financial calculations or plan comparisons.

### Flash Model (real-time routing)

Used for every inbound message to classify intent. Runs in the Worker's request path, target latency <500ms.

```
User: "what am I paying right now"
Flash → { intent: "usage", confidence: 0.97, entities: { timeframe: "current" } }

User: "is genesis any good"
Flash → { intent: "compare", confidence: 0.82, entities: { retailer: "Genesis" } }

User: "nah that doesn't seem worth it"
Flash → { intent: "decline", confidence: 0.94 }

User: "yeah go on then"
Flash → { intent: "confirm_switch", confidence: 0.91 }
```

Intent taxonomy: `help`, `usage`, `bill`, `compare`, `switch`, `confirm_switch`, `decline`, `status`, `stop`, `unknown`

### Pro Model (complex disambiguation)

Used when Flash confidence is below threshold (<0.85) or when the conversation is multi-turn and needs context.

```
User: "that seems high"
  (Flash confidence 0.72 -- could mean usage, cost, or rate)
Pro → Clarify: "Are you saying your bill total seems high, or the rate per kWh? 
      Your current bill is $212. The average for similar households this month is $195."

User: "last winter was cheaper"
Pro → Context: "Your bills from last winter (Jun-Aug 2025) averaged $178/month. 
      This winter's bills so far average $201/month. That's about $23/month higher. 
      The difference is mostly usage -- you used 940 kWh in July 2026 vs 820 kWh in July 2025. 
      Your rate hasn't changed. Want me to check if another plan would help with higher winter usage?"
```

### What DeepSeek Does NOT Do

- Does NOT calculate projected costs (Python comparator does this)
- Does NOT extract data from bill PDFs (Python parsers do this)
- Does NOT make switching recommendations (threshold logic does this)
- Does NOT store or learn from user bill data (no fine-tuning on user data)

## Database Schema (D1)

### users
| Column | Type | Description |
|---|---|---|
| id | TEXT (UUID) | Primary key |
| phone | TEXT | NZ mobile number (unique) |
| sent_contact_id | TEXT | Sent contact ID |
| name | TEXT | User's preferred name |
| email | TEXT | For email integration |
| subscription_tier | TEXT | 'free' or 'paid' |
| stripe_customer_id | TEXT | Stripe customer reference |
| current_retailer_id | TEXT | FK → retailers |
| current_plan_name | TEXT | From most recent bill |
| icp_number | TEXT | Installation control point |
| installation_address | TEXT | Service address |
| notification_threshold_cents | INTEGER | Minimum saving to notify (default 5000 = $50) |
| state | TEXT | Conversation state machine state |
| created_at | TEXT | ISO 8601 |
| updated_at | TEXT | ISO 8601 |

### bills
| Column | Type | Description |
|---|---|---|
| id | TEXT (UUID) | Primary key |
| user_id | TEXT | FK → users |
| retailer_id | TEXT | FK → retailers (nullable until parsed) |
| plan_name | TEXT | From bill |
| meter_type | TEXT | standard, low_user, day_night, controlled |
| period_start | TEXT | Billing period start (ISO 8601) |
| period_end | TEXT | Billing period end |
| days | INTEGER | Days in billing period |
| usage_kwh | REAL | Total kWh |
| total_cents | INTEGER | Total bill in cents (NZD) |
| c_per_kwh | REAL | Effective rate |
| c_per_day | REAL | Fixed daily charge |
| fixed_term_expiry | TEXT | Contract end date (if applicable) |
| break_fee_cents | INTEGER | Break fee if switching early |
| status | TEXT | pending_parse, parsing, parsed, needs_review |
| confidence | REAL | Parser confidence (0-1) |
| raw_r2_key | TEXT | R2 key for original file |
| parsed_json | TEXT | Full parser output JSON |
| source | TEXT | whatsapp, sms, gmail, outlook |
| created_at | TEXT | ISO 8601 |

### retailers
| Column | Type | Description |
|---|---|---|
| id | TEXT (UUID) | Primary key |
| name | TEXT | Display name (e.g., "Contact Energy") |
| domain | TEXT | Email domain for bill detection |
| parser_id | TEXT | Python parser module name (e.g., "contact") |
| is_active | INTEGER | 0 or 1 |

### plans
| Column | Type | Description |
|---|---|---|
| id | TEXT (UUID) | Primary key |
| retailer_id | TEXT | FK → retailers |
| name | TEXT | Plan name |
| region | TEXT | NZ region(s) plan is available in |
| c_per_kwh | REAL | Standard variable rate |
| c_per_day | REAL | Standard daily charge |
| tier_thresholds_json | TEXT | Tiered pricing structure |
| prompt_payment_discount | REAL | Discount percentage |
| conditions_json | TEXT | Any conditional pricing |
| low_user_eligible | INTEGER | 0 or 1 |
| source | TEXT | eiep14a or manual |
| eiep14a_id | TEXT | EIEP14A plan identifier |
| effective_from | TEXT | ISO 8601 |
| effective_to | TEXT | ISO 8601 (null if current) |

### plan_comparisons
| Column | Type | Description |
|---|---|---|
| id | TEXT (UUID) | Primary key |
| user_id | TEXT | FK → users |
| plan_id | TEXT | FK → plans |
| bill_ids_json | TEXT | Bill IDs used for comparison |
| projected_cost_cents | INTEGER | What user would pay on this plan |
| current_cost_cents | INTEGER | What user paid on current plan |
| saving_cents | INTEGER | projected - current (negative = saving) |
| confidence | REAL | 0-1 based on data freshness/completeness |
| compared_at | TEXT | ISO 8601 |

### switches
| Column | Type | Description |
|---|---|---|
| id | TEXT (UUID) | Primary key |
| user_id | TEXT | FK → users |
| from_retailer_id | TEXT | FK → retailers |
| to_plan_id | TEXT | FK → plans |
| status | TEXT | requested, confirmed, in_progress, completed, failed |
| requested_at | TEXT | ISO 8601 |
| confirmed_at | TEXT | ISO 8601 |
| completed_at | TEXT | ISO 8601 |

### messages
| Column | Type | Description |
|---|---|---|
| id | TEXT (UUID) | Primary key |
| user_id | TEXT | FK → users |
| direction | TEXT | inbound or outbound |
| channel | TEXT | whatsapp or sms |
| body | TEXT | Message text |
| media_url | TEXT | Sent media URL (if any) |
| sent_message_id | TEXT | Sent message ID |
| intent | TEXT | Classified intent (if inbound) |
| created_at | TEXT | ISO 8601 |

### oauth_tokens
| Column | Type | Description |
|---|---|---|
| id | TEXT (UUID) | Primary key |
| user_id | TEXT | FK → users |
| provider | TEXT | gmail or outlook |
| access_token_encrypted | TEXT | Encrypted access token |
| refresh_token_encrypted | TEXT | Encrypted refresh token |
| expiry | TEXT | Token expiry (ISO 8601) |
| created_at | TEXT | ISO 8601 |

### notifications
| Column | Type | Description |
|---|---|---|
| id | TEXT (UUID) | Primary key |
| user_id | TEXT | FK → users |
| type | TEXT | saving_alert, stay_put, fixed_term_expiry, free_tier_checkin, switch_update |
| content_json | TEXT | Template variables |
| sent_at | TEXT | ISO 8601 |
| responded_at | TEXT | ISO 8601 (null if no response) |
| response | TEXT | user's response (if any) |

## Key Directories

```
Flip/
├── docs/                    # Project documentation
│   ├── PRD.md
│   ├── ARCHITECTURE.md
│   ├── AI_RULES.md
│   ├── PLAN.md
│   └── DEPLOY.md
├── workers/                 # Cloudflare Workers (TypeScript + Hono)
│   ├── src/
│   │   ├── index.ts         # Worker entry point, Hono router
│   │   ├── routes/
│   │   │   ├── messaging.ts  # POST /webhook/messaging (Sent unified)
│   │   │   ├── stripe.ts    # POST /webhook/stripe
│   │   │   ├── email.ts     # GET /webhook/email/gmail|outlook/callback
│   │   │   └── admin.ts     # Admin endpoints (manual review, health)
│   │   ├── services/
│   │   │   ├── messaging.ts      # Sent API (unified WhatsApp + SMS)
│   │   │   ├── parser.ts           # Bill parser interface (invokes Python)
│   │   │   ├── comparator.ts       # Plan comparison interface (invokes Python)
│   │   │   ├── switchService.ts    # Switch lifecycle management
│   │   │   ├── notification.ts     # Notification evaluation + dispatch
│   │   │   ├── conversation.ts     # Conversation state machine
│   │   │   ├── emailPoller.ts      # Gmail/Outlook bill polling (Cron)
│   │   │   └── deepseek.ts         # DeepSeek v4 Flash/Pro routing
│   │   ├── middleware/
│   │   │   ├── sentAuth.ts        # Sent webhook signature validation
│   │   │   ├── rateLimit.ts        # KV-based sliding window rate limiter
│   │   │   └── errorHandler.ts     # Global error boundary + structured logging
│   │   ├── models/          # D1 data access layer
│   │   │   ├── users.ts
│   │   │   ├── bills.ts
│   │   │   ├── plans.ts
│   │   │   ├── comparisons.ts
│   │   │   ├── switches.ts
│   │   │   └── messages.ts
│   │   └── types/           # TypeScript interfaces
│   ├── migrations/          # D1 schema migrations
│   │   └── 0001_initial.sql
│   ├── wrangler.toml
│   ├── tsconfig.json
│   └── package.json
├── python/                  # Bill parsing + plan comparison engine
│   ├── parsers/
│   │   ├── __init__.py
│   │   ├── base.py          # Base parser class + shared extraction logic
│   │   ├── contact.py
│   │   ├── mercury.py
│   │   ├── genesis.py
│   │   ├── meridian.py
│   │   ├── trustpower.py
│   │   ├── nova.py
│   │   ├── electric_kiwi.py
│   │   ├── powershop.py
│   │   ├── flick.py
│   │   └── pulse.py
│   ├── comparator/
│   │   ├── __init__.py
│   │   └── engine.py        # Deterministic plan comparison math
│   ├── eiep14a/
│   │   ├── __init__.py
│   │   └── ingest.py        # EIEP14A data fetch + validate + store
│   ├── tests/
│   │   ├── parsers/
│   │   │   └── test_contact.py
│   │   └── comparator/
│   │       └── test_engine.py
│   └── requirements.txt
├── pages/                   # Cloudflare Pages (minimal web portal)
│   └── src/
│       ├── connect/         # OAuth connection page (Gmail + Outlook buttons)
│       ├── account/         # Minimal account management
│       └── legal/           # Privacy Policy, Terms of Service
├── legal/                   # Legal documents (Privacy Policy, TOS)
│   ├── privacy.md
│   └── terms.md
└── .claude/                 # Claude Code settings
    └── settings.local.json
```
