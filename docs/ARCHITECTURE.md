# Flip — Architecture

**Version 2.0 · 2026-08-18** · Derived from source, not from memory.
Precedence: **deployed > `master` > this document.**

Sections marked **→ Decided** record a change agreed in the alignment questionnaire that is **not yet built**. Everything else describes what runs today.

---

## 1. Shape

```
        flipflop.co.nz                    app.flipflop.co.nz
        (Cloudflare Pages)                (Cloudflare Worker "flip-api")
        signup · account · legal    ─────▶ webhooks · OAuth · admin · trace
                                              │
                    ┌─────────────────────────┼──────────────────────────┐
                    ▼                         ▼                          ▼
            D1 "flip-db"              KV + R2 "flip-bills"        3 Queues + 1 DO
                                                                          │
                                              ┌───────────────────────────┘
                                              ▼
                              Python service (Flask, Google Cloud Run)
                              /parse · /compare
```

**→ Decided:** the Worker moves to `app.flipflop.co.nz`; the Pages project at `flipflop.co.nz` owns the signup flow, account area and legal pages. OAuth redirect URIs and the CORS posture change with it.

## 2. Worker runtime

`workers/src/index.ts` — Hono, exports `{ fetch, queue, scheduled }` plus the `RateLimiter` Durable Object class.
`compatibility_date = 2026-05-14`, `compatibility_flags = ["nodejs_compat"]`.

### 2.1 Bindings

| Kind | Binding | Target |
|---|---|---|
| D1 | `DB` | `flip-db` (`9bdbc913-…`) |
| KV | `KV` | `6f4e28e8…` |
| R2 | `BILLS` | `flip-bills` |
| Queue producer | `PARSE_QUEUE` | `flip-parse-queue` |
| Queue producer | `COMPARE_QUEUE` | `flip-compare-queue` |
| Queue producer | `NOTIFY_QUEUE` | `flip-notify-queue` |
| Durable Object | `RATE_LIMITER` | class `RateLimiter`, migration tag `v1` |

No `[[rules]]`, no `[env.*]` blocks. **→ Decided:** add a `staging` environment with its own D1, KV and queues, and `FLOW_TEST_MODE` enabled.

### 2.2 Vars and flags

<!-- generated:flags — derived from [vars] in workers/wrangler.toml · verified by engine/drift.mjs · do not hand-edit inside this block -->
| Var | Value | Gates |
|---|---|---|
| `ENVIRONMENT` | `production` | Passed to the notification engine; `production` hard-disables `FLOW_TEST_MODE` |
| `EIF_EIEP14A_ENABLED` | `false` | EIEP14A ingestion on the 03:00 cron. **Inert until the EA feed lands in October.** |
| `POWERSWITCH_SCRAPER_ENABLED` | `false` | Public plan-page scrape on the 03:00 cron |
| `POWERSWITCH_LIVE` | `true` | Per-user Powerswitch replay in the compare consumer, and live calls in the canary |
| `FLOW_TEST_MODE` | `false` | Bypasses threshold and both cooldowns for traced users |
| `F1_HINT_CONFIDENCE_THRESHOLD` | `0.85` | Below this, a parsed bill routes to review |
| `SERVICE_VERSION` | `0.1.0` | **Declared and never read** — `/` and `/health` use a hardcoded literal |
<!-- /generated:flags -->

Inventories wrapped in `<!-- generated:<id> … -->` / `<!-- /generated:<id> -->` markers are derived from source, not written by hand. `engine/drift.mjs` re-derives every one of them on each run; `node engine/drift.mjs --report` proves they are in sync. Regenerate a block by re-deriving it from the source named in its opening marker — do not hand-edit inside the markers.

### 2.3 Secrets

