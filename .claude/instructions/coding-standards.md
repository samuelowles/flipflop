# Flip — Coding Standards

## TypeScript (Cloudflare Workers)

### Strict Mode
- `"strict": true` in tsconfig.json — always.
- No `any` types. Use `unknown` and narrow with type guards at external API boundaries.
- If `any` is absolutely unavoidable, document why in a comment and get review approval.

### Functional Style
- Pure functions over classes. Immutable data over mutation.
- No classes unless there is a compelling reason (e.g., WebCrypto API wrappers).
- Prefer `const` over `let`. Never use `var`.
- Use `Readonly<>`, `readonly` arrays, and `as const` for compile-time immutability.

### Service Modules
- All external API calls go through service modules in `workers/src/services/`.
- Route handlers never call `fetch` directly.
- Each service module wraps a single external API (Sent, DeepSeek, Stripe, Gmail, Outlook).
- Service modules handle retry logic, error normalization, and logging.

### Database (D1)
- All queries use parameterized statements: `db.prepare("SELECT * FROM users WHERE id = ?").bind(userId)`
- Never string interpolation: `db.prepare(`SELECT * FROM users WHERE id = '${userId}'`)` ← BLOCKED
- Schema changes go through migration files in `workers/migrations/`. Never edit the schema manually.

### Data Types
- Dates: ISO 8601 strings only (`2026-05-14T09:30:00+12:00`). Include timezone offset.
- Money: integer cents (NZD). Never floats for monetary values.
  ```typescript
  // CORRECT
  const totalCents = 21234; // $212.34 NZD

  // WRONG
  const totalDollars = 212.34;
  ```
- Phone numbers: E.164 format (`+64` prefix for NZ).
- UUIDs for all primary keys (generated via `crypto.randomUUID()`).

### Error Handling
- Every route handler wraps its logic in try/catch with structured error responses.
- Error responses include: `{ error: string, code: string, status: number }`.
- Never expose internal error details or stack traces to the client.
- Use the global error handler middleware for unhandled rejections.

### Logging
- Structured JSON logging via `console.log`. Cloudflare captures this automatically.
- Log levels configurable via environment variable.
- Include: timestamp, event type, duration_ms, and sanitised context.
- Never log: phone numbers, emails, ICP numbers, access tokens, bill contents.

## Python (Bill Parsing + Plan Comparison)

### Style
- snake_case for files, functions, and variables.
- Type hints on all function signatures.
- Docstrings for public functions (one-line summary only).
- No AI/LLM used for data extraction or calculations — deterministic algorithms only.

### Bill Parsers
- Each NZ power retailer gets its own parser module in `python/parsers/`.
- All parsers extend `parsers/base.py` — use shared extraction logic.
- Parser output: standard JSON structure matching the bills D1 schema.
- Every parser returns a confidence score (0-1).
- Sanity-check all extracted values: kWh ranges, dollar ranges, date validity.
- Low-confidence extractions (<0.7) go to manual review queue — never auto-accepted.

### Plan Comparator
- Pure deterministic math: usage profile in, available plans in, ranked costs out.
- Handle: tiered pricing, daily charges, prompt payment discounts, low-user plans, controlled/off-peak rates.
- All calculations in cents (integer). Convert floats from plan data immediately.
- Output: ranked list with projected cost, current cost, saving amount, confidence score.
- Confidence factors: bill data freshness, plan data age, pricing completeness.

## File Naming

| Type | Convention | Example |
|------|-----------|---------|
| Worker source | camelCase | `switchService.ts` |
| Route files | lowercase matching path | `messaging.ts` |
| Service files | camelCase | `deepseek.ts` |
| Type files | camelCase | `bill.ts` |
| Test files (TS) | `*.test.ts` | `messaging.test.ts` |
| Python source | snake_case | `contact_parser.py` |
| Test files (Python) | `*_test.py` | `test_contact.py` |
| D1 migrations | `NNNN_descriptive_name.sql` | `0001_initial.sql` |

No barrel/index files. Import directly from the module.

## Project Directory Rules

```
workers/src/          # All TypeScript source
workers/migrations/   # All D1 migrations
python/parsers/       # All bill parsers
python/comparator/    # Plan comparison engine
python/eiep14a/       # EIEP14A data ingestion
python/tests/         # All Python tests
docs/                 # All documentation
legal/                # All legal documents
```

No loose source files in the project root. `package.json` only in `workers/`. `requirements.txt` only in `python/`.
