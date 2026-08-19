# Flip -- Execution Plan

## Current Status: Pre-Phase 1 (Greenfield)

The project directory contains only a `.claude/` configuration directory and the `docs/` folder being populated now. No code exists yet. No git repository is initialised. This is a true greenfield start.

## What to Build

### Phase 1: Core Infrastructure (Weeks 1-2)

- Cloudflare Workers project scaffolded with Hono + TypeScript strict
- D1 database created with initial schema (all 9 tables from ARCHITECTURE.md)
- KV namespace provisioned for conversation state + rate limiting
- Queues created: `flip-parse-queue`, `flip-compare-queue`, `flip-notify-queue`
- Sent (sent.dm) unified messaging webhook receiving and validating inbound messages (WhatsApp + SMS via single endpoint)
- Conversation state machine implemented (KV-backed, all states and transitions)
- Basic message routing: user texts "help" → responds with available commands
- DeepSeek v4 Flash integration: intent classification on every inbound message
- Wrangler deploy to `workers.dev` for dev testing
- Health check endpoint returning `{"status":"ok","service":"flip-api","version":"0.1.0"}`

### Phase 2: Bill Ingestion & Parsing (Weeks 3-5)

- WhatsApp media handling: receive PDF/image via Sent, store in R2
- Python bill parser for Contact Energy (highest market share in NZ)
- Python bill parser for Mercury
- Python bill parser for Genesis
- Queue-based async parsing pipeline: R2 storage → enqueue → Python parse → D1 store
- Parsed data stored in D1 `bills` table with all structured fields
- Confirmation message flow: user gets summary after parse completes
- Manual review queue for low-confidence parses (admin dashboard flag)
- Generic fallback parser using layout heuristics (flagged for manual review)
- Parser validation: sanity-checks extracted values against known NZ ranges

### Phase 3: Plan Comparison Engine (Weeks 6-8)

- EIEP14A data ingestion pipeline: fetch from Electricity Authority, validate, transform, store in D1 `plans` table
- Manual plan data entry workflow for non-EIEP14A retailers
- Python plan comparator: usage profile in, available plans in, ranked costs out
- Deterministic arithmetic: handles tiered pricing, daily charges, prompt payment discounts, low-user plans
- Comparison results stored in D1 `plan_comparisons` table
- Confidence scoring: based on bill data freshness, plan data age, pricing completeness
- Python bill parsers for Meridian and Trustpower
- Daily Cron trigger for EIEP14A refresh + plan data cache in KV

### Phase 4: Notification & Switching (Weeks 9-11)

- Notification evaluation logic: saving threshold check, cooldown period, deduplication
- "Stay where you are" notification type (equal priority to saving alerts)
- WhatsApp template message creation and Meta submission (6 templates from PRD §7.7)
- Proactive notification dispatch via `flip-notify-queue`
- Free tier: monthly check-in logic ("you're still fine" / "likely better plan" / "not worth it" / "wait until X")
- Switching: user confirms via text → switch initiated → status tracking → completion
- Switch status tracker: Cron-triggered daily poll for switch progress
- User status updates at switch milestones
- Python bill parsers for Nova and Electric Kiwi

### Phase 5: Email Integration (Weeks 12-14)

- Gmail OAuth 2.0 flow: minimal Cloudflare Pages portal at `flip.nz/connect`
- Gmail API: `gmail.readonly` scope, bill detection by sender domain + subject patterns
- Gmail bill polling: daily Cron-triggered scan for new power bill emails
- Outlook OAuth 2.0 flow: Microsoft Graph API, `Mail.Read` delegated scope
- Outlook bill polling: same daily Cron pattern as Gmail
- Historical bill backdating: up to 12 months of bills ingested from email
- Email-discovered bills enter the same pipeline as manual forwarding (R2 → parse → compare)
- OAuth token encryption at rest + refresh token rotation
- Python bill parsers for Powershop, Flick, and Pulse Energy

### Phase 6: Monetization (Weeks 15-16)

