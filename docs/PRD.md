# Flip -- Product Requirements Document

## 1. Executive Summary

Flip is an interfaceless B2C SaaS product that monitors NZ residential power bills and proactively notifies users when switching power plans would save them real money. Flip communicates with customers exclusively via WhatsApp and SMS -- there is no mobile app, no web dashboard, no reactive interface.

The core insight is that existing NZ comparison tools (Billy, Powerswitch) are episodic: the user must remember to check, manually enter details, and evaluate options themselves. Flip changes the job from "help me compare power plans when I remember to ask" to "watch my regular costs, tell me when something material has changed, and bring me a low-friction action when it is worth doing." This is closer to a household cost intelligence layer than a price comparison website.

Flip is NOT a comparison site. It is NOT a repository for discount codes. It is NOT a marketing channel for power companies. It is NOT a portal for consumers to switch on-demand. Its most important recommendation is often "stay where you are."

## 2. Target Audience

- **Primary:** NZ residential power customers, 25-55, who pay their own power bill and have been with the same retailer for 12+ months
- **Secondary:** Renters who pay power directly; households with variable or seasonal usage patterns (heat pumps, EV charging, working from home)
- **Psychographic:** Bill-fatigued -- knows they should check prices but never gets around to it. Motivated by fairness ("I don't want to overpay") more than bargain-hunting. Values time and simplicity over micromanaging household expenses
- **Exclusion:** Large commercial accounts, spot-price arbitrage traders, people unwilling to share bill data, households already on spot/wholesale pricing

## 3. Core Features

### 3.1 Bill Ingestion (Onboarding)

The user's first interaction with Flip is sending their power bill. This is the primary onboarding path.

- **Manual forwarding (Free & Paid):** User forwards a PDF or photo of their power bill via WhatsApp. User texts a photo via MMS. Flip acknowledges receipt, parses the bill, and responds with a summary.
- **Email integration (Paid only):** User connects their Gmail or Outlook account via OAuth 2.0 (read-only scope). Flip polls daily for power bills from known retailers, ingests them automatically, and can backdate up to 12 months of historical bills to build a usage baseline.
- **EIEP14A alignment:** When a retailer provides product data via the Electricity Authority's EIEP14A standard, Flip ingests it directly rather than extracting from bills.

### 3.2 Usage Tracking

Every parsed bill is stored with structured metrics. The user can request a summary at any time.

Tracked per bill:
- Retailer and plan name
- Meter type (standard, low-user, day/night, controlled/uncontrolled)
- ICP number and installation address
- Usage in kWh, billing period in days
- Total cost in NZD
- Derived rates: c/kWh (effective), c/day (fixed daily charge)
- Fixed-term contract: expiry date, break fee if applicable
- Early payment discount conditions

Derived over time:
- Seasonal usage baselines (summer vs winter profiles)
- Anomaly detection: "This bill is 40% higher than your average for this time of year -- everything OK?"
- Trend analysis: "Your usage has been creeping up over the last 3 months"

### 3.3 Plan Comparison

The plan comparison engine is deterministic Python -- no AI, no ML, no statistical estimation. It uses the user's actual usage profile.

- **Input:** User's actual kWh usage across billing periods + list of available plans in their region (sourced from EIEP14A data and retailer public rate cards)
- **Output:** What the user WOULD have paid on each plan over the last N months, ranked by projected cost
- **Factors:** Fixed daily charge, variable c/kWh (including tiered/stepped pricing), prompt-payment discounts, any conditional fees, low-user plan eligibility, time-of-use rates (if meter data available)
- **Recalculation triggers:** New bill ingested, plan data updated, monthly scheduled run, user requests "compare"
- **Confidence scoring:** Based on bill data freshness, plan data age, and completeness of pricing information

### 3.4 Notification Engine

The notification engine is what makes Flip "Always On." It watches silently and only interrupts when the expected saving is meaningful.

