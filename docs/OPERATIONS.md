# Flip — Operations

**Version 1.0 · 2026-08-18** · Merges the former `DEPLOY.md` and `TESTING_RUN.md`. Both are superseded.

**This file is the canonical secrets list.** `scripts/check-env-docs.mjs` validates against it in CI. Adding a secret to the Worker without adding it here fails the build.

---

## 1. Environments

| Environment | State |
|---|---|
| Production | Worker `flip-api`, D1 `flip-db`, live |
| **Staging** | **→ To build.** Own D1, KV and queues, with `FLOW_TEST_MODE=true` |

There is one environment today, and `ENVIRONMENT="production"` is set on it — which alone hard-disables `FLOW_TEST_MODE`. That is correct for production and is why staging is needed: there is currently nowhere safe to force an end-to-end trace.

## 2. Secrets — canonical list

Set with `wrangler secret put <NAME>`.

<!-- generated:env — derived from env.X reads under workers/src · verified by engine/drift.mjs · do not hand-edit inside this block -->
| Secret | Purpose |
|---|---|
| `ADMIN_API_KEY` | Bearer token for `/admin/*` and `/flow/status` |
| `DEEPSEEK_API_KEY` | All four AI surfaces |
| `EIEP14A_API_KEY` | Electricity Authority feed (inert until October) |
| `ENCRYPTION_KEY` | AES-256-GCM for phone and message body; also derives signed-link HMAC |
| `GMAIL_CLIENT_ID` | Google OAuth |
| `GMAIL_CLIENT_SECRET` | Google OAuth |
| `OPS_EMAIL` | Destination for operational alerts |
| `PYTHON_SERVICE_AUTH_TOKEN` | Bearer to the Cloud Run parser |
| `PYTHON_SERVICE_URL` | Cloud Run base URL |
| `RESEND_API_KEY` | Operational and transactional email |
| `SENT_API_KEY` | sent.dm send |
| `SENT_WEBHOOK_SECRET` | HMAC verification of inbound sent.dm webhooks |
<!-- /generated:env -->

Optional: `SENT_API_BASE_URL` (defaults to `https://api.sent.dm/v1`).
**Required when Stripe lands:** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.

### 2.1 `ENCRYPTION_KEY` format

Accepts hex or base64. A key generated the way earlier docs described broke every encrypt — commit `17aad66`. Generate with `openssl rand -hex 32` and verify a round-trip through `/eval` before relying on it.

### 2.2 `SENT_WEBHOOK_SECRET`

Undocumented for a period, during which **all inbound messaging was silently dead** — commit `850fc47`. If inbound stops working, check this first.

## 3. Deployment

### Worker
Cloudflare Workers Builds Git integration. **Production branch is `master`.** A merge to `master` deploys.

Manual: `cd workers && npx wrangler deploy`
Dry run (also runs in CI): `npx wrangler deploy --dry-run`

### Python service
```bash
cd python
gcloud run deploy flip-python --source . --region australia-southeast1
```
Live at `flip-python-360483648756.australia-southeast1.run.app`.

> `python/fly.toml` has been deleted. **Cloud Run is the deployment target.** Confirm no Fly.io app is still billing — verification item V-2.

### Pages
`flipflop.co.nz` serves the signup flow, account area and legal pages.
**→ The Worker moves to `app.flipflop.co.nz`.** Update the Google OAuth redirect URIs and the CORS posture at the same time; a half-migrated redirect URI breaks Gmail connect silently.

## 4. Database

### 4.1 The migration ledger problem — read before touching D1

**The remote D1 has no `d1_migrations` ledger.** `wrangler d1 migrations apply` must not be run against production: it would attempt every migration from 0001 against a database that already has most of them.

Nobody currently knows which of the 21 migrations production is on.

**Resolution procedure — human-gated, single attempt, unrecoverable if wrong:**

1. Dump the live schema: `npx wrangler d1 execute flip-db --remote --command "SELECT sql FROM sqlite_master"`
2. Diff against the 21 files in `workers/migrations/`
3. Identify the highest applied migration
4. Hand-insert the corresponding `d1_migrations` rows
5. Verify: `npx wrangler d1 migrations list flip-db --remote` reports zero pending
6. Only then resume normal migration flow

Take a backup first. This is verification item **V-1** and blocks every subsequent schema change.

### 4.2 Local

```bash
npx wrangler d1 migrations apply flip-db --local
```

## 5. Feature flags

Set in `wrangler.toml` `[vars]`. Changing one requires a deploy.

| Flag | Value | Effect |
|---|---|---|
| `POWERSWITCH_LIVE` | `true` | Live per-user Powerswitch queries. **Turning this off silently degrades every comparison to no plan data.** |
| `EIF_EIEP14A_ENABLED` | `false` | Arms EIEP14A ingestion. **Flip to `true` when the EA feed goes live in October** |
| `POWERSWITCH_SCRAPER_ENABLED` | `false` | Public plan-page scrape |
| `FLOW_TEST_MODE` | `false` | Bypasses threshold and cooldowns. Structurally disabled when `ENVIRONMENT="production"` |
| `F1_HINT_CONFIDENCE_THRESHOLD` | `0.85` | Below this, a parsed bill routes to review |

