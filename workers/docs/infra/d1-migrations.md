# D1 Migrations — Setup & Operations

Operational runbook for the `flip-db` Cloudflare D1 database used by Flip's
Cloudflare Workers backend. All migrations live in `workers/migrations/` and are
applied directly via the Wrangler CLI.

## Database

- **Name**: `flip-db`
- **ID**: `9bdbc913-45d4-4b0b-afb0-1aa177cdc23a`
- **Binding** (in `wrangler.toml`): `DB`
- **Migrations folder**: `workers/migrations/`

## Migration Inventory

| # | Filename | Summary | Applied to remote |
|---|----------|---------|-------------------|
| 0001 | `0001_initial.sql` | Core schema: 9 tables (users, bills, retailers, plans, plan_comparisons, switches, messages, oauth_tokens, notifications) + 12 indexes | **APPLIED** via `execute --file` — 9 tables, 12 indexes on remote |
| 0002 | `0002_seed_retailers.sql` | Seed NZ retailer catalog | PENDING — to be applied via separate issue |
| 0003 | `0003_usage_metrics.sql` | Usage-metrics tables for bill ingestion | PENDING — to be applied via separate issue |
| 0004 | `0004_seed_test_plans.sql` | Seed test plans for dev | PENDING — to be applied via separate issue |
| 0005 | `0005_phone_encryption.sql` | Add `phone_encrypted` + `phone_hash` columns; lookup index | PENDING — to be applied via separate issue |
| 0006 | `0006_add_web_source.sql` | Add `'web'` to bills.source CHECK enum | PENDING — to be applied via separate issue |
| 0007 | `0007_seed_missing_retailers.sql` | Backfill additional NZ retailers | PENDING — to be applied via separate issue |
| 0008 | `0008_seed_additional_plans.sql` | Backfill additional plan rows | PENDING — to be applied via separate issue |
| 0009 | `0009_plan_data_provenance.sql` | Plan data provenance tracking | PENDING — to be applied via separate issue |

## Note on `plans.is_current`

The `plans` table (migration 0001) expresses "current plan" via
`effective_to IS NULL` rather than a boolean `is_current` column — see
`docs/ARCHITECTURE.md`. A real `is_current INTEGER` column will be added in
migration `0013` (issue #63, Epic 6 Wave 2) because the change-detection (#68)
and aggregator (#69) pipelines require a materialized versioning flag. No
`is_current` index exists in 0001 by design.

## Apply a Single Migration by File

Use this when a single migration needs to be applied out-of-band (for example,
during initial bootstrap or when staging changes individually).

```bash
cd workers
npx wrangler d1 execute flip-db --remote --file migrations/0001_initial.sql
```

- `--remote` targets the production D1; drop it for the local dev DB.
- `--file` reads SQL from disk and executes it as a single batch inside a
  transaction (atomic — all-or-nothing).
- Wrangler uploads the file first, then runs it. If any statement fails, the
  database rolls back to its pre-execution state and you can safely retry.

## Apply All Pending via the Migrations Table

Wrangler's standard migration tracker uses a `_cf_KV` / `d1_migrations` table
to know which files have already been applied. Use this once the tracker has
been initialised:

```bash
cd workers
npx wrangler d1 migrations apply flip-db --remote
```

This skips files that the tracker records as already applied. On first run,
Wrangler creates the migrations bookkeeping table.

> **Note**: 0001 was applied via `execute --file` directly, **without** going
> through the migrations tracker. If a subsequent `migrations apply` is run,
> Wrangler may attempt to re-apply 0001 unless the tracker is backfilled first.
> To backfill the tracker after an out-of-band apply, run
> `npx wrangler d1 migrations apply flip-db --remote` and let Wrangler report
> any conflicts; resolve per Wrangler's guidance.

## Rollback

0001 ships a `-- Down` block (commented-out `DROP TABLE` statements) for
documentation purposes. To reverse it, run the equivalent against the remote DB:

```bash
cd workers
# Apply the inverse in reverse dependency order
npx wrangler d1 execute flip-db --remote --command "
  DROP TABLE IF EXISTS notifications;
  DROP TABLE IF EXISTS oauth_tokens;
  DROP TABLE IF EXISTS messages;
  DROP TABLE IF EXISTS switches;
  DROP TABLE IF EXISTS plan_comparisons;
  DROP TABLE IF EXISTS plans;
  DROP TABLE IF EXISTS retailers;
  DROP TABLE IF EXISTS bills;
  DROP TABLE IF EXISTS users;
"
```

**Caveat**: later migrations (0002+) may have inserted seed data or added
columns/indexes that depend on 0001 tables. Dropping 0001 tables after later
migrations have been applied will fail or leave the schema in an inconsistent
state. Always drop in reverse order (highest-numbered migration first) and
back up first with `wrangler d1 export flip-db`.

## Verification Queries

Run these against the remote D1 to confirm the 0001 baseline is in place.

### Tables

```bash
npx wrangler d1 execute flip-db --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

Expected: `_cf_KV`, `bills`, `messages`, `notifications`, `oauth_tokens`,
`plan_comparisons`, `plans`, `retailers`, `switches`, `users`. (After 0005
applies, the `users` table also gains `phone_encrypted` + `phone_hash`
columns; that is expected and does not indicate 0001 was incomplete.)

### Indexes (excluding auto-created PK / UNIQUE)

```bash
npx wrangler d1 execute flip-db --remote --command \
  "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name;"
```

Expected after 0001 alone: `idx_bills_created_at`, `idx_bills_status`,
`idx_bills_user_id`, `idx_comparisons_user_id`, `idx_messages_created_at`,
`idx_messages_user_id`, `idx_notifications_user_id`, `idx_plans_region`,
`idx_plans_retailer_id`, `idx_switches_user_id`, `idx_users_phone`,
`idx_users_state`. After 0005, also `idx_users_phone_hash`.

### Required 0001 columns

```bash
npx wrangler d1 execute flip-db --remote --command \
  "SELECT name FROM pragma_table_info('users') ORDER BY cid;"
```

Expected 0001 columns: `id`, `phone`, `sent_contact_id`, `name`, `email`,
`subscription_tier`, `stripe_customer_id`, `current_retailer_id`,
`current_plan_name`, `icp_number`, `installation_address`,
`notification_threshold_cents`, `state`, `created_at`, `updated_at`.

## State at 0001 Apply Time

| Field | Value |
|-------|-------|
| Date | 2026-06-22 |
| Applied by | claude (Epic 1, Issue #16) |
| Command | `npx wrangler d1 execute flip-db --remote --file migrations/0001_initial.sql` |
| Pre-state | Remote D1 had 0 user-defined tables (according to lead's pre-issue report). |
| Post-state (intended) | 9 user tables (`bills`, `messages`, `notifications`, `oauth_tokens`, `plan_comparisons`, `plans`, `retailers`, `switches`, `users`) + 12 indexes from 0001. |
| Apply outcome | **Idempotent success** — table-creation errored because the schema already existed from a prior session; the existing remote state matches the expected 0001 end-state exactly (verified via `sqlite_master` queries). No destructive changes performed. |

## Pre-flight Checklist (Before Each Future Apply)

1. Confirm the migration file exists locally and is committed.
2. Confirm `wrangler` is authenticated (`wrangler whoami`).
3. Confirm you're in `workers/` (where `wrangler.toml` lives).
4. For destructive operations: back up first with `wrangler d1 export flip-db`.
5. After apply, run the verification queries above.
