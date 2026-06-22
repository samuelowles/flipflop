# Cloudflare Resources -- Verification

This document records the Cloudflare resources provisioned for the Flip
Workers project (`flip-api`), the verification commands used to confirm
each one, and the exact re-provisioning recipe in case the account is
reset. It is the artifact for issue **#14** and is kept in lock-step with
`workers/wrangler.toml`.

- **Account:** `f5e02cad5ec12b65f7c97ed9b86aa27f`
- **Region:** D1 storage is global on the Workers Free/Paid plans (not user-selectable); Worker runtime executes at the closest Cloudflare edge to the caller (e.g. `OC`/`AKL` for NZ traffic).
- **Verified on:** 2026-06-22
- **Worker:** `flip-api` (`workers/wrangler.toml`)

## Resource Inventory

| Type | Name | ID / UUID | Binding | Created (UTC) |
|------|------|-----------|---------|---------------|
| D1 (SQLite) | `flip-db` | `9bdbc913-45d4-4b0b-afb0-1aa177cdc23a` | `DB` | 2026-05-13T23:38:27.880Z |
| KV | `FLIP_KV` | `6f4e28e8f4db40608399ac840d58e2ff` | `KV` | (verified 2026-06-22) |
| R2 | `flip-bills` | n/a (bucket name) | `BILLS` | 2026-05-13T23:39:03.531Z |
| Queue (producer + consumer) | `flip-parse-queue` | `5aae4d9dbc244dad9bd8970fa114c978` | `PARSE_QUEUE` | 2026-05-13T23:38:44.866Z |
| Queue (producer + consumer) | `flip-compare-queue` | `6a452c8cb0c94f04a82e89f1774b8df9` | `COMPARE_QUEUE` | 2026-05-13T23:38:48.526Z |
| Queue (producer + consumer) | `flip-notify-queue` | `d686ecac11114f39a9c80fff2d4ad3b9` | `NOTIFY_QUEUE` | 2026-05-13T23:38:52.320Z |
| Cron triggers | n/a | 3 schedules: `0 3 * * *`, `0 6 * * *`, `0 14 * * *` | (see `[triggers]` `wrangler.toml` line 47) | — |

> Browser Rendering (`[browser]` binding in `wrangler.toml`) is planned for #66 (Powerswitch scraper) and is not yet declared in `wrangler.toml` as of 2026-06-22.

## Acceptance Criteria Checklist

| # | AC | Status | Verification command |
|---|----|--------|---------------------|
| 1 | `wrangler d1 create flip-db` succeeds; `database_id` in `[[d1_databases]]` | PASS | `npx wrangler d1 list` shows `flip-db` (`9bdbc913-…`); `wrangler.toml` lines 6-9 binds it as `DB` |
| 2 | `wrangler kv:namespace create FLIP_KV` succeeds; `id` in `[[kv_namespaces]]` | PASS | `npx wrangler kv namespace list` shows `FLIP_KV` (`6f4e28e8…`); `wrangler.toml` lines 11-13 binds it as `KV` |
| 3 | `wrangler r2 bucket create flip-bills` succeeds; `bucket_name` in `[[r2_buckets]]` | PASS | `npx wrangler r2 bucket list` shows `flip-bills`; `wrangler.toml` lines 42-44 binds it as `BILLS` |
| 4 | Three queues created (`flip-parse-queue`, `flip-compare-queue`, `flip-notify-queue`); producer bindings `PARSE_QUEUE`, `COMPARE_QUEUE`, `NOTIFY_QUEUE` | PASS | `npx wrangler queues list` shows all three; `wrangler.toml` lines 15-25 declare all three producers |
| 5 | Consumer config: parse `batch=1 concurrency=3`, compare `batch=1 concurrency=2`, notify `batch=1 concurrency=5` | PASS | `wrangler.toml` lines 27-40 declare the exact `max_batch_size = 1` and per-queue `max_concurrency` |

### Live-reachability checks

- `npx wrangler d1 execute flip-db --remote --command "SELECT 1"` -- `success: true`, served by `v3-prod` in `OC` / `AKL`, `sql_duration_ms: 0.341`. Confirms D1 is reachable end-to-end.
- `npx wrangler kv key list --namespace-id 6f4e28e8f4db40608399ac840d58e2ff` -- returned `[]` (empty). Confirms KV is reachable end-to-end; the namespace is fresh and not yet populated by application code.
- Queue producers are listed in `wrangler queues list` (1 producer per queue) and consumers are wired in `wrangler.toml` (`max_batch_size = 1` and the required `max_concurrency` per queue). Workers will pull from the queues once `wrangler deploy` runs them.

