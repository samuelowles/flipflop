# Powerswitch Per-User Compliance Gate (Decision Record)

**Issue:** [#219 — E13.1 Compliance gate](https://github.com/samuelowles/flipflop/issues/219)
**Parent epic:** [#218 — Powerswitch per-user comparison bridge](https://github.com/samuelowles/flipflop/issues/218)
**Status:** CONDITIONAL GO (implementation unblocked against fixtures; live activation operator-gated)
**Decided:** 2026-07-15
**Operator:** Flip (Sam Owles)

---

## TL;DR

- **Decision: CONDITIONAL GO.** Implementation of #220-#222 may proceed immediately and be tested against fixtures / operator-owned test data.
- **LIVE per-user activation** (real user addresses sent to Powerswitch) is **GATED** behind two conditions (see [Activation gates](#activation-gates)).
- **ICP is NEVER submitted.** Results are complete without it (verified 2026-07-15 walkthrough, #218).
- **Fallback if no-go:** #157 manual plan import path.
- This document is the authority referenced by the `AI_RULES.md` override (#219).

---

## Background

Flip's core value proposition is comparing a user's actual power bill against live, address-specific plan availability. The current Powerswitch scraper (#66) is an explicitly temporary exception to the no-scraping rule, scoped in `AI_RULES.md` to **public plan-listing pages with ZERO PII**. That scraper is also broken against production (Powerswitch is a Next.js SPA; there are no static per-region plan pages — see #218, #223).

The per-user bridge (#218/#220-#222) is architecturally different: it submits a user's **address** (via Addressfinder autocomplete) and **coarse household answers** (gas source, household size, occupancy, hot-water, heating, insulation) to Powerswitch's questionnaire flow to retrieve the live, address-specific plan set with tariffs. This is PII the existing override explicitly prohibits sending.

Powerswitch is operated by **Consumer NZ**, a not-for-profit. Automated per-user querying may sit outside their terms of use; sanctioned access has not been confirmed in writing. This document records the decision and the conditions under which live activation is permitted.

### What was verified (2026-07-15 live walkthrough, recorded in #218)

- Full questionnaire flow captured: address autocomplete (server-action POST to `/`) -> `address_id` (pxid) -> location id -> `/api/locations/{id}/retailers` (public JSON) -> 7-step questionnaire (server-action POSTs) -> `GET /results?p={token}` (RSC flight payload with structured plan JSON).
- **ICP and current retailer are optional/skippable.** Full results are returned without submitting either. This is the keystone fact enabling the hard rule below.
- Server-action IDs and the `?dpl=` deployment hash rotate on every Powerswitch deploy -> HTTP replay breaks silently on their release cadence unless action IDs are discovered dynamically and a daily canary guards the schema (#221).

---

## Decision: CONDITIONAL GO

| Phase | Status | Gates |
|---|---|---|
| Implementation against fixtures / owned test data | **UNBLOCKED** | None — proceed now (#220-#222). |
| Live per-user activation (real user addresses to Powerswitch) | **BLOCKED** until both activation gates (below) are met. | Partner sign-off + operator env flip. |

### Rationale

1. **No legal blocker to building.** Implementation and fixture-based testing uses operator-owned test data and captured responses — no user PII leaves the system. There is no reason to hold engineering work hostage to a partner conversation that runs in parallel.
2. **The hard privacy wins are already locked in.** ICP (the most sensitive identifier — it maps an address to a physical meter) is **never submitted** because results are complete without it. The household answers are coarse and non-identifying on their own. This materially de-risks the privacy posture.
3. **Powerswitch is a shared not-for-profit resource.** Per-user automated querying at scale, without coordination, would be a poor citizen of that resource and could prompt a defensive block. A written arrangement (or at minimum a written OK for rate-limited automated use with an identified user agent) is the correct, respectful path before going live — and Flip drives switches through their referral flow, so there is genuine mutual benefit.
4. **There is a clean fallback.** If Consumer NZ says no (or is unresponsive), #157 (manual rate-card import) provides plan data without any external dependency. The bridge investment is not wasted: the fixture path and comparator integration remain useful, and the bridge can be reactivated the moment sanctioned access exists.

---

## Activation gates (BOTH required for LIVE per-user use)

### Gate 1 — Written partner sign-off from Consumer NZ / Powerswitch

A written response from Consumer NZ / Powerswitch confirming sanctioned access. Acceptable forms, in order of preference:

1. **Partner / API arrangement** — a formal data or referral partnership with documented terms.
2. **Written OK for rate-limited automated use** — an email or message from an authorised Consumer NZ contact confirming that rate-limited automated querying with an identified user agent is acceptable, ideally with any stated constraints (rate caps, attribution, etc.).

The response (or a faithful summary + the contact and date) must be recorded in this document under [Partner sign-off log](#partner-sign-off-log) before Gate 2 can be set.

**This is an OPERATOR action, not an automation.** No agent, script, or automated email is permitted to originate this contact. It is a human-to-human conversation (Flip operator -> Consumer NZ). See [Operator action items](#operator-action-items).

### Gate 2 — Operator environment flip `POWERSWITCH_LIVE=true`

Even with written sign-off, live per-user activation requires an explicit, operator-set environment variable `POWERSWITCH_LIVE=true` in the deployed Worker. The per-user bridge must ship reading this flag and **default to inert** (`false` / unset) — exactly the pattern used by `POWERSWITCH_SCRAPER_ENABLED` for the #66 scraper. Code path:

- `POWERSWITCH_LIVE` unset or `false` -> bridge resolves address + replays questionnaire against **fixtures only** (or returns the #157 fallback), never sends a real user address to Powerswitch.
- `POWERSWITCH_LIVE=true` AND Gate 1 recorded -> live per-user flow is active.

The env flip is the hard technical kill-switch. It allows instant deactivation without a redeploy conversation if Consumer NZ revokes consent, if etiquette is being violated, or if the canary (#221) detects drift.

---

## Hard rules (apply REGARDLESS of activation state)

These rules hold whether the bridge is fixture-only or live. They are enforced in code and reviewed in PRs touching the bridge.

1. **ICP is NEVER submitted.** The questionnaire's optional ICP step is always skipped. Results are complete without it (verified 2026-07-15). This is non-negotiable: ICP maps an address to a physical meter and is the most sensitive identifier in the flow. Code must not read, construct, or post an ICP value into any Powerswitch request.
2. **Current retailer is optional** and may be omitted; results are complete without it. If Flip knows the user's current retailer (from their bill), it MAY be submitted to improve ranking, but omission must never block a comparison.
3. **Per-day request budget.** A documented maximum number of Powerswitch requests per UTC day (shared not-for-profit resource etiquette). Exact value set in the bridge config (#221); starts conservative.
4. **Sequential requests with delay + exponential backoff.** No concurrent/parallel requests to Powerswitch. A minimum inter-request delay and backoff-on-error are mandatory (mirrors the existing #66 scraper etiquette in `powerswitchScraper.ts`).
5. **Identified user agent.** A documented `POWERSWITCH_USER_AGENT` string identifying the service and a contact, on every request. No spoofing of browser user agents.
6. **Daily drift canary.** A fixture-address canary run (#221) must guard the schema. On schema mismatch: structured alert + user-facing runs skipped (mirrors the `MONEY_FIELD_MISSING_THRESHOLD` philosophy). Silent partial-garbage writes are never permitted.

---

## Data retention (Privacy Act 2020, cross-ref #103)

Under the NZ Privacy Act 2020, Flip must state what Powerswitch-derived data it holds, why, and for how long. This section is the authority for the corresponding Privacy Policy / data-export-and-deletion behaviour in #103.

### What is retained

| Data element | Where | TTL / retention | Rationale |
|---|---|---|---|
| Address id (`pxid`) + location id | `users.powerswitch_pxid`, `users.powerswitch_location_id` (#220 migration) | Lifetime of the user account (deletable on request via #103). | Needed to re-run the questionnaire on plan/bill changes without re-resolving the address; the address itself is already held on the user row for billing purposes. |
| Parsed plan set + tariffs (per user) | KV results cache (#221) | **7-day TTL**, refreshed on recompare triggers. | Avoids re-running the questionnaire more than necessary (etiquette + cost). Stale cache is preferable to a stale-forever snapshot. |
| Raw results token (`?p={token}`) | **Not retained long-term.** | Lives only for the duration of the request that consumes it; not persisted beyond the KV cache window. | The token is a session handle, not user data. No long-term retention. |
| Questionnaire answers submitted | **Not stored separately.** | n/a — derived from the user's stored profile at request time; the submission itself is not persisted. | Minimises footprint; answers are recomputable from the profile. |
| Server logs | Cloudflare logs | Standard Flip log retention (no PII in logs per `AI_RULES.md`). | Debugging only; redacted of address/PII per existing policy. |

### Privacy story actions (tracked under #103)

- Export (`POST /admin/users/{id}/export`) includes the stored `pxid`, `location_id`, and the current cached plan set.
- Delete (`POST /admin/users/{id}/delete`) clears the KV results cache and nulls the `powerswitch_*` columns on the user row (idempotent, per #103).
- The Privacy Policy (#94) disclosure states: "Flip queries Powerswitch.org.nz on your behalf using your address and household profile to retrieve live, address-specific plan availability. Your ICP number is never shared. Cached results expire after 7 days."

---

## Fallback (if CONDITIONAL GO becomes NO-GO)

If Gate 1 cannot be satisfied (Consumer NZ declines or is unresponsive within the operator's patience window):

- **#157 — Manual retailer rate-card import** becomes the plan-data path. Operators import rate cards (CSV/JSON) with `provenance=manual`; manual rows win over EIEP14A/Powerswitch in #69 precedence.
- The per-user bridge code (#220-#222) is retained but left inert (`POWERSWITCH_LIVE=false`). It can be reactivated if sanctioned access is obtained later.
- Address-specific availability and bundle/TOU pricing (the bridge's unique value over EIEP14A) are lost until sanctioned access exists. This is an accepted trade-off — respectful use of a not-for-profit resource takes priority.

---

## Consent copy (draft)

> **Note:** This is draft copy for the WhatsApp onboarding flow. It is **not wired into code here** — the onboarding-flow issue owns implementation. It is recorded here so the compliance decision and the consent language are reviewable together.

### Template 1 — Onboarding disclosure (first comparison)

```
Kia ora 👋 Quick heads-up before I run your first comparison: to find the plans actually available at your place, I query Powerswitch.org.nz on your behalf using your address and a few household details (like heating type and hot-water setup). I never share your ICP number or anything bank-related. I'll also cache the results for 7 days so I'm not poking them repeatedly. You can ask me to wipe that anytime. Sound good? Reply YES to continue.
```

### Template 2 — Re-consent / change of address

```
Heads up: I'll query Powerswitch with your new address to get fresh plan options. Same rules as before — address + household details only, never your ICP, results cached 7 days. Reply YES to confirm.
```

### Copy principles (from `AI_RULES.md` Voice & Tone)

- Casual, direct, not pushy. No urgency inflation.
- States exactly what is sent (address + household answers) and what is never sent (ICP, bank data).
- States the retention (7-day cache) and the user's right to deletion.
- NZ English spelling and conventions.
- Explicit opt-in (`Reply YES`); no assumed consent.

---

## Operator action items

These are explicitly **operator (human) actions**. No automation, agent, or script is permitted to perform them.

1. **Contact Consumer NZ / Powerswitch** (Gate 1). Initiate a human conversation about sanctioned access: propose either a formal partner/API arrangement or a written OK for rate-limited automated use with an identified user agent. Frame the mutual benefit: Flip drives switches through Powerswitch's referral flow. Record the outcome in [Partner sign-off log](#partner-sign-off-log).
2. **Set `POWERSWITCH_LIVE=true`** (Gate 2) — only after Gate 1 is recorded below — in the deployed Worker via `wrangler secret put`.
3. **Periodically review the canary** (#221) and the per-day request budget. If Consumer NZ states constraints, encode them in the bridge config.

### Partner sign-off log

| Date | Contact (Consumer NZ) | Form (partner / written OK) | Constraints stated | Recorded by |
|---|---|---|---|---|
| _(pending)_ | — | — | — | — |

> When Gate 1 is met, replace the pending row above with the actual record (date, contact, form, constraints, who recorded it). Only then may Gate 2 be set.

---

## Scope of this document

This is **decision documentation**. It does not modify code. The code-level enforcement (env-flag read, ICP-never-submitted guard, rate budget, canary) lives in the bridge modules (#220-#222) and is reviewed in those PRs against the hard rules above.

The `AI_RULES.md` override section references this document as its authority.

## Related

- #218 — Epic: Powerswitch per-user comparison bridge
- #220 — E13.2 Address resolution
- #221 — E13.3 Questionnaire replay + results parser + canary
- #222 — E13.4 Tariff schema mapping
- #157 — Manual rate-card import (fallback)
- #103 — User data export + deletion (Privacy Act 2020)
- #94 — Privacy Policy
- #66 / `workers/src/services/powerswitchScraper.ts` — existing public-page scraper (separate override, unchanged)
