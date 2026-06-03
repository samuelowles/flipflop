# Flip -- Deployment Checklist

## Prerequisites

- [ ] Cloudflare Workers paid plan ($5/month)
- [ ] Sent (sent.dm) account with API access
- [ ] Stripe account (standard, NZ-based)
- [ ] Google Cloud Project (for Gmail API OAuth)
- [ ] Microsoft Azure App Registration (for Outlook API OAuth)
- [ ] DeepSeek API key (v4 access)
- [ ] Domain registered and ready (flip.nz or alternative TLD)
- [ ] Python 3.12+ environment for bill parser development and testing

---

## Phase 1: Cloudflare Workers Foundation

### 1.1 Install Wrangler & Login
```bash
cd workers
npm install
npx wrangler login
```

### 1.2 Create D1 Database
```bash
npx wrangler d1 create flip-db
# Copy returned database_id → wrangler.toml [[d1_databases]].database_id
```

### 1.3 Create KV Namespace
```bash
npx wrangler kv:namespace create FLIP_KV
# Copy returned id → wrangler.toml [[kv_namespaces]].id
```

### 1.4 Create Queues
```bash
npx wrangler queues create flip-parse-queue
npx wrangler queues create flip-compare-queue
npx wrangler queues create flip-notify-queue
```

### 1.5 Create R2 Bucket
```bash
npx wrangler r2 bucket create flip-bills
```

### 1.6 Run Migrations
```bash
npx wrangler d1 migrations apply flip-db
```
- [ ] Verify all 9 tables created (users, bills, retailers, plans, plan_comparisons, switches, messages, oauth_tokens, notifications)
- [ ] Verify indexes on: users.phone, bills.user_id, bills.status, bills.created_at, plans.retailer_id, messages.user_id, messages.created_at

### 1.7 Set Secrets
```bash
npx wrangler secret put SENT_API_KEY
npx wrangler secret put SENT_WEBHOOK_SECRET
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put ENCRYPTION_KEY
npx wrangler secret put ADMIN_API_KEY
```
- [ ] `ENCRYPTION_KEY` is a 256-bit key (generate with `openssl rand -hex 32`)

### 1.8 Deploy Worker (Dev)
```bash
npx wrangler deploy
```
- [ ] Note the `workers.dev` URL: `https://flip-api.<subdomain>.workers.dev`

### 1.9 Verify Backend Health
```bash
curl https://flip-api.<subdomain>.workers.dev/
```
- [ ] Response: `{"status":"ok","service":"flip-api","version":"0.1.0"}`
- [ ] Worker dashboard shows no errors, 200 status

---

## Phase 2: Sent Setup