`ADMIN_API_KEY` · `DEEPSEEK_API_KEY` · `EIEP14A_API_KEY` · `ENCRYPTION_KEY` · `GMAIL_CLIENT_ID` · `GMAIL_CLIENT_SECRET` · `OPS_EMAIL` · `PYTHON_SERVICE_AUTH_TOKEN` · `PYTHON_SERVICE_URL` · `RESEND_API_KEY` · `SENT_API_KEY` · `SENT_WEBHOOK_SECRET`
Plus `SENT_API_BASE_URL` read via `cloudflare:workers` (defaults to `https://api.sent.dm/v1`).

`docs/OPERATIONS.md` is the canonical list and is enforced by `scripts/check-env-docs.mjs` in CI.

## 3. HTTP surface

<!-- generated:routes — derived from app.<method>(…) registrations in workers/src/index.ts · verified by engine/drift.mjs · do not hand-edit inside this block -->
| Method | Path | Auth | Rate limit |
|---|---|---|---|
| GET | `/`, `/health` | — | bypassed |
| POST | `/webhook/messaging` | `sentAuth` (HMAC-SHA256 over raw body) | 100/user, 1000/global per 60s |
| GET | `/auth/gmail`, `/auth/gmail/` | — | — |
| POST | `/auth/gmail/login` | — | — |
| GET | `/auth/gmail/callback` | — | — |
| GET | `/auth/gmail/scan-status` | signed link (`u`+`exp`+`sig`) | — |
| GET | `/auth/gmail/eval-status` | signed link | — |
| GET | `/eval`, `/eval/` | — **→ Decided: `adminAuth`** | — |
| POST | `/eval/upload` | — **→ Decided: `adminAuth`** | 5/IP per 60s (inline KV) |
| GET | `/eval/result`, `/eval/status` | — **→ Decided: `adminAuth`** | 30/300 per 60s |
| POST | `/api/switch` | **none — known gap** | 30/300 per 60s |
| GET | `/admin/templates` | `adminAuth` (Bearer) | — |
| GET | `/admin/templates/status` | `adminAuth` | — |
| GET | `/admin/rate-limit/:userKey` | `adminAuth` | — |
| GET | `/admin/notifications` | `adminAuth` | — |
| GET | `/admin/flow-link` | `adminAuth` | — |
| POST | `/admin/test-run/reset` | `adminAuth` | — |
| GET | `/admin/*` (catch-all) | `adminAuth` | 501 stub |
| GET | `/flow/status`, `/flow/status.json` | admin Bearer OR signed link | — |
| POST | `/webhook/stripe` | — | **501 stub** |
| GET | `/webhook/email/*` | — | **501 stub** |
<!-- /generated:routes -->

**→ Decided:** `POST /api/switch` must require the HMAC signed link or a session. Reuse `flowLink.ts`, which already mints and verifies signed links for `/flow/status`.

### 3.1 Middleware

- `errorHandler` — global; strips phone, email, ICP and street-address patterns from logged messages.
- `sentAuth` — HMAC-SHA256 hex in `X-Sent-Signature`; sets `phone_hash` on the context.
- `adminAuth` — `Authorization: Bearer <ADMIN_API_KEY>`, timing-safe compare.
- `rateLimit` — Durable Object backed. Key preference: `phone_hash` → hashed phone → hashed `ip:<CF-Connecting-IP>` → `unknown`. **Fails closed** when the DO is unreachable.

The rate limiter is a **Durable Object**, not the KV sliding window some older docs described. KV raced; the DO gives atomic per-key counting. It stores an array of millisecond timestamps per key and trims on read.

## 4. Data flow

### 4.1 Ingestion → alert

```
bill arrives (WhatsApp/SMS media · Gmail poll · web upload)
   └─▶ R2 BILLS + bills row (status=pending_parse)
        └─▶ PARSE_QUEUE
             └─▶ Python /parse ──▶ bills row updated (parsed | needs_review | failed)
                  └─▶ COMPARE_QUEUE
                       └─▶ Powerswitch replay ──▶ plan set
                            └─▶ Python /compare ──▶ plan_comparisons row
                                 └─▶ NOTIFY_QUEUE
                                      └─▶ evaluateAndNotify ──▶ sent.dm
```