## 6. Runbooks

### 6.1 Force an end-to-end trace

Requires a staging environment with `FLOW_TEST_MODE=true`.

1. `POST /admin/test-run/reset` with the admin bearer, to clear the user's KV flow state
2. Send a bill through the intended channel
3. `GET /admin/flow-link` to mint a signed trace link
4. Watch `/flow/status` — seven stages: ingest → parse → powerswitch → compare → notify-eval → send → done
5. A skipped stage names its reason in the trace

### 6.2 Inbound messaging is dead

In order: `SENT_WEBHOOK_SECRET` set and matching sent.dm's configuration → sent.dm webhook URL points at the current Worker host → `SENT_API_KEY` valid → check for 404s from `api.sent.dm`, which historically indicated incomplete sent.dm onboarding.

### 6.3 A bill will not parse

`bills.status = 'needs_review'` with `error_code` set. Fetch the R2 object at `raw_r2_key` and run it against the Python service directly. If the retailer is new, check `retailers.email_domains`.

The customer is told honestly and asked to resend — silence after someone hands over a bill is the worse failure.

### 6.4 Powerswitch drift

The 10:00 UTC canary replays a fixture address and sets a 48-hour KV drift flag on schema change. On alert, run `powerswitchReplay` against the fixture manually and compare against `powerswitchLiveFixtures`. Powerswitch is a third-party site with no contract — drift is expected, not exceptional.

### 6.5 Data deletion request

`dataDeletion.ts` deletes child rows in explicit order, because no user foreign key cascades.

**Verify all three:** D1 rows gone · R2 bill objects gone · **Google OAuth token revoked**. The revocation step is the one most likely to be missed. Verification item V-4 in the decisions log.

### 6.6 A template copy change is not live on WhatsApp

WhatsApp template bodies are approved by Meta, so editing one in `services/sentTemplates.ts` does not re-register it. `submitTemplate` had zero callers until `POST /admin/templates/submit` was wired, which is why #265's corrected `saving_alert` copy shipped but never reached WhatsApp.

```bash
curl -sS -X POST -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" -d '{"names":["saving_alert"]}' \
  <WORKER_URL>/admin/templates/submit
```

Omit the body to submit all six; poll `GET /admin/templates/status` for the outcome. Approval is asynchronous (1-4 weeks). **SMS is unaffected** — it sends the same body verbatim and immediately, so the notify stage keeps working over SMS while approval is pending.

## 7. Retention

Enforced by scheduled purge.

| Data | Window |
|---|---|
| Bills and R2 objects | 24 months |
| Comparisons | 24 months |
| Messages | 12 months |
| LLM audit | 30 days (live) |
| Notification audit | 90 days (live) |

The first three are **not yet implemented**.

## 8. Alerting

Ops email to `OPS_EMAIL` via Resend on switch failure. That is the whole alerting surface today.

**Should exist:** parse failure rate above baseline · Powerswitch drift flag set · queue depth or DLQ non-zero · DeepSeek or sent.dm error rate · daily spend above budget.

## 9. CI

`.github/workflows/ci.yml`, on pull request, push to `master`, and manual dispatch.

**Job `ci`** (working directory `workers`, Node 22): `npm ci` → `npm run check:env-docs` → `tsc --noEmit` → `eslint .` → `vitest run` → `wrangler deploy --dry-run`
**Job `python-eval`** (Python 3.13): install both requirement files → `pytest python/ -q` → `python scripts/eval_parser.py`

**→ To add:** `npm run test:all` so the existing e2e suite actually runs, and the drift detector.

Coverage thresholds are configured at 80% but `--coverage` is disabled pending coverage-v8 support in workerd. The thresholds do not currently gate anything.

## 10. Cost

| Item | Notes |
|---|---|
| Cloudflare Workers Paid | $5/month |
| Google Cloud Run | Per-request; scales to zero |
| DeepSeek | Per-token across four surfaces |
| sent.dm | Per-message |
| Resend | Free tier adequate |

**Break-even must be recomputed** at $59/year against real costs. The published figure derives from a superseded $30 price and pre-Powerswitch usage. Estate rule D-08 applies: no published unit economic may rest on a proxy rate.

## 11. Launch gate

1. Legal entity formed; privacy policy and terms live
2. Stripe live
3. Parser accuracy met on real bills — >90% top five, >80% elsewhere
4. **sent.dm sends confirmed working** (pending approval on their side)
5. **D1 migration ledger rebuilt and verified**
6. Data deletion verified across D1, R2 and OAuth revocation
7. Seven consecutive green end-to-end trace runs
