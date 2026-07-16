# TESTING_RUN.md — Operator end-to-end live testing runbook

Issue #242 (Epic 13 close-out). Everything an operator needs to go from zero to
a completed `/auth/gmail → switch` trace against a **real** Cloudflare deployment,
with the expected terminal state at every stage. Read top to bottom the first time;
after that §3 (the run) + §5 (reset) are all you need.

> **Live operation is authorized.** Compliance Gate 1 (Consumer NZ sign-off) was
> recorded 2026-07-16 in `docs/POWERSWITCH_COMPLIANCE.md` (PR #244). Setting
> `POWERSWITCH_LIVE="true"` + `FLOW_TEST_MODE="true"` in `workers/wrangler.toml`
> (this issue) **is** Gate 2. See §6 for the hard rules that still apply.

All commands assume your shell is at the repo root unless noted (`cd workers` is
called out where needed). Replace `<WORKER_URL>` with your deployed origin, e.g.
`https://flip-api.<your-subdomain>.workers.dev`.

---

## 1. Prerequisites

### 1a. Cloudflare account + Wrangler login
```bash
npx wrangler login          # one-time; authenticate the account that owns flip-api
npx wrangler whoami         # confirm you are logged in
```
The bindings (D1 `flip-db`, KV, R2 `flip-bills`, the three queues, `RATE_LIMITER`)
and `[vars]` are already declared in `workers/wrangler.toml` — nothing to add there.

### 1b. Secrets checklist
`workers/wrangler.toml` already carries every non-secret `[vars]` flag the flow
needs (`POWERSWITCH_LIVE`, `FLOW_TEST_MODE`, `EIF_EIEP14A_ENABLED=false`,
`POWERSWITCH_SCRAPER_ENABLED=false`, `F1_HINT_CONFIDENCE_THRESHOLD`). The
sensitive values below are **not** in the repo — set each with (run from `workers/`):

```bash
cd workers
npx wrangler secret put GMAIL_CLIENT_ID            # Google OAuth client id
npx wrangler secret put GMAIL_CLIENT_SECRET        # Google OAuth client secret
npx wrangler secret put ENCRYPTION_KEY             # 32-byte hex; used for phone/token encryption
npx wrangler secret put SENT_API_KEY               # Sent (WhatsApp) API key — drives the notify stage
npx wrangler secret put DEEPSEEK_API_KEY           # DeepSeek NLU (classification in the parse stage)
npx wrangler secret put PYTHON_SERVICE_URL         # Python comparator/parser service origin, e.g. https://<python-host>
npx wrangler secret put PYTHON_SERVICE_AUTH_TOKEN  # bearer token the Worker sends to the Python service
npx wrangler secret put ADMIN_API_KEY              # admin Bearer for /admin/* (reset, flow-link, etc.)
npx wrangler secret put RESEND_API_KEY             # email sending (post-connect confirmation)
npx wrangler secret put OPS_EMAIL                  # operator address for operational alerts
```
Optional / currently inert:
- `EIEP14A_API_KEY` — only required if you flip `EIF_EIEP14A_ENABLED="true"` (the
  EA feed lands ~October). Leave unset for this run.

> Enumerated from `grep -rhoE "env\.[A-Z][A-Z0-9_]+" workers/src` — no hand-waving.
> Bindings (`DB`, `KV`, `BILLS`, `PARSE_QUEUE`, `COMPARE_QUEUE`, `NOTIFY_QUEUE`,
> `RATE_LIMITER`) come from `wrangler.toml`, not `secret put`.

### 1c. Google OAuth test-mode app
- A Google Cloud OAuth app in **Testing** mode, with the operator's Gmail address
  added as a **test user**.
- **Authorized redirect URI:** `​<WORKER_URL>/auth/gmail/callback` (the Worker
  derives this from the request host — `routes/gmail.ts`). Add exactly this URI to
  the OAuth app's "Authorized redirect URIs".
- The `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` you set in 1b come from this app.

### 1d. Test Gmail inbox
A Gmail inbox (the test user's) containing **at least one real NZ power-bill PDF**
from a supported retailer (see `python/fixtures/` for the supported list). The
scan stage will find it; the parse stage will parse it.

### 1e. WhatsApp-capable phone
The phone number you enter in `/auth/gmail` must be able to receive a WhatsApp
message — that is the `notify` stage's deliverable. Use E.164 (`+64…`).

---

## 2. Deploy

From the repo root:

```bash
# 2a. Apply every D1 migration to the REMOTE database (0001 → 0018).
cd workers
npx wrangler d1 migrations apply flip-db --remote
cd ..

# 2b. Deploy the Worker.
cd workers
npx wrangler deploy
cd ..

# 2c. Health check — expect HTTP 200.
curl -sS -o /dev/null -w '%{http_code}\n' <WORKER_URL>/health    # → 200
```

If 2c is not `200`, do not proceed — check `npx wrangler tail` (in a separate
terminal) and re-run deploy. The deploy itself must succeed locally first:

```bash
cd workers && npx wrangler deploy --dry-run --outdir /tmp/dryrun && cd ..   # must succeed
```
(This dry-run is also a CI gate — see `.github/workflows/ci.yml`.)

---

## 3. The run

1. Open **`<WORKER_URL>/auth/gmail`** in a browser.
2. Enter your WhatsApp-capable phone (E.164) and submit → Google consent screen.
3. Complete consent → you land on the callback page.
4. Click **"Watch your pipeline live"** → the trace page (`/flow/status`) polls
   `status.json` every 2s and renders the seven stages below.

   > If you closed the page, mint a fresh signed link from the admin endpoint and
   > open it: `curl -sS -H "Authorization: Bearer $ADMIN_API_KEY" "<WORKER_URL>/admin/flow-link?phone=%2B64..."`

### Expected terminal state — 7-stage table

| # | Stage | Expected state for this config | Notes |
|---|-------|--------------------------------|-------|
| 1 | `connect` | `ok` | Gmail OAuth connected. Detail: the connected account. |
| 2 | `scan` | `ok — n bills found` | `n` ≥ 1. Duplicates (same `source_message_id`) report `skipped_duplicate`. |
| 3 | `parse` | `ok — confidence ≥ threshold` | Threshold = `F1_HINT_CONFIDENCE_THRESHOLD` (0.85). Below → routed to manual review. |
| 4 | `powerswitch` | `ok — ≥5 plans` | **Live.** The capture returned 15 plans across 9 retailers. ICP is never submitted. |
| 5 | `compare` | `ok — recommendation switch\|stay_put` | Python comparator vs the live plan set. |
| 6 | `notify` | `ok — WhatsApp received on the test phone` | `FLOW_TEST_MODE` bypasses cooldown/threshold so the send always fires while a trace is active. |
| 7 | `switch` | `skipped` | Switch only runs on an explicit `POST /api/switch`. By design. |

The trace reaches **`notify ok`** — the success criterion for this run. The
WhatsApp message is the physical proof; the trace row is the digital proof.

---

## 4. Troubleshooting

In a separate terminal, tail structured logs and grep the `type`:

```bash
npx wrangler tail                # live, all logs
# or filter:   npx wrangler tail | jq -R 'fromjson? | select(.type=="<TYPE>")'
```

| Stage | Likely failure | `type` to grep | Fix |
|-------|----------------|----------------|-----|
| `connect` | OAuth redirect/credential misconfig | `gmail_login`, `gmail_callback_error` | Verify `GMAIL_CLIENT_ID`/`SECRET`, and that `<WORKER_URL>/auth/gmail/callback` is an authorized redirect URI in the Google app. |
| `scan` | Gmail API error / no bill found | `gmail_poll_error`, `gmail_message_skip`, `gmail_poll_summary` | Confirm the test inbox has a supported-retailer bill PDF; confirm OAuth scopes; check `gmail_message_skip` reasons. |
| `parse` | Low confidence / unsupported retailer | (parser service logs; trace `parse` detail carries the reason) | Use a bill PDF from a supported retailer (`python/fixtures/`); below-threshold bills go to manual review, not failure. |
| `powerswitch` | Disabled / drift / 0 plans | `powerswitch_live_disabled`, `powerswitch_canary_drift`, `powerswitch_canary_error` | Confirm `POWERSWITCH_LIVE="true"`. If the canary flagged drift, user replays are skipped until the canary clears the flag (next 0 10 * * * cron). |
| `compare` | Python service unreachable / auth | `powerswitch_compare_notify_failed` | Verify `PYTHON_SERVICE_URL` + `PYTHON_SERVICE_AUTH_TOKEN`; check the Python service is up. |
| `notify` | Send failure / skipped | `notify_send_error`, `notify_skip`, `notify_test_mode_bypass`, `notify_sent` | `notify_test_mode_bypass` confirms `FLOW_TEST_MODE` fired. `notify_send_error` → check `SENT_API_KEY`. `notify_skip` → read the detail for the guard that fired. |
| `switch` | — | — | `skipped` is correct. Only `POST /api/switch` triggers it. |

---

## 5. Reset for a re-run

To run the flow again for the same user **cleanly**, clear that user's per-user
state. The deletion is scoped to one user — global keys (`powerswitch:drift`,
`powerswitch:budget:day:*`) are never touched.

```bash
cd workers
# By phone (resolves to userId server-side):
npm run test-run:reset -- --phone +64... --url <WORKER_URL> --key "$ADMIN_API_KEY"
# Or by userId directly:
npm run test-run:reset -- --userId <id>     --url <WORKER_URL> --key "$ADMIN_API_KEY"
# Flags default from env: $FLIP_API_URL, $ADMIN_API_KEY. Run --help for full options.
npm run test-run:reset -- --help
```

This clears, for the one user: `flow:{userId}` (trace), `powerswitch:results:{userId}`
(replay cache), `gmail:lastPoll:{userId}` (poll cursor), `gmail:scan:{userId}`
(scan progress), `state:{userId}` (conversation state), and the notify/compare
dedup + cooldown keys (`notify_cooldown:{userId}:*`, `dedup:{userId}:*`,
`cooldown:{userId}:*`, `notified:{userId}:*`). The key list is built server-side
from the **real** KV-key constants (`services/testRunReset.ts` imports them), so it
cannot drift — verified by `services/testRunReset.test.ts`.

> **Bills dedup persists by design.** Bills are de-duplicated by `source_message_id`
> in D1, so a re-run reports `skipped_duplicate` for already-ingested bills — that is
> correct, not a bug. To force a full re-ingest, delete that user's bills rows in D1:
> ```bash
> cd workers && npx wrangler d1 execute flip-db --remote \
>   --command "DELETE FROM bills WHERE user_id = '<userId>'" && cd ..
> ```

---

## 6. Compliance note

- **Gate 1 (Consumer NZ sign-off): SATISFIED** — recorded 2026-07-16 in
  `docs/POWERSWITCH_COMPLIANCE.md` (PR #244).
- **Gate 2 (live operation authorization): setting `POWERSWITCH_LIVE="true"` in
  this issue IS Gate 2.** With both gates met, live per-user traffic is fully
  authorized.
- **Hard rules unchanged:** ICP is **never** submitted (verified `null`/`$undefined`
  in the wire layer, asserted by `assertNoIcpValue`); per-day request budget;
  sequential POSTs with inter-request delay + backoff; identified UA; daily drift
  canary. See `docs/POWERSWITCH_COMPLIANCE.md` for the full table.

---

## Success criteria recap (issue #242)

- [x] `wrangler deploy --dry-run` green locally **and** in CI (`.github/workflows/ci.yml`).
- [x] `tsc --noEmit` clean; `vitest run` green.
- [x] `npm run test-run:reset` exists, has `--help`, and `testRunReset.test.ts`
      covers its key list against the real imported constants (no string drift).
- [x] This runbook: every command copy-pasteable; no placeholder unresolved except
      operator secrets + `<WORKER_URL>`; 7-stage expected-state table present.
- [ ] **Manual AC (operator):** a full deploy + run per §2–§3 was executed against a
      real Cloudflare account and the trace reached `notify ok`. Record the outcome
      (WhatsApp received + trace screenshot/text) in the PR. If a stage failed,
      document which and why per §4.