### 4.2 Queues

| Queue | Batch | Concurrency | Retries | DLQ |
|---|---|---|---|---|
| `flip-parse-queue` | 1 | 3 | 3, `retry_delay=30` | `flip-parse-dlq` |
| `flip-compare-queue` | 1 | 2 | none declared | none |
| `flip-notify-queue` | 1 | 5 | none declared | none |

**Parse** classifies failures: `ParseError.transient` retries with backoff `30 × attempts`; terminal errors (4xx, `extract_failed`, `no_media`) write `updateBillFailed` and ack without retry.

**Compare** has no transient/terminal distinction — every error retries to exhaustion then acks, writing no failure state. Known asymmetry.

### 4.3 Cron

<!-- generated:cron — derived from crons = [...] in workers/wrangler.toml · verified by engine/drift.mjs · do not hand-edit inside this block -->
| Cron (UTC) | Runs |
|---|---|
| `0 3` | EIEP14A refresh (flag-gated) · Powerswitch public scrape (flag-gated) · purge `llm_audit` >30d · purge `notification_audit` >90d |
| `0 6` | Gmail poll, all users |
| `0 8` | Plan-diff consumer → re-compare · **free-tier check-in (day 1 of month)** · fixed-term expiry scan · switch sanity check |
| `0 10` | Powerswitch drift canary |
| `0 14` | Gmail poll, all users |
<!-- /generated:cron -->

**→ Decided:** the free-tier check-in is **removed entirely**. Delete `freeTierCheckin.ts`, `getFreeTierUsers` and the day-of-month branch. Replace with a monthly reassurance for paying customers in months where no saving alert fired.

Dispatch is by **exact string equality** on the cron expression — adding a trigger without adding a branch silently does nothing.

## 5. Database

14 tables from 21 migrations. Full column detail lives in the migration files; this is the map.

<!-- generated:tables — derived from CREATE TABLE across workers/migrations/, replayed in order · verified by engine/drift.mjs · do not hand-edit inside this block -->
| Table | Purpose | Notes |
|---|---|---|
| `users` | Identity, state machine, threshold | `phone` unique; `phone_encrypted` + `phone_hash` blind index; `powerswitch_pxid`/`_location_id` |
| `bills` | One row per ingested bill | `source ∈ whatsapp\|sms\|gmail\|outlook\|web`; `source_message_id` UNIQUE (Gmail dedup) |
| `retailers` | 25 seeded | `email_domains` JSON array drives sender matching |
| `plans` | Comparison targets | `provenance ∈ eiep14a\|powerswitch\|manual`; migration 0020 expired every seeded manual plan |
| `plan_comparisons` | Comparison output | `recommendation ∈ switch\|stay_put` |
| `switches` + `switch_transitions` | Switch state machine + audit | `transitionSwitch` is the trust boundary |
| `messages` | Inbound/outbound log | `body_encrypted` |
| `oauth_tokens` | Gmail tokens, encrypted | `provider ∈ gmail\|outlook` |
| `notifications` | What was sent | `type` includes `free_tier_checkin` — **→ retiring** |
| `notification_audit` | Sent/suppressed/failed, with reason | 90-day purge |
| `usage_metrics` | Derived usage intelligence | |
| `llm_audit` | Metadata only, never content | 30-day purge |
| `plan_data_provenance` | Ingestion lineage | No indexes |
<!-- /generated:tables -->

### 5.1 Known schema facts worth carrying

- **Threshold column, → Decided (D-04).** `users.notification_threshold_cents` carries a column default of **5000** while `createUser` explicitly binds **20000**, and migration 0021 moved every existing row. The default is deliberately unreachable — a trap for any insert path that does not go through `createUser`, and for anyone reasoning from the schema.
  - Set the column default to **`20000`**.
  - **Rename it `alert_threshold_cents`**, so its scope is unambiguous.
  - The web preview threshold is a **separate named constant**, `WEB_PREVIEW_THRESHOLD_CENTS = 5000`, and does **not** live on the user row — it is a global product rule, not a per-user preference.

  Two thresholds sharing one column is how the original $50/$200 confusion arose; naming them apart is the cheapest prevention available.