- **Threshold-based:** Only notifies when expected saving exceeds a threshold (e.g., $50 over the next 3 months, configurable)
- **"Stay where you are":** Periodic reassurance that the user is still on the best plan. This is a first-class message, not an apology.
- **Urgency signals:** Fixed-term expiry approaching ("your fixed term with Contact Energy ends in 14 days"), retailer price change detected, new plan available that changes the comparison
- **Notification format (WhatsApp/SMS):** What changed, estimated saving, confidence level, one-tap "switch me" or "stay put" response
- **Frequency limits:** No more than one proactive notification per month unless triggered by a material change (price increase, contract expiry)
- **Free tier:** Monthly check-in only -- "You're still fine" / "There is likely a better plan" / "Switching is not worth it because savings are too small" / "Your contract means wait until X date"

### 3.5 Switching Service

When the user authorizes a switch, Flip handles the process.

- User confirms via WhatsApp/SMS response ("yes, switch me")
- Flip submits the switch request to the target retailer (via EIEP14A switching API or retailer-specific process)
- Switch tracking: status updates at key milestones ("switch requested", "switch confirmed for [date]", "switch complete")
- Handles standard ICP-based switches (same meter, new retailer)
- Does NOT handle: new connections, disconnections, metering changes, lines company issues, gas-only switches

### 3.6 User Commands (WhatsApp/SMS)

All user interaction is text-based via WhatsApp or SMS. Commands are natural language, interpreted by DeepSeek v4.

| Command | Example | Description |
|---|---|---|
| help / menu | "what can you do" | List available commands |
| usage / my usage | "how much power did I use" | Usage summary (last bill or date range) |
| bill / new bill | "I have a new bill" | Trigger bill ingestion flow |
| plans / compare | "check if I can save" | On-demand comparison |
| switch / switch me | "yes switch me" | Authorize a switch |
| stop / unsubscribe | "stop" | Cancel subscription, initiate data deletion |
| status / what's happening | "what's happening with my switch" | Current state check |

DeepSeek v4 Flash handles intent classification and simple command routing. DeepSeek v4 Pro handles multi-turn conversations, ambiguous requests ("that seems high" or "what about Genesis"), and natural language disambiguation.

### 3.7 Settings & Account (Interfaceless)

Account management is handled via WhatsApp/SMS commands or deep-links to a minimal Cloudflare Pages portal.

- Update phone number
- Notification preferences (frequency, threshold)
- Fixed-term expiry reminders on/off
- Export my data (GDPR/Privacy Act right of access)
- Delete my account and all data (GDPR/Privacy Act right to erasure)

## 4. Subscription Model

| Item | Value |
|---|---|
| Product ID | `flip_always_on_yearly` |
| Price | $30.00 NZD/year |
| Free tier | Monthly check-in only (no Always On monitoring, no switch service, no email backdating) |
| Paid tier | Always On monitoring + switch service + email bill backdating + historical usage export |
| Optional disclosed fees | Retailer switching referral/execution fee, disclosed per-switch, never affects ranking |
| Payment provider | Stripe (payment links via WhatsApp/SMS) |
| Billing model | Annual upfront, auto-renew with 7-day reminder |

### Free vs Paid Tier

| Feature | Free | Paid ($30/yr) |
|---|---|---|
| Manual bill ingestion (WhatsApp/SMS) | Yes | Yes |
| Bill parsing | Yes | Yes |
| Usage tracking | Yes | Yes |
| Monthly check-in | Yes | N/A (Always On) |
| Always On monitoring | No | Yes |
| Switch notifications | No | Yes |
| Switch execution | No | Yes |
| Email bill backdating | No | Yes |
| Historical usage export | No | Yes |
| Fixed-term expiry alerts | No | Yes |

## 5. Trust Model & Ethics

### 5.1 No Pay-to-Rank

Plan rankings are strictly mathematical -- based on the user's actual usage profile and published rates. Retailers cannot pay for placement, prominence, or recommendation. If a retailer offers a switching referral fee, it is disclosed per-switch ("Flip may receive $X if you complete this switch") but never changes the ranking order. Non-paying providers are always shown. The best option is always recommended even if it pays nothing. Comparison and revenue logic are auditable.

### 5.2 Data Handling

User bill data is THEIR data. It is never sold, never shared with retailers without explicit permission, and never used for marketing. Email access is read-only and scope-limited to power bill identification. All PII is encrypted at rest in D1. NZ Privacy Act 2020 compliance, uplifted to GDPR-equivalent standards for data portability and right to erasure.