- Stripe product and price configuration: $30 NZD/year, "Flip Always On"
- Stripe webhook handler: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`
- Payment link generation: sent via WhatsApp/SMS when free user requests upgrade
- Subscription tier gating: Always On monitoring + switch service + email backdating restricted to paid users
- Free tier: monthly check-in only, no proactive monitoring, no switch service, no email integration
- Switching fee disclosure: if a retailer pays a referral fee, disclosed per-switch ("Flip may receive $X")
- Stripe test mode: full payment flow tested end-to-end before go-live

### Phase 7: Polish & Launch (Weeks 17-18)

- WhatsApp template messages approved by Meta (all 6 templates)
- Full test suite passing: Workers integration tests + Python parser unit tests + comparator tests + state machine tests
- Bill parser accuracy audit across all 10 supported retailers (target >80% per retailer)
- Switch flow tested end-to-end with real retailers (minimum 5 successful switches)
- NZ Privacy Act 2020 compliance review
- Legal documents live: Privacy Policy (`flip.nz/privacy`), Terms of Service (`flip.nz/terms`)
- Beta user onboarding: 50 users recruited from personal network + NZ finance communities
- Monitoring dashboards configured: Workers, D1, Queues, Stripe, Sent
- Alert thresholds set: Worker errors >5%, Queue backlog >100, D1 storage >80%

## Next Steps

### 1. Scaffold Cloudflare Workers Project
```bash
mkdir -p workers
cd workers
npm create cloudflare@latest flip-workers -- --type hello-world
cd flip-workers
npm install hono
```

### 2. Create D1 Database
```bash
cd workers
npx wrangler d1 create flip-db
```

### 3. Create KV Namespace
```bash
npx wrangler kv:namespace create FLIP_KV
```

### 4. Create Queues
```bash
npx wrangler queues create flip-parse-queue
npx wrangler queues create flip-compare-queue
npx wrangler queues create flip-notify-queue
```

### 5. Create R2 Bucket
```bash
npx wrangler r2 bucket create flip-bills
```

### 6. Configure wrangler.toml
```toml
name = "flip-api"
main = "src/index.ts"
compatibility_date = "2026-05-14"

[[d1_databases]]
binding = "DB"
database_name = "flip-db"
database_id = "<from-step-2>"

[[kv_namespaces]]
binding = "KV"
id = "<from-step-3>"

[[queues.producers]]
binding = "PARSE_QUEUE"
queue = "flip-parse-queue"

[[queues.producers]]
binding = "COMPARE_QUEUE"
queue = "flip-compare-queue"

[[queues.producers]]
binding = "NOTIFY_QUEUE"
queue = "flip-notify-queue"

[[queues.consumers]]
queue = "flip-parse-queue"
max_batch_size = 1
max_concurrency = 3

[[queues.consumers]]
queue = "flip-compare-queue"
max_batch_size = 1
max_concurrency = 2

[[queues.consumers]]
queue = "flip-notify-queue"
max_batch_size = 1
max_concurrency = 5

[[r2_buckets]]
binding = "BILLS"
bucket_name = "flip-bills"

[triggers]
crons = ["0 3 * * *", "0 14 * * *"]  # Daily EIEP14A refresh (3am + 2pm NZT)
```

### 7. Set Up Secrets
```bash
npx wrangler secret put SENT_API_KEY
npx wrangler secret put SENT_WEBHOOK_SECRET
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put ENCRYPTION_KEY
npx wrangler secret put ADMIN_API_KEY
```

### 8. Deploy + Verify
```bash
npx wrangler deploy
curl https://flip-api.<subdomain>.workers.dev/
# Expected: {"status":"ok","service":"flip-api","version":"0.1.0"}
```

## Key Decisions (To Be Made)

### 1. Python Deployment Strategy
**Options:** Pyodide in Cloudflare Worker vs external container (Fly.io, Railway, or similar)

- **Pyodide:** Single deploy target, no separate infra, simpler ops. But: limited Python package support (no native C extensions), cold start overhead, memory constraints
- **External container:** Full Python ecosystem, any library, easier to test locally. But: second deploy target, network latency between Worker and Python service, additional cost
- **Recommendation:** Start with Pyodide for the MVP (first 3 parsers). Test cold start and memory behaviour. Migrate to external container only if Pyodide proves inadequate.

### 2. WhatsApp Business Approval Timeline
Meta's WhatsApp Business verification and template message approval can take 1-4 weeks. This is on the critical path for launch.

- Build and test the SMS path as a fully functional fallback for ALL critical flows
- Submit template messages for approval early in Phase 4 (not at the end)
- If approval is delayed, launch beta via SMS only, add WhatsApp when approved

### 3. EIEP14A Data Reliability
The Electricity Authority's EIEP14A product data standard is emerging. Coverage and reliability are unknown.

- Audit the feed early in Phase 3 -- how many retailers? How complete is the pricing data? How often is it updated?
- Plan for manual entry of retailer plans as a parallel data source
- If EIEP14A coverage is poor at launch, build the manual plan entry tool first, EIEP14A second

### 4. User Acquisition Channel
Flip has no app store presence and no SEO-optimised content website. Primary growth mechanism needs definition.

- **Candidate channels:** NZ personal finance Reddit (r/PersonalFinanceNZ), Facebook groups, MoneyHub partnership/referral, word of mouth ("share with a friend who overpays"), Pocketsmith/budgeting app integrations
- **Decision needed before Phase 7:** What is the primary acquisition motion? How do the first 50 beta users find Flip? How do the first 500 users find it?