- `idx_comparisons_user_id` and `idx_plan_comparisons_user_id` are duplicate indexes on the same column with different names (0001 and 0014).
- No user FK cascades. `dataDeletion.ts` deletes child rows in explicit order because of this.

### 5.2 Migration ledger — unresolved

The remote D1 has **no `d1_migrations` ledger**, so `wrangler d1 migrations apply` must not be run against it. Nobody knows with certainty which of the 21 migrations production is on.

**→ Decided, and human-gated:** dump the live schema, diff against all 21 migrations, hand-insert the correct ledger rows, then resume normal migration flow. Getting this wrong is unrecoverable.

## 6. Notification engine

`evaluateAndNotify(userId, comparisonId, env)` is the only path to a proactive message.

Guards today:

| Guard | Key | Window |
|---|---|---|
| Send dedup | `dedup:` | 1 hour |
| Per-user-per-plan cooldown | `cooldown:` | 7 days |
| Per-comparison | `notified:` | 30 days |
| Threshold | `users.notification_threshold_cents` | — |

**→ Decided:** remove the 7-day per-plan cooldown. Saving alerts are immediate and uncapped; the 1-hour dedup stays. Reassurance is monthly and paid-only.

`FLOW_TEST_MODE` bypasses threshold and both cooldowns, and is structurally disabled when `ENVIRONMENT="production"`.

## 7. Plan data

Three sources exist in code; **one is live**.

| Source | Flag | State |
|---|---|---|
| Per-user Powerswitch replay | `POWERSWITCH_LIVE=true` | **Live — the only source** |
| EIEP14A feed | `EIF_EIEP14A_ENABLED=false` | Built, inert. **→ becomes primary in October** |
| Public plan-page scrape | `POWERSWITCH_SCRAPER_ENABLED=false` | Built, inert |

The Powerswitch path: `powerswitchSession` resolves an address to a `pxid` and location id (persisted on the user row) → `powerswitchReplay` replays the questionnaire over HTTP → `powerswitchRscParser` parses the React Server Components flight stream → `powerswitchPlanMapper` shapes it for the comparator. `powerswitchCanary` runs daily against a fixture address to detect schema drift and sets a 48-hour KV flag.

Seeded plans were removed from live comparison (migration 0020). When Powerswitch returns nothing, fail honest — do not substitute fabricated data.

## 8. AI surfaces

**Model: `deepseek-v4-pro`.** `deepseek-chat` and `deepseek-reasoner` were **retired by DeepSeek on 24 July 2026**; code still referencing them is broken.

| Module | Role |
|---|---|
| `deepseek.ts` | Intent classification, escalation, disambiguation |
| `ingestionIntelligence.ts` | Retailer classification · **advisory validation of parser output** · bill summaries |
| `usageIntelligence.ts` | Trend, seasonality and anomaly narration |
| `comparisonIntelligence.ts` | Plain-language comparison explanation |

**Rule:** arithmetic always overrides the model. `reconcile_total` in the Python parser is the authority on whether a bill parsed correctly; the model advises and never decides.

Prompts live in `services/prompts/*.md` and are **duplicated as TS constants in `services/prompts.ts`**, because Workers cannot read `.md` at runtime. The duplication is a known maintenance hazard.

## 9. Python service

Flask + gunicorn on **Google Cloud Run** (`flip-python-360483648756.australia-southeast1.run.app`).

**→ Decided:** `python/fly.toml` is deleted and `python/DEPLOY.md` rewritten. Cloud Run is what runs; confirm no Fly app is still billing.

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | — | liveness |
| `POST /parse` | Bearer `SERVICE_AUTH_TOKEN` — **no-op if the env var is unset** | bill → structured fields |
| `POST /compare` | same | usage + plans → ranked comparison |

