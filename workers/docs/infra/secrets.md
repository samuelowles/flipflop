# Cloudflare Workers — Secrets Setup

This document is the source of truth for the secret inventory on the
`flip-api` Cloudflare Worker. It records which secrets exist, how to set a
new one, and how to validate the inventory from CI.

For the broader security policy (encryption scheme, webhook validation, PII
handling) see `.claude/instructions/security.md`.

---

## Inventory (verified `npx wrangler secret list`)

| Secret name            | AC required? | Status (verified) | Recommended source                                            |
| ---------------------- | ------------ | ----------------- | ------------------------------------------------------------- |
| `ADMIN_API_KEY`        | yes          | SET               | Self-generated — see "Generating keys" below                   |
| `DEEPSEEK_API_KEY`     | yes          | SET               | OpenRouter dashboard (https://openrouter.ai/keys)             |
| `ENCRYPTION_KEY`       | yes          | SET               | Self-generated via `openssl rand -hex 32` (see below)         |
| `SENT_API_KEY`         | yes          | SET               | Sent dashboard (https://sent.com/dashboard)                   |
| `SENT_WEBHOOK_SECRET`  | yes          | SET               | Sent dashboard — webhook signing secret                       |
| `STRIPE_SECRET_KEY`    | yes          | **MISSING**       | https://dashboard.stripe.com/apikeys                          |
| `STRIPE_WEBHOOK_SECRET`| yes          | **MISSING**       | https://dashboard.stripe.com/webhooks                         |
| `GMAIL_CLIENT_ID`      | extra        | SET               | Google Cloud Console — OAuth client                           |
| `GMAIL_CLIENT_SECRET`  | extra        | SET               | Google Cloud Console — OAuth client                           |
| `PYTHON_SERVICE_AUTH_TOKEN` | extra   | SET               | Shared secret between Worker and Python bill-parser service   |
| `PYTHON_SERVICE_URL`   | extra        | SET               | URL of the Python bill-parser service                         |

**Acceptance criteria (issue #15) requires all 7 "AC required" secrets to be
set.** 5 of 7 are set. The remaining two (`STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`) are owned by the Stripe account holder and must be
provisioned manually — see "Missing secrets" below.

---

## How to set a secret

Use `wrangler secret put` from the `workers/` directory:

```bash
cd workers
printf "%s" "$VALUE" | npx wrangler secret put SECRET_NAME
```

Notes:

- `printf` (not `echo`) avoids a trailing newline appended to the value.
- For multi-environment setups, pass `--env <name>` (e.g. `--env production`).
- Wrangler reads the value from stdin so it never lands in shell history or
  a file. Confirm via `npx wrangler secret list` after each set.

To update an existing secret, run the same command — Wrangler overwrites
in place. There is no separate `update` verb.

To delete a secret (rare — destructive, audit first):

```bash
npx wrangler secret delete SECRET_NAME
```

---

## Missing secrets (manual setup required)

These are the gaps between the current inventory and the AC spec:

### `STRIPE_SECRET_KEY`

- **Source:** https://dashboard.stripe.com/apikeys
- **Type:** secret key (`sk_live_...` for production, `sk_test_...` for test).
- **Notes:** Use the restricted key with the minimum scopes needed (read
  customers, write checkout sessions, etc). Never use the full-access key.

### `STRIPE_WEBHOOK_SECRET`

- **Source:** https://dashboard.stripe.com/webhooks
- **Type:** webhook signing secret (`whsec_...`) tied to the deployed
  endpoint URL.
- **Notes:** Stripe shows this secret once when the endpoint is created.
  Store it in a password manager before navigating away. If lost, click
  "Roll secret" on the endpoint to regenerate.

Both must be set with real values from the Stripe dashboard before the
worker can serve Stripe webhooks or create checkout sessions. They are not
generated locally.

---

## Validation strategy

`wrangler secret put` does not return the stored value — values can only be
**listed by name**, never retrieved. The only way to assert presence from
automation is to compare the output of `npx wrangler secret list` against
the expected name set.

### Recommended CI check (future)

Add a job that runs against a Cloudflare API token with read-only access to
the account:

```bash
npx wrangler secret list | jq -r '.[].name' | sort > /tmp/secret_names
diff -u /tmp/secret_names docs/infra/secrets.expected_names
```

Where `docs/infra/secrets.expected_names` lists the 7 AC-required secret
names, one per line. The job fails if any are missing or if an unexpected
secret has appeared. This is not implemented in CI yet — tracked separately
from issue #15.

### Manual verification (this document's basis)

Run from `workers/`:

```bash
npx wrangler secret list
```

Expected (per the AC): all 7 names in the inventory table above appear in
the response. The verification captured in the "Inventory" section above
was performed with this command on 2026-06-22.

---

## `ENCRYPTION_KEY` generation

`ENCRYPTION_KEY` must be a 256-bit key encoded as 64 hexadecimal characters.
Generate it once and store it in a password manager before running
`wrangler secret put`:

```bash
openssl rand -hex 32
```

Output looks like `a3f1...c8e0` — 64 hex chars representing 32 random bytes.
This is the AES-256-GCM key used to encrypt PII at rest in D1 (see
`.claude/instructions/security.md`, "Encryption at Rest").

**Note:** because `wrangler secret list` only returns names (not values),
we cannot inspect the existing `ENCRYPTION_KEY` to confirm its length. We
trust that it was generated correctly when it was originally set. If the
key is ever rotated, regenerate via the command above and re-run
`printf "%s" "$NEW_KEY" | npx wrangler secret put ENCRYPTION_KEY`.

---

## Generating other self-managed keys

- `ADMIN_API_KEY` — any high-entropy random string. `openssl rand -hex 32`
  is sufficient. Rotate quarterly.
- `PYTHON_SERVICE_AUTH_TOKEN` — same generation strategy. Both sides
  (Worker and Python service) must hold the same value.

---

## Security notes

- **Never commit `.env` files.** Both the root `.gitignore` and
  `workers/.gitignore` exclude `.env` and `.env.*` (with `.env.example`
  explicitly allowed). Verify before every commit.
- **Never put a secret value in `wrangler.toml`.** The committed file
  contains only resource bindings (D1, KV, R2, queues, cron triggers,
  non-secret `[vars]`). All sensitive values live in `wrangler secret`,
  which is encrypted at rest by Cloudflare.
- **Source references.** Worker code references secrets via
  `env.SENT_API_KEY` etc. — never via hardcoded literals. The codebase
  grep for hardcoded secret values is part of pre-merge review.
- **OAuth scope.** The Cloudflare OAuth token in use has `workers:write`,
  which is sufficient to set and list secrets. It is the minimum scope
  required for this workflow.
- **Test fixtures.** Test files (`*.test.ts`) reference short placeholder
  strings like `'test-key'` or `'TEST_SECRET'` — these are fixtures, not
  real secrets, and never reach production.
- **Audit log.** Every `wrangler secret put` call is recorded in the
  Cloudflare account audit log. Review monthly.