### 2.1 Create Sent Account
- [ ] Sign up at [sent.dm](https://www.sent.dm) and create a workspace
- [ ] Obtain API key from Sent dashboard → store as `SENT_API_KEY` secret (already set in 1.7)
- [ ] Note the webhook signing secret → store as `SENT_WEBHOOK_SECRET` (already set in 1.7)

### 2.2 WhatsApp Business API (via Sent)
Sent handles WhatsApp Business API onboarding and Meta verification as part of its platform. No separate messaging account or direct Meta Business verification is needed.
- [ ] Follow Sent's guided WhatsApp onboarding (business profile, phone number)
- [ ] Complete Meta business verification through Sent's workflow
- [ ] Configure webhook URL: `https://flip-api.<subdomain>.workers.dev/webhook/messaging`
- [ ] Sent automatically detects channel (WhatsApp or SMS) and routes inbound messages to this single webhook

### 2.3 SMS Setup (via Sent)
- [ ] Enable SMS channel in Sent dashboard (if not automatically provisioned)
- [ ] NZ SMS number provisioned automatically through Sent's carrier interconnects
- [ ] Verify SMS delivery: send test SMS to Flip's number → check Worker logs
- [ ] Verify automatic fallback: disable WhatsApp → send message → confirm SMS delivery

### 2.4 WhatsApp Template Messages (via Sent)
Sent handles template submission, approval tracking, and automatic resubmission on rejection. Templates work across both WhatsApp and SMS — the same template can send via SMS while WhatsApp approval is pending.

Submit these 6 templates through Sent's template manager:

- [ ] `bill_received`
  - Content: "Got your {{1}} bill. {{2}} kWh over {{3}} days, ${{4}}. I'll compare your plans now."
  - Variables: retailer name, usage kWh, days, total $

- [ ] `saving_alert`
  - Content: "You could save ~${{1}} over the next 3 months by switching from {{2}} to {{3}}. Based on your last {{4}} bills. Want me to switch you?"
  - Variables: saving amount, current retailer, recommended retailer, bill count

- [ ] `stay_put`
  - Content: "Good news -- you're still on the best plan for your usage. I'll keep watching and let you know if anything changes."

- [ ] `switch_update`
  - Content: "Switch update: your switch from {{1}} to {{2}} is {{3}}. Next: {{4}}."
  - Variables: from retailer, to retailer, status, next step

- [ ] `fixed_term_expiry`
  - Content: "Your fixed term with {{1}} ends on {{2}} ({{3}} days from now). I'll check what's available closer to the date. Break fee if you switched today: ${{4}}."
  - Variables: retailer, expiry date, days remaining, break fee

- [ ] `free_tier_checkin`
  - Content: "Your monthly check-in: {{1}}. Upgrade to Always On for $30/yr to get automatic alerts: {{2}}"
  - Variables: status summary, payment link

- [ ] Wait for Meta approval (Sent tracks status -- 1-4 weeks typical)
- [ ] SMS fallback active immediately: these same templates work via SMS while WhatsApp approval is pending
- [ ] Test each template in both WhatsApp and SMS before production use

---

## Phase 3: Stripe Setup

### 3.1 Product Configuration
- [ ] Create product in Stripe Dashboard: "Flip Always On"
- [ ] Set price: $30.00 NZD/year (recurring, annual)
- [ ] Note the price ID: `price_xxxxxxxxxxxxx`
- [ ] Create free tier product (no charge, for tracking in Stripe) -- optional

### 3.2 Webhook Configuration
- [ ] Create Stripe webhook endpoint: `https://flip-api.<subdomain>.workers.dev/webhook/stripe`
- [ ] Events to listen for:
  - [ ] `checkout.session.completed`
  - [ ] `customer.subscription.updated`
  - [ ] `customer.subscription.deleted`
  - [ ] `invoice.paid`
  - [ ] `invoice.payment_failed`
- [ ] Copy webhook signing secret → store as `STRIPE_WEBHOOK_SECRET` secret (already set in 1.7)

### 3.3 Payment Links
- [ ] Create payment link for $30/yr subscription
- [ ] Test payment flow end-to-end in Stripe test mode:
  - [ ] User clicks link → Stripe Checkout → payment succeeds → webhook fires → user tier upgraded to "paid"
  - [ ] Payment failure → webhook fires → user notified "payment didn't go through, link still active"
- [ ] Verify subscription lifecycle: create → renew → cancel → expire

---

## Phase 4: Email Integration Setup

### 4.1 Gmail API
- [ ] Create Google Cloud Project
- [ ] Enable Gmail API
- [ ] Configure OAuth consent screen (External, testing mode first)
- [ ] Scopes: `https://www.googleapis.com/auth/gmail.readonly` (read-only, no email modification)
- [ ] Create OAuth 2.0 client ID (Web application type)
- [ ] Add authorized redirect URI: `https://flip.nz/connect/gmail/callback` (use workers.dev URL for dev)
- [ ] Store credentials:
```bash
npx wrangler secret put GMAIL_CLIENT_ID
npx wrangler secret put GMAIL_CLIENT_SECRET
```

### 4.2 Outlook API
- [ ] Register app in Azure Active Directory (App registrations)
- [ ] Add Microsoft Graph API permission: `Mail.Read` (delegated)
- [ ] Create client secret (certificates & secrets)
- [ ] Add redirect URI: `https://flip.nz/connect/outlook/callback`
- [ ] Store credentials:
```bash
npx wrangler secret put OUTLOOK_CLIENT_ID
npx wrangler secret put OUTLOOK_CLIENT_SECRET
```

### 4.3 Cloudflare Pages Portal
- [ ] Create Pages project for `flip.nz`
- [ ] Pages to deploy:
  - [ ] `/connect` -- OAuth connection page with Gmail + Outlook buttons
  - [ ] `/connect/gmail/callback` -- Gmail OAuth callback handler
  - [ ] `/connect/outlook/callback` -- Outlook OAuth callback handler
  - [ ] `/account` -- Minimal account management (view, export, delete)
  - [ ] `/privacy` -- Privacy Policy
  - [ ] `/terms` -- Terms of Service
- [ ] Deploy:
```bash
cd pages
npx wrangler pages deploy
```
- [ ] Verify: all pages load over HTTPS, OAuth flows work end-to-end
- [ ] Cloudflare Turnstile on all web-facing pages

---

## Phase 5: Domain & DNS

### 5.1 Cloudflare DNS
- [ ] Register or transfer domain (flip.nz or alternative TLD)
- [ ] Add domain to Cloudflare
- [ ] Point nameservers to Cloudflare (if external registrar)
- [ ] Enable DNSSEC

### 5.2 Worker Routes
- [ ] Route `api.flip.nz/*` → `flip-api` worker
- [ ] Verify: `https://api.flip.nz/` returns health check response
- [ ] Verify: `https://flip-api.<subdomain>.workers.dev/` redirects or also works

### 5.3 Update Webhook URLs
After domain is live, update all webhook URLs from `workers.dev` to production domain:

- [ ] Sent messaging webhook → `https://api.flip.nz/webhook/messaging`
- [ ] Stripe webhook → `https://api.flip.nz/webhook/stripe`
- [ ] Gmail OAuth redirect URI → `https://flip.nz/connect/gmail/callback`
- [ ] Outlook OAuth redirect URI → `https://flip.nz/connect/outlook/callback`
- [ ] Verify all webhooks still work after URL change

---

## Phase 6: Pre-Launch Validation

### 6.1 End-to-End Flows
- [ ] **New user onboarding:** First message → greeting → send bill → parse → confirmation received
- [ ] **Plan comparison:** Parse triggers comparison → results stored → notification generated (if threshold met)
- [ ] **Switch flow:** User confirms "switch me" → switch initiated → status updates at each milestone → completion
- [ ] **Email integration:** OAuth connect → daily poll finds bill → bill ingested → backdated comparison updated
- [ ] **Free tier:** Monthly check-in sent on schedule. No Always On monitoring. No switch service. No email backdating.
- [ ] **Paid tier:** Always On monitoring active. Switch notifications sent. Email integration available.
- [ ] **Unsubscribe:** User texts "stop" → subscription cancelled → data deletion initiated → confirmation sent
- [ ] **Error handling:** Unsupported retailer → generic parser used → low confidence → manual review flag → user gets confirmation (NOT an error)
- [ ] **Rate limiting:** Rapid messages → appropriately throttled with friendly message ("I'm getting a lot of messages -- give me a moment")

### 6.2 Bill Parser Accuracy
Target accuracy rates for each retailer parser:

| Retailer | Target | Sample Size (min) |
|---|---|---|
| Contact Energy | >90% | 20 bills |
| Mercury | >90% | 20 bills |
| Genesis | >90% | 20 bills |
| Meridian | >85% | 15 bills |
| Trustpower | >85% | 15 bills |
| Nova | >80% | 10 bills |
| Electric Kiwi | >80% | 10 bills |
| Powershop | >80% | 10 bills |
| Flick | >80% | 10 bills |
| Pulse Energy | >80% | 10 bills |
| Generic fallback | >60% | 20 bills (mixed retailers) |

Accuracy defined as: extracted values within 1% of actual for total $, within 2% for c/kWh and c/day.

### 6.3 WhatsApp Template Approval
- [ ] All 6 template messages approved by Meta
- [ ] Template messages render correctly with variables in production
- [ ] 24-hour customer service window rules respected (no freeform messages outside window)
- [ ] Template fallback to SMS verified when WhatsApp delivery fails

### 6.4 Legal
- [ ] Privacy Policy live at `https://flip.nz/privacy`
- [ ] Terms of Service live at `https://flip.nz/terms`
- [ ] Both pages accessible without authentication
- [ ] Privacy Policy covers:
  - [ ] Data collected: phone number, name, email, power bills (PDFs/images), ICP number, address
  - [ ] Data usage: bill parsing, plan comparison, switch facilitation
  - [ ] Data storage: encrypted at rest, stored in Cloudflare D1 (NZ region if available) and R2
  - [ ] Data sharing: never sold, never shared with retailers without permission
  - [ ] Data deletion: user can request full deletion via "stop" command or account portal
  - [ ] Email access: read-only, scope-limited, OAuth tokens encrypted
  - [ ] Third-party processors: Cloudflare, Sent (sent.dm), Stripe, DeepSeek (API only -- no training on user data)
- [ ] Terms of Service covers:
  - [ ] "For information purposes only" -- savings are estimates, not guarantees
  - [ ] Flip is not a financial advisor
  - [ ] Switching: user authorises each switch; Flip facilitates but is not the retailer
  - [ ] NZ law governs
- [ ] NZ Privacy Act 2020 compliant:
  - [ ] Privacy Officer contact information listed
  - [ ] Data access and correction rights explained
  - [ ] Complaint process (Privacy Commissioner) referenced

### 6.5 Backend Monitoring
- [ ] Cloudflare Workers dashboard: request volume, error rate, CPU time, wall time
- [ ] D1 dashboard: query volume, read/write units, storage used, slow queries
- [ ] Queue dashboard: messages produced/consumed, backlog depth, oldest message age
- [ ] R2 dashboard: storage used, operations count
- [ ] Stripe dashboard: MRR, active subscriptions, churn rate, payment failures
- [ ] Sent dashboard: messages sent/delivered/failed, delivery rates, channel breakdown, fallback events
- [ ] Alert thresholds configured:
  - [ ] Worker error rate >5% (5-minute window)
  - [ ] Queue backlog >100 messages
  - [ ] Queue oldest message >10 minutes
  - [ ] D1 storage >80% of limit
  - [ ] Worker CPU time >50ms p95
  - [ ] Payment failure rate >10%

---

## Phase 7: Beta Launch

### 7.1 Beta User Onboarding
- [ ] 50 beta users recruited (personal network, NZ finance communities, word of mouth)
- [ ] Onboarding flow works for every user: first message → bill submission → parse → confirmation
- [ ] Mix of free tier (30) and paid tier (20) beta users
- [ ] Mix of retailers covered by the first 3-5 parsers
- [ ] Feedback channel: users can reply directly in WhatsApp/SMS (it IS the feedback channel)
- [ ] Known issue log maintained and shared with beta users

### 7.2 Beta Monitoring
- [ ] Daily: check bill parse accuracy across all beta user bills
- [ ] Daily: check notification quality -- are saving alerts accurate? Are "stay put" recommendations correct?
- [ ] Weekly: review switch requests -- did any complete? Did any fail? Why?
- [ ] Weekly: review unsubscribe rate and reasons
- [ ] Weekly: review DeepSeek intent classification accuracy (spot-check 20 conversations)
- [ ] Fix any parser issues, conversation flow gaps, or notification bugs within 48 hours

### 7.3 Post-Beta Iteration (2 Weeks)
- [ ] Address all parser accuracy issues found in beta (priority: retailers with most beta users)
- [ ] Tune saving notification threshold based on real user response ("switch me" rate vs "stay" rate)
- [ ] Polish message copy based on real user interactions (what confused people? what worked well?)
- [ ] Fix any state machine edge cases discovered in real conversations
- [ ] Add parsers for any retailers unexpectedly common among beta users
- [ ] Prepare for wider launch

---

## Phase 8: Full Launch

### 8.1 Launch Readiness
- [ ] All 10 retailer parsers at target accuracy (see §6.2)
- [ ] Minimum 5 successful real-world switches completed and verified
- [ ] WhatsApp template messages all approved and tested in production
- [ ] Email integration tested with real Gmail and Outlook accounts (minimum 3 each)
- [ ] Zero critical bugs (no data loss, no incorrect savings claims, no broken switch flows)
- [ ] All monitoring dashboards configured with alert thresholds (see §6.5)
- [ ] On-call plan documented: who responds to parser failures, queue backlogs, payment issues, and how

### 8.2 Launch Day
- [ ] Announce in NZ personal finance communities (Reddit r/PersonalFinanceNZ, Facebook groups)
- [ ] MoneyHub partnership announcement if secured
- [ ] Monitor all systems closely for the first 48 hours:
  - [ ] Worker error rate
  - [ ] Queue backlog (parse queue especially -- expect spike)
  - [ ] Bill parser accuracy (spot-check every parsed bill)
  - [ ] DeepSeek intent classification (spot-check conversations)
- [ ] Respond to all user messages within 1 hour during launch week

### 8.3 Post-Launch (First Month)
- [ ] Weekly accuracy audit on bill parsers (spot-check 20 random bills per week)
- [ ] Monthly plan data refresh: EIEP14A full re-ingestion + manual rate card updates
- [ ] User feedback collected and ranked by priority
- [ ] First subscription revenue tracked and reconciled against Stripe
- [ ] Cost monitoring: compute per-user cost (Sent per-contact fees, Worker CPU, D1 reads, DeepSeek API calls) and verify sustainability at scale

---

## Cost Summary

| Item | Monthly Cost | Annual Cost |
|---|---|---|
| Cloudflare Workers (paid plan) | $5.00 | $60.00 |
| Cloudflare Workers (usage -- requests + CPU) | ~$3.00 | ~$36.00 |
| Cloudflare D1 (storage + read/write units) | ~$1.00 | ~$12.00 |
| Cloudflare R2 (bill file storage) | ~$0.50 | ~$6.00 |
| Cloudflare Queues | Included in Workers | $0.00 |
| Cloudflare KV | Included in Workers | $0.00 |
| Sent (per-contact: ~100 contacts × $0.015/mo) | ~$1.50 | ~$18.00 |
| Sent carrier passthrough (WhatsApp + SMS delivery) | ~$10.00 | ~$120.00 |
| DeepSeek v4 API (Flash: ~5000 calls/mo, Pro: ~500 calls/mo) | ~$8.00 | ~$96.00 |
| Stripe (2.9% + $0.30 NZD per transaction) | ~$3.00 | ~$36.00 |
| Domain (flip.nz or alternative) | ~$2.00 | ~$24.00 |
| Python hosting (if external -- e.g., Fly.io) | ~$10.00 | ~$120.00 |
| **Total (estimated)** | **~$44.00/mo** | **~$528.00/yr** |

| Break-even | |
|---|---|
| **Users needed to break even** | **18 paying users** ($528 / $30) |
| **Month 6 target** | 500 total users, ~100 paying (~$3,000/yr revenue) |
| **Month 12 target** | 2,000 total users, ~400 paying (~$12,000/yr revenue) |

Note: These are early-stage estimates. Per-unit costs (Sent per-contact + carrier passthrough, DeepSeek per-token, D1 per-operation) will scale with usage. Python hosting cost is included as contingency -- Pyodide-in-Worker may eliminate this item.