### 5.3 "Stay Where You Are"

A valid and important recommendation. If the best plan for the user is their current plan, Flip says so clearly and celebrates it. There are no dark patterns, no urgency fabrication, no phantom savings, and no switching for switching's sake. The agent's credibility depends on being right when it says "switch" -- which means being honest when it says "stay."

## 6. Competitive Landscape

### 6.1 Billy (Electricity Authority)

Billy is the Electricity Authority's publicly owned comparison tool. It is free to consumers, receives no commissions, and has no commercial interest in whether someone switches. Its positioning is strongly neutral. However, it is episodic -- the user must initiate each check.

### 6.2 Powerswitch (Consumer NZ)

Powerswitch is a Consumer NZ-backed comparison service. It is free, not-for-profit, and ranks by price rather than promotions. It offers saved profiles, email reminders, and price-change alerts. However, it is funded partly through retailer switching fees ($61 per switch as of 2023), which creates a perceived conflict even if rankings remain price-based.

### 6.3 Flip's Position

| Dimension | Billy | Powerswitch | Flip |
|---|---|---|---|
| Monitoring model | Episodic (user initiates) | Reminder-based (email nudges) | Always On (passive, threshold-gated) |
| Trust model | Public/regulatory | Member-funded + switching fees | Customer-funded ($30/yr subscription) |
| Interface | Website | Website | WhatsApp + SMS |
| Data source | User-entered | User-entered | Bill parsing + EIEP14A |
| Switching | Manual | Manual | Assisted (initiated via text) |
| Primary recommendation | "Here's the cheapest plan today" | "Here's the cheapest plan today" | "Stay where you are" or "Switch now for ~$X savings" |

## 7. Technical Requirements

### 7.1 Messaging Platform
- **Sent** (sent.dm) for WhatsApp Business API + SMS via a single unified API
- Single webhook for all inbound messages (WhatsApp + SMS), automatic channel detection
- WhatsApp: outbound template messages, media handling (PDFs, images)
- SMS: outbound SMS notifications, automatic fallback when WhatsApp delivery fails
- Unified templates: one template definition works across both WhatsApp and SMS; Sent handles per-channel transformation
- Intelligent routing: Sent selects optimal channel (WhatsApp first, SMS fallback) per contact based on availability and cost
- Conversation state machine: track where each user is in a flow (new, onboarding, active, awaiting_bill, awaiting_switch_confirm, switching, free_tier, paid, inactive, unsubscribed)

### 7.2 DeepSeek v4 (Conversation Intelligence)
- **Flash model:** Real-time intent classification and simple command routing (<500ms target). Handles: "help", "usage", "compare", "switch", "stop", and basic affirmations/negations.
- **Pro model:** Multi-turn conversations, ambiguous requests ("that seems high" → clarify whether the user means usage or cost), bill disambiguation when parsing yields multiple possible interpretations, notification content generation.
- **NOT used for:** Plan comparison calculations, financial math, bill parsing (deterministic Python handles extraction)
- **Logging:** All LLM calls logged for audit. Temperature 0 for routing decisions. Prompt templates versioned in source control.

### 7.3 Bill Parsing Engine
- Python service (deployed via Pyodide in Cloudflare Worker or external container -- TBD)
- Input: PDF or image of bill. Output: structured JSON (retailer, plan, meter, usage, charges, period)
- Retailer-specific parsers for top 10 NZ retailers: Contact Energy, Genesis, Mercury, Meridian, Trustpower, Nova, Electric Kiwi, Powershop, Flick, Pulse Energy
- Generic fallback parser using layout heuristics, flagged for manual review
- Validation: sanity checks on extracted values (e.g., c/kWh must be 15-50c range, daily charge $0.30-$3.00)

### 7.4 Plan Comparison Engine
- Python service (same deployment as bill parser)
- Input: user's usage profile + available plans. Output: ranked list with projected costs, savings, confidence
- Plan data source: EIEP14A feed (primary) + manual retailer rate card entry (fallback for non-EIEP14A retailers)
- Handles: tiered pricing, prompt payment discounts, fixed daily charges, conditional pricing, low-user plans
- Deterministic arithmetic only -- no statistical estimation, no AI

