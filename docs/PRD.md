# Flip — Product Requirements Document

**Version 2.0 · 2026-08-18**
Rewritten from the doc/code alignment questionnaire. Supersedes v1 entirely.

**Rule of precedence for this repo: deployed state > `master` > this document.** Where this PRD and the running system disagree, the system is presumed correct and this document is wrong until fixed.

---

## 1. What Flip is

Flip watches a New Zealand household's power bills and tells them, unprompted, when moving to a different plan would save them real money. It is not a comparison site, not a discount-code repository, not a marketing channel for retailers, and not an on-demand switching portal. Its most important recommendation is frequently "stay where you are."

Existing NZ tools (Powerswitch, Billy) are episodic: the customer must remember to check, enter their details, and interpret the result. Flip changes the job from *"help me compare when I remember to ask"* to *"watch this for me and interrupt me when it matters."*

**Positioning:** Messaging-first, with a minimal web signup and account area.
**Monetisation:** *Free to check. $59/year to be watched.*

## 2. Surface area

| Surface | Owns | Where |
|---|---|---|
| **Web** | Signup, savings preview, payment, account, legal | `flipflop.co.nz` (Cloudflare Pages) |
| **API + operator pages** | Webhooks, OAuth callbacks, trace, admin | `app.flipflop.co.nz` (Cloudflare Worker) |
| **Messaging** | Alerts, reassurance, switching, support, abandoned cart | WhatsApp and SMS via sent.dm |

Flip has no mobile app and no customer-facing dashboard. The web surface exists to acquire and bill; the relationship lives in the message thread.

## 3. Target audience

- **Primary:** NZ residential power customers, 25–55, who pay their own bill and have been with the same retailer 12+ months.
- **Secondary:** Renters paying power directly; households with variable or seasonal usage (heat pumps, EV charging, working from home).
- **Psychographic:** Bill-fatigued. Knows they should check and never gets around to it. Motivated by fairness — *"I don't want to be overpaying"* — more than bargain hunting.
- **Excluded:** Commercial accounts, spot-price traders, households already on wholesale pricing, anyone unwilling to share bill data.

## 4. Onboarding and the free tier

### 4.1 The signup flow

**Gmail connect → savings preview → Stripe Checkout.**

1. Visitor arrives at `flipflop.co.nz` and connects Gmail via OAuth (read-only).
2. Flip finds their most recent power bill, parses it, and runs a comparison.
3. The visitor is shown **the saving amount and nothing else**.
4. They pay to see which plan, which retailer, and to be watched from then on.

**Upload fallback.** Where Gmail yields only a link rather than a PDF — Electric Kiwi and Powershop email links — the signup flow asks for a PDF upload instead. The same parse-and-compare path runs.

### 4.2 What free actually gets

A single number: *"You could save about $340 a year."* No plan name, no retailer, no rates, no ongoing monitoring, and **no proactive messages of any kind**.

The free preview fires at a **$50/year** threshold. There is no free tier beyond this preview — the previous monthly free-tier check-in is removed.

### 4.3 Trial

**The first saving alert is free.** A customer who signs up and is later found a saving receives that first alert without paying; acting on it, and all subsequent monitoring, requires a subscription.

### 4.4 Beta access

Beta users receive full access via a **Stripe coupon**, not via a free tier. There is one product and one set of entitlements.

## 5. Paid product

### 5.1 Price

- **$59 NZD / year**, or **$6 NZD / month**. Annual is approximately two months free.
- Sold through Stripe Checkout on the web at signup. Abandoned checkouts are recovered over WhatsApp/SMS.

### 5.2 What paying buys

Everything beyond the amount-only preview:

- **Always On monitoring** — continuous re-comparison as plan data changes
- **Saving alerts** with the plan, retailer and projected annual figure
- **Switch notifications and switch assistance**
- **Email bill backdating** — up to 12 months of historical bills to build a usage baseline
- **Historical usage export**
- **Fixed-term expiry alerts** at 60, 30 and 7 days
- **Monthly reassurance** when nothing has changed

### 5.3 Referral fees — future, not v1

Earlier drafts described a disclosed per-switch referral fee. **No such fee is earned, recorded or disclosed today**, and none is planned for v1. If it is ever introduced, two rules are non-negotiable: it is disclosed in the message that carries the recommendation, and it never influences ranking. Flip is customer-funded.