## How to re-provision

If the account is reset, run from the `workers/` directory. Copy the
returned IDs into `wrangler.toml` immediately after each step.

```bash
# 0. Authenticate
npx wrangler login

# 0a. Pre-checks (skip any create step whose resource already exists)
npx wrangler d1 list
npx wrangler kv namespace list
npx wrangler r2 bucket list
npx wrangler queues list

# 1. D1 database (skip if "flip-db" appears in d1 list above)
npx wrangler d1 create flip-db
# -> paste database_id into [[d1_databases]] as binding = "DB"

# 2. KV namespace (skip if "FLIP_KV" appears in kv namespace list above)
npx wrangler kv:namespace create FLIP_KV
# -> paste id into [[kv_namespaces]] as binding = "KV"

# 3. R2 bucket (skip if "flip-bills" appears in r2 bucket list above)
npx wrangler r2 bucket create flip-bills
# -> bucket_name goes into [[r2_buckets]] as binding = "BILLS"

# 4. Queues (skip any queue that already exists in queues list above)
npx wrangler queues create flip-parse-queue
npx wrangler queues create flip-compare-queue
npx wrangler queues create flip-notify-queue
# -> producers are wired in wrangler.toml [[queues.producers]]
# -> consumers are wired in wrangler.toml [[queues.consumers]]

# 5. Verify
npx wrangler d1 list
npx wrangler kv namespace list
npx wrangler r2 bucket list
npx wrangler queues list
npx wrangler d1 execute flip-db --remote --command "SELECT 1"
```

The `[[queues.consumers]]` block in `wrangler.toml` does the queue ->
worker wiring at deploy time, so no additional `wrangler` calls are
required once the queues exist.

## Rollback

Delete commands for the resources above. **Destructive and irreversible** — verify the account and confirm with the team before running.

```bash
# 1. Empty and delete the R2 bucket first (R2 cannot be deleted while non-empty)
npx wrangler r2 object delete --bucket=flip-bills --all --force
npx wrangler r2 bucket delete flip-bills

# 2. Delete queues (must be empty / unbound)
npx wrangler queues delete flip-parse-queue
npx wrangler queues delete flip-compare-queue
npx wrangler queues delete flip-notify-queue

# 3. Delete the KV namespace
npx wrangler kv namespace delete --namespace-id 6f4e28e8f4db40608399ac840d58e2ff

# 4. Delete the D1 database (interactive confirmation prompt)
npx wrangler d1 delete flip-db

# 5. Delete the Worker itself (last; leaves bindings orphaned in wrangler.toml)
npx wrangler delete
```

After rollback, the bindings in `wrangler.toml` will fail to deploy until
removed or re-pointed at new resource IDs.

## Cost model

For current authoritative pricing see
<https://developers.cloudflare.com/workers/platform/pricing/>. The
resource set above fits within Cloudflare's Workers Free plan daily
allowances (Workers 100k req/day, D1 5M row reads/day, KV 100k reads/day,
R2 10 GB storage, Queues 1M msgs/month) at Phase 1 expected traffic
(~1k bills/day). Paid-plan overages begin if bill volume exceeds ~30k
rows/month or storage exceeds 10 GB.

## Token scopes required

`wrangler` is currently authenticated via OAuth against account
`f5e02cad5ec12b65f7c97ed9b86aa27f`. The OAuth token ships with these
scopes:

- `account:read`
- `user:read`
- `workers:write`

Read operations (`list`, `get`, `execute SELECT 1`) all work with the
above scopes and were used for verification.

For provisioning (i.e. `d1 create`, `kv:namespace create`, `r2 bucket
create`, `queues create`) the token must additionally carry the
following scopes -- these are **not** currently included in the OAuth
token used for verification and will need to be added before any of the
re-provision commands above can succeed:

- `d1:write`
- `workers_kv:write`
- `r2:write`
- `queues:write`

The `workers:write` scope alone is sufficient for `wrangler deploy` and
for editing the queue consumer wiring, but the per-resource write scopes
above are required to create new resources from scratch. If any
re-provision step fails with `Authentication error [code: 10000]`, the
fix is to add the missing scope to the token in the Cloudflare dashboard
under *Workers & Pages -> API tokens* and re-run the affected step.