**Parse strategy:** the retailer-specific parser runs, then `GenericParser` **always** runs as well, and the higher-confidence result wins.

**Parsers:** contact, mercury, genesis, meridian, trustpower, nova, electric_kiwi, powershop, flick, pulse, plus generic. **→ Decided:** add Black Box Power, Grey Power and Electra.

**Validation:** `reconcile_total` with `RECONCILE_TOLERANCE = 0.10`; failure drops confidence to `RECONCILE_FAIL_CONFIDENCE = 0.5`. This — not a c/kWh range check — is the real guard.

**Comparator:** `SWITCH_THRESHOLD_CENTS = 20000`, `LOW_USER_ANNUAL_KWH_THRESHOLD = 8000`, `GST_RATE = 0.15`. GST basis is normalised before comparison.

## 10. External services

<!-- generated:hosts — derived from outbound https:// hosts in workers/src · verified by engine/drift.mjs · do not hand-edit inside this block -->
| Host | Purpose | From |
|---|---|---|
| `api.sent.dm` | WhatsApp/SMS send, templates, media | `messaging.ts`, `sentTemplates.ts` |
| `api.deepseek.com` | All four AI surfaces | four services |
| `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com` | Gmail OAuth and API | `gmailAuth.ts` |
| `www.powerswitch.org.nz` | Plan data | `powerswitchSession.ts`, `powerswitchScraper.ts` |
| `api.resend.com` | Ops and transactional email | `email.ts` |
| `www.emi.ea.govt.nz` | EIEP14A feed | `eiep14a.ts` (TS), `eiep14a/fetcher.py` |
| Cloud Run | Parse and compare | `billParser.ts`, `planComparator.ts` |
<!-- /generated:hosts -->

Outbound hosts Flip calls and processors that receive customer-derived data are different sets. `www.emi.ea.govt.nz` is an inbound plan-data feed — Flip sends it no customer data, so it is not a processor; the NZ retailer domains that appear in source are user-facing switch instructions, never fetched. Conversely, two processors are not outbound hosts at all: Cloudflare, because it is the platform Flip runs on, and Stripe, which is not live yet. The canonical processor list for privacy-policy purposes is PRD §10.2.

## 11. Security posture

- **Encryption:** AES-256-GCM via WebCrypto for phone and message body; SHA-256 blind index for phone lookup.
- **R2 bill PDFs:** Cloudflare default at-rest encryption only. Accepted.
- **Rate limiting:** DO-backed, fails closed.
- **Admin:** Bearer token only. No Cloudflare Access, no IP allowlist.
- **Turnstile:** not present. **→ Decided:** add to the public web signup flow.
- **PII in logs:** stripped by `errorHandler`.

### Known gaps
1. `POST /api/switch` unauthenticated.
2. `/eval` unauthenticated and writes production `users`/`bills` rows.
3. Remote migration ledger unknown (§5.2).
4. Data deletion not verified to cover R2 objects and Google OAuth token revocation.

## 12. Testing

- **Workers:** Vitest 3 with `@cloudflare/vitest-pool-workers` (real workerd, real bindings). 59 test files. Coverage thresholds set at 80% but `--coverage` is disabled in CI pending workerd support.
- **E2E:** `vitest.e2e.config.ts` — exists, passes, **not in CI**. **→ Decided:** add `npm run test:all`.
- **Python:** pytest, 23 modules, plus `scripts/eval_parser.py` which runs every committed fixture against its expected output and exits non-zero on mismatch.
- **CI:** `.github/workflows/ci.yml` — env-doc check, `tsc --noEmit`, eslint, vitest, `wrangler deploy --dry-run`, then pytest and the parser eval.

## 13. Deployment

Worker deploys via **Cloudflare Workers Builds** Git integration, production branch `master`.
Python deploys via `gcloud run deploy`.
Pages project serves `flipflop.co.nz`.

See `docs/OPERATIONS.md` for the runbook, secrets and environment detail.