## 6. Notification policy

This is the most load-bearing section of the product. Flip's licence to interrupt is the whole relationship.

### 6.1 Thresholds

| Context | Threshold |
|---|---|
| Web savings preview | **$50 / year** |
| Proactive alert to a paying customer | **$200 / year** |

The web preview is a lower bar because the customer is present and asking. Interrupting someone unprompted requires a materially larger number.

### 6.2 Horizon

All saving figures are expressed **over the next 12 months**. Never three months, never per-quarter. Plan rates move over a year and the annual figure is the honest framing.

### 6.3 Frequency

- **Saving alerts are immediate and uncapped.** A real saving is not held back to fit a cadence. The 1-hour send dedup remains; the 7-day per-plan cooldown is removed.
- **Reassurance is monthly**, and only for paying customers, and only in months where no saving alert fired.
- **Free users receive no proactive messages at all.**

### 6.4 Opt-out

A single global **STOP** halts everything — alerts, reassurance, expiry warnings, abandoned-cart recovery. There is no granular opt-out. STOP takes effect before the inbound webhook acknowledges.

### 6.5 Parse confidence

An alert only fires when the underlying bill reconciled arithmetically against its printed total. A low-confidence parse goes to review and the customer is told honestly that Flip could not read the bill and asked to resend.

## 7. Plan data

### 7.1 Today

The live source is **per-user Powerswitch questionnaire replay**. The customer's address and usage profile are submitted to Powerswitch and the returned plan set is parsed and ranked. This is the only source currently enabled; the EIEP14A feed and the public-page scraper are both flag-disabled.

Powerswitch is named as a recipient of personal information in the privacy policy. There is no in-flow disclosure before each query.

### 7.2 From October 2026

The Electricity Authority's **EIEP14A feed goes live in October**. When it does, it becomes the primary plan-data source. The Powerswitch path is retired once EIEP14A validates against Powerswitch results on 20 real bills.

### 7.3 When no plan data returns

Fail honest. Tell the customer Flip could not check right now and retry. Never fall back to seeded or fabricated plan data — that shipped once and was removed deliberately.

## 8. Bill ingestion

### 8.1 Sources

- **Gmail** (OAuth, read-only) — the primary path, and the signup mechanism
- **WhatsApp / SMS forwarding** — PDF or photo
- **Web upload** — the signup-flow fallback for link-only retailers

**Outlook is on the roadmap and is not in scope for beta or launch.** The `outlook` value remains in the source enum; no implementation exists.

### 8.2 Retailers in scope

Contact · Mercury · Genesis · Meridian · Trustpower · Electric Kiwi · Powershop · Flick · Nova · Pulse · **Black Box Power · Grey Power · Electra** (Pulse white-labels — parsers to be built).

Trustpower is migrating to Mercury and Flick to Meridian; both parsers remain necessary through the transition.

### 8.3 Parse validation

The guard is **arithmetic reconciliation**: extracted rates and usage must multiply back to the bill's printed total within tolerance. This replaces the previously documented c/kWh and daily-charge sanity ranges, which were never implemented and were weaker than the reconciliation check.

GST basis is detected and normalised before comparison — a bill printing GST-exclusive rates against a GST-inclusive total will otherwise produce a wildly inflated saving.

### 8.4 Unreadable bills

The customer is told, plainly, that Flip could not read the bill, and asked to resend. An operations alert is raised. The customer is never left in silence after handing over a bill.

## 9. Switching

**Current behaviour requires research before it is specified.** The architecture previously claimed Flip submits switches to a retailer API or emails a switching desk; in reality no NZ retailer exposes such an API and the code produces a pre-filled deep link the customer completes themselves.

**Open task:** research how NZ switching actually works today — what retailers accept, whether email-to-switching-desk is viable, what Powerswitch does on completion — and re-specify this section and the customer-facing promise from findings.

**Confirmed regardless of mechanism:**
- Switch initiation requires authentication — an HMAC signed link or a session. It is not an open endpoint.
- Completion is confirmed two ways: the customer self-reports, and the next parsed bill shows the new retailer.
- Switch failures raise an operations alert.

## 10. Trust, privacy and compliance

### 10.1 Legal

