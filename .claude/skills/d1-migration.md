# D1 Migration Skill

## Purpose
Create and validate D1 schema migrations for Flip's Cloudflare D1 database. Follows the project's migration conventions and schema design.

## Schema Reference
All 9 tables are defined in `docs/ARCHITECTURE.md` under "Database Schema (D1)". Always reference this document before creating or modifying migrations.

## Migration File Convention
- Location: `workers/migrations/`
- Naming: `NNNN_descriptive_name.sql` (e.g., `0001_initial.sql`, `0002_add_notifications.sql`)
- Numbering: sequential, zero-padded to 4 digits
- Each migration is a single `.sql` file

## Workflow

### 1. Check Current Migrations
```bash
ls workers/migrations/
```
Identify the next migration number (highest existing + 1).

### 2. Create Migration File
Write the SQL file with:
- `-- Migration NNNN: descriptive name` header comment
- `-- Up` section with CREATE/ALTER statements
- `-- Down` section with DROP/ROLLBACK statements (for reversibility)

### 3. Apply Migration
```bash
cd workers
npx wrangler d1 execute flip-db --local --file migrations/NNNN_descriptive_name.sql
```

### 4. Validate Schema
```bash
npx wrangler d1 execute flip-db --local --command ".schema"
```
Verify the schema matches expectations.

### 5. Test with Local D1
Run the test suite against the local D1 instance:
```bash
npm test
```

## Rules
- All tables use TEXT UUIDs as primary keys (generated via `crypto.randomUUID()`).
- Foreign key relationships must be documented in comments.
- Include indexes on: `user_id`, `phone`, `status`, `created_at` columns.
- ISO 8601 dates, integer cents for money.
- Encrypted fields must be TEXT (storing hex-encoded ciphertext).
- Boolean fields use INTEGER (0 or 1) — D1/SQLite convention.
- JSON fields stored as TEXT (e.g., `tier_thresholds_json`, `conditions_json`).
- Never modify an existing migration — create a new one.
- Test migrations against local D1 before committing.

## Example: Initial Migration
See `docs/ARCHITECTURE.md` for the complete schema for all 9 tables. The `0001_initial.sql` migration creates:
1. users
2. retailers
3. bills
4. plans
5. plan_comparisons
6. switches
7. messages
8. oauth_tokens
9. notifications