### 7.5 Backend (Cloudflare)
- **Workers:** TypeScript strict + Hono router. Entry point: `workers/src/index.ts`
- **D1:** Relational data (users, bills, retailers, plans, plan_comparisons, switches, messages, oauth_tokens, notifications)
- **Queues:** Async job processing (bill parsing queue, plan comparison queue, notification dispatch queue)
- **KV:** Conversation state, rate limiting, session tokens, plan data cache
- **R2:** Bill image/PDF storage (encrypted at rest)
- **Pages:** Minimal web portal for OAuth connections, account management, legal docs

### 7.6 External APIs

| Service | Purpose | Auth |
|---|---|---|
| Sent (sent.dm) | WhatsApp/SMS messaging (unified API with automatic channel routing) | API key + webhook signature validation |
| DeepSeek v4 | NLU for conversation handling | API key |
| Gmail API | Email bill retrieval | OAuth 2.0 (read-only, `gmail.readonly` scope) |
| Microsoft Graph | Outlook email bill retrieval | OAuth 2.0 (delegated, `Mail.Read` scope) |
| Stripe | Subscription billing + payment links | API key + webhook signature validation |
| EIEP14A | Plan data ingestion | Public API (Electricity Authority) |

### 7.7 WhatsApp Template Messages

Sent handles template submission, approval tracking, and automatic resubmission on rejection. Templates work across both WhatsApp and SMS — the same template can send via SMS while WhatsApp approval is pending.

Required templates for proactive outreach:

- `bill_received` -- "Got your [Retailer] bill. [Usage] kWh over [Days] days, $[Total]. I'll compare your plans now."
- `saving_alert` -- "You could save ~$[Amount] over the next 3 months by switching to [Plan]. Want me to switch you?"
- `stay_put` -- "Good news -- you're still on the best plan for your usage. I'll keep watching."
- `switch_update` -- "Your switch to [Retailer] is [Status]. Next: [Next Step]."
- `fixed_term_expiry` -- "Your fixed term with [Retailer] ends on [Date]. I'll check what's available closer to then."
- `free_tier_checkin` -- "Your monthly check-in: [Status]. Upgrade to Always On for $30/yr to get automatic alerts."

## 8. Key Risks

### 8.1 Retailer Resistance
Retailers may not welcome automated switching away from them. Mitigation: Flip positions as neutral; no exclusive retailer deals; all rankings are mathematical; EIEP14A alignment provides regulatory cover.

### 8.2 Bill Parsing Accuracy
NZ power bills vary significantly in layout and terminology across retailers. Mitigation: retailer-specific parsers + manual review queue for low-confidence extractions. Start with 3-5 most common retailers, expand incrementally.

### 8.3 WhatsApp Business Restrictions
WhatsApp enforces strict rules on proactive messaging and template approval. Mitigation: comply fully with Meta's business policy; keep messages transactional (no marketing); SMS as fallback for any WhatsApp-rejected scenarios. Template message approval can take 1-4 weeks.

### 8.4 Customer Acquisition
No app store, no SEO-optimised website -- how do people find Flip? Key channels: word of mouth, NZ personal finance communities (Reddit r/PersonalFinanceNZ, Facebook groups), "share with a friend who overpays for power" prompt after each saving identified, potential MoneyHub partnership.

## 9. Success Metrics

- **Month 1:** Working bill ingestion + parsing for top 3 retailers (Contact, Mercury, Genesis)
- **Month 2:** Plan comparison engine producing accurate rankings. EIEP14A data pipeline operational.
- **Month 3:** 50 beta users. Bill parse accuracy >80% across supported retailers.
- **Month 6:** 500 users, ~100 paying ($3,000 ARR). All 10 retailer parsers >80% accuracy.
- **Month 12:** 2,000 users, ~400 paying ($12,000 ARR). Net Promoter Score >40.
- **Quality gate:** Switch satisfaction >90%. No user reports of phantom savings or incorrect comparisons.