A **new legal entity** operates Flip. A privacy policy and terms of service are **hard blockers** — no external user before both are live. Stripe requires terms; Google's OAuth verification requires a hosted privacy policy; the Powerswitch disclosure lives in the privacy policy.

### 10.2 Processors

Eight parties receive customer-derived data, all named in the privacy policy:

| Processor | Receives |
|---|---|
| sent.dm | Phone number, message content |
| DeepSeek | Bill-derived text (China-hosted — disclosed) |
| Google / Gmail | OAuth token, mailbox read access |
| Powerswitch | Address, usage profile |
| Cloudflare | All stored data |
| Google Cloud Run | Bill PDFs (parsing) |
| Resend | Operations and transactional email |
| Stripe | Payment details, email |

### 10.3 Retention

| Data | Retained |
|---|---|
| Bills and R2 objects | 24 months |
| Comparisons | 24 months |
| Messages | 12 months |
| LLM audit | 30 days |
| Notification audit | 90 days |

Enforced by scheduled purge.

### 10.4 Deletion

"Delete my data" purges D1 rows, R2 bill objects **and revokes the Google OAuth token**. This must be verified end to end before launch — the revocation step in particular.

### 10.5 Where AI is and is not used

AI writes language. Arithmetic decides outcomes.

DeepSeek's baseline role is conversational: intent classification, entity extraction, and message composition.

Beyond that, **three intelligence surfaces** exist and are documented here because none appeared in earlier specifications:

| Surface | Does |
|---|---|
| Ingestion intelligence | Retailer classification, bill summarisation, and **advisory validation of parser output against NZ norms** |
| Usage intelligence | Trend, seasonality and anomaly narration |
| Comparison intelligence | Explaining a comparison result in plain language |

In every case arithmetic reconciliation and the comparison engine override the model. No model computes a saving, ranks a plan, or decides whether to send. The advisory validation in ingestion intelligence advises only — a disagreement between the model and the reconciliation is always resolved in favour of the arithmetic.

**Model:** `deepseek-v4-pro`. The previously-shipped `deepseek-chat` and `deepseek-reasoner` identifiers were **retired by DeepSeek on 24 July 2026**; any reference to them is stale.

### 10.6 Bot protection

Turnstile on the public web signup flow.

## 11. Quality bars

| Measure | Bar |
|---|---|
| Parser accuracy, top five retailers | **> 90%** on real bills |
| Parser accuracy, all others | **> 80%** on real bills |
| Comparison correctness | Reconciles against the bill total |

Measured against a corpus of real anonymised bills, not generated fixtures. Sourcing ~20 real bills per major retailer is an open task.

## 11a. Acceptance

"Flip works" is proven by the **full signup path**: Gmail connect → savings preview → Stripe Checkout → monitoring active.

**The messaging leg is currently excluded** — sent.dm approval is pending on their side, so alert delivery cannot yet be verified end to end. It is added to the acceptance path as soon as approval lands, and it remains a launch gate regardless (§12).

## 12. Launch gate

All must be true before a real, unrelated customer can pay:

1. Legal entity formed; privacy policy and terms live
2. Stripe live
3. Parser accuracy bar met on real bills
4. **sent.dm sends confirmed working** — currently pending approval on their side
5. Remote D1 migrations ledger rebuilt and verified
6. Data deletion verified across D1, R2 and OAuth
7. Seven consecutive green end-to-end trace runs

## 13. Success measures

- Signups completing Gmail connect → preview
- Preview → paid conversion
- Alert → switch initiation rate
- Switch completion rate
- Retention at 12 months (the product only compounds if people stay)
- Cost per customer per month against $59/year

## 14. What Flip will not do

- No pay-to-rank, sponsored placement, or retailer money influencing recommendations
- No selling or monetising customer bill data
- No marketing messages over WhatsApp or SMS
- No public comparison tool — `/eval` is an internal operator surface behind admin auth
- No on-demand switching portal
- No mobile app

## 15. Open decisions

| # | Decision | Owner |
|---|---|---|
| 1 | How NZ switching actually works, and what Flip promises (§9) | Research task |
| 2 | Break-even recomputed at $59 against real Cloud Run, Powerswitch and DeepSeek costs | Sam |
| 3 | Real-bill corpus, ~20 per major retailer | Sam |
| 4 | Whether a Fly.io Python app is still billing alongside Cloud Run | Verify |
