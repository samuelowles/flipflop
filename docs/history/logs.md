# Dev Log

## 2026-05-14 — Gmail OAuth Integration Complete

### Gmail Integration (8 new files, 2 modified)

**New files:**
- `workers/src/types/gmail.ts` — TypeScript interfaces (GmailOAuthState, GoogleTokenResponse, etc.)
- `workers/src/services/gmailAuth.ts` — 7 exported functions: buildAuthUrl, parseOAuthState, exchangeCodeForTokens, refreshAccessToken, revokeAccess, searchMessages, getMessage, downloadAttachment
- `workers/src/services/gmailAuth.test.ts` — 25 unit tests (OAuth URL, state parsing, token exchange, refresh, revoke, search, message fetch, attachment download)
- `workers/src/services/emailPoller.ts` — pollAllUsers(env): decrypt tokens, refresh if expired, search Gmail by retailer domain, filter by subject pattern, download PDFs, store to R2, create bill, enqueue parse
- `workers/src/services/emailPoller.test.ts` — 11 tests (empty users, token decryption, expiry refresh, PDF processing, subject filter, search query building, KV cursor, multi-user, errors, poll summary)
- `workers/src/routes/gmail.ts` — 3 Hono handlers: gmailConnectPage (HTML), gmailLogin (OAuth redirect + nonce), gmailCallback (state validation + token exchange + encrypted storage)
- `workers/src/routes/gmail.test.ts` — 10 integration tests (HTML page, config, redirect, nonce, callback validation, successful exchange, nonce cleanup, Google failure)
- `workers/migrations/0002_seed_retailers.sql` — 10 NZ power retailers (Contact, Mercury, Genesis, Meridian, Trustpower, Nova, Electric Kiwi, Powershop, Flick, Pulse)

**Modified files:**
- `workers/src/index.ts` — Registered 3 Gmail auth routes; wired scheduled() to pollAllUsers()
- `workers/src/models/retailers.ts` — Added getAllRetailerDomains() function
- `workers/wrangler.toml` — Cron triggers at 03:00, 06:00, 14:00 UTC

### Bug Fixes
- CRITICAL: Media download to R2 (bill ingestion was broken)
- MEDIUM: D1 state column sync after user state transitions
- INFO: Duplicate validateSentSignature removed
- D1Result type double-wrapping (10 instances in 7 files)
- 19 TS2532 strict null check errors in tests

### Google Cloud Setup
- Project: flip-nz-power
- OAuth 2.0 Web Application client created
- Redirect URIs: https://flip-api.two-hoots-design.workers.dev/auth/gmail/callback, http://localhost:8787/auth/gmail/callback
- Secrets set: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET

### Verification
- TypeScript: 0 errors (strict mode)
- Tests: 196 passing across 10 test files
- Deploy: https://flip-api.two-hoots-design.workers.dev
- Health: `{"status":"ok","service":"flip-api","version":"0.1.0"}`
- Gmail OAuth flow: end-to-end working (Connect → Google consent → callback → encrypted D1 storage)
- D1: 9 tables migrated, 10 retailers seeded, test user created

### Phone Collection + Immediate Scan + Notifications (same day)

**New/changed files:**
- `workers/src/types/gmail.ts` — Added `phone` field to `GmailOAuthState`
- `workers/src/services/gmailAuth.ts` — Updated `parseOAuthState` to validate phone
- `workers/src/models/users.ts` — Added `findOrCreateByPhone()` for connect flow
- `workers/src/services/emailPoller.ts` — Added `pollSingleUser()` for on-demand per-user scan; exported `GmailPollingEnv`; added `getGmailTokenForUser()` single-user token lookup; broadened `matchRetailerByDomain` to 3-level matching (exact → subdomain → keyword-in-segment); broadened `buildSearchQuery` to use domain keywords (e.g. `from:meridian` catches `@meridian.co.nz`, `@email.meridian.co.nz`, etc.)
- `workers/src/routes/gmail.ts` — Major rewrite: phone form on connect page, POST login with phone validation, post-connect async flow (confirmation message → immediate Gmail scan → result message). Messages decoupled from scan — each runs independently so Sent failures don't block bill discovery.
- `workers/src/routes/gmail.test.ts` — Updated for new flow (POST login, KV JSON nonce, post-connect trigger)
- `workers/src/services/gmailAuth.test.ts` — Added phone to all state fixtures
- `workers/src/index.ts` — Changed `/auth/gmail/login` from GET to POST
- `workers/migrations/` — Meridian Energy domain corrected from `meridianenergy.co.nz` to `meridian.co.nz` in remote D1

**Verified in production:**
- User signup via phone → OAuth → token exchange → immediate scan → bill found in Gmail
- Meridian Energy retailer correctly matched (keyword-based domain matching)
- Bill PDF stored in R2, D1 bill record created, parse job enqueued
- Gmail search latency: ~500-750ms per scan
- All 202 tests passing across 10 test files

**Known issue:**
- Sent API returns 404 on all message attempts — Sent.dm onboarding not yet complete. Once provisioned, confirmation and result messages will flow.

## 2026-05-14 — Gmail Search Rewrite: Name-Based + 12-Month Lookback + Progress Page

### Problem
Post-connect scan found only 1 bill out of ~60 from the past 3 years. Root causes:
1. 30-day lookback — missed 95%+ of historical bills
2. No pagination — searchMessages capped at 50 results
3. Domain-based matching was fragile — subdomains, third-party senders, domain changes

### Changes (6 files)

**`workers/src/models/retailers.ts`:**
- Replaced `getAllRetailerDomains()` with `getAllRetailerNames()` — returns `{id, name}[]` instead of domain strings
- Added `nameToSearchKeywords()` — generates Gmail `from:` keywords from retailer names
- Multi-word names get quoted: `from:"Contact Energy"` (exact display-name phrase match)
- Single-word names used as-is: `from:Mercury`

**`workers/src/services/emailPoller.ts`:**
- `buildSearchQuery()` uses retailer names, not domains — catches bills from any domain or third-party sender
- `matchRetailerByDomain()` → `matchRetailerByName()` — simple `fromHeader.includes(name)` check
- `INITIAL_LOOKBACK_DAYS = 365` — both pollSingleUser() and pollAllUsers() first-time
- `searchAllMessages()` — pagination loop via pageToken until exhausted
- `processMessage()` — shared helper for message processing
- Progress tracking: `pollSingleUser()` writes structured progress to KV every 5 messages
- `readScanProgress()` exported for the scan-status endpoint

**`workers/src/services/gmailAuth.ts`:**
- `DEFAULT_MAX_RESULTS`: 50 → 500 (Gmail API max)

**`workers/src/routes/gmail.ts`:**
- New `gmailScanStatus()` handler — reads KV progress, returns JSON
- `gmailCallback()` now returns an HTML progress page instead of plain text
- Page polls `/auth/gmail/scan-status?userId=xxx` every 1.5s
- Shows: phase, search query, messages found/scanned, bills discovered, bill senders, filtered senders, errors
- `renderProgressPage()` — generates the HTML with embedded JS

**`workers/src/types/gmail.ts`:**
- Added `ScanProgress` type: phase, searchQuery, messagesFound, messagesScanned, billsFound, billSenders, filteredSenders, errors, complete, timestamps

**`workers/src/index.ts`:**
- Registered `GET /auth/gmail/scan-status` route

### False Positive Fix
After first deploy, `from:Contact` (bare-word fallback from "Contact Energy") matched `contact@nznativeplantcentre.co.nz` and `contact@patagonia.com.au`. Subject filter correctly excluded them (0 false bills), but the fix was to remove all bare-word fallbacks from `nameToSearchKeywords()`. Only full retailer names are used now — specific enough to avoid false positives.

### Verification
- TypeScript: 0 errors (strict mode)
- Tests: 220 passing across 10 test files
- Deployed: https://flip-api.two-hoots-design.workers.dev (version: f7bed17c)
- Production test: 14 messages found, 12 bills discovered, 2 correctly filtered (no bill subject)
- Bill senders: Meridian Energy (hello@hub.meridian.co.nz, donotreply@service.meridian.co.nz) + Contact Energy

## 2026-05-15 — Security Hardening + Python Service Deploy

### Security: D1 Encryption at Rest (3 areas)

**Phone encryption with blind index** (`workers/migrations/0005_phone_encryption.sql`, `workers/src/models/users.ts`, `workers/src/models/encryption.ts`):
- Added `phone_encrypted` (AES-256-GCM) and `phone_hash` (SHA-256, no salt) columns to users table
- `createUser()` now encrypts phone and stores hash for deterministic lookup
- `getUserByPhone()` computes hash, queries `WHERE phone_hash = ?1`, decrypts on read — falls back to legacy `WHERE phone = ?1 AND phone_hash IS NULL`
- `rowToUser()` decrypts phone_encrypted on read
- `generatePhoneHash()` in encryption.ts: SHA-256 hex-encoded, deterministic (no salt) for blind-index lookup

**Message body encryption** (`workers/src/models/messages.ts`):
- Added `body_encrypted` column to messages table
- `createMessage()` encrypts body via AES-256-GCM before insert
- `rowToMessage()` reads from `body_encrypted` first, falls back to legacy `body` for migration

**OAuth token encryption enforcement** (`workers/src/models/oauth.ts`, `workers/src/services/emailPoller.ts`, `workers/src/routes/gmail.ts`):
- `storeOAuthTokens()` now accepts plaintext `accessToken`/`refreshToken` and encrypts internally via `encrypt()` + `EncryptionEnv`
- Callers pass plaintext tokens — encryption is the model's responsibility, not the caller's

### Bug Fixes (5 items)

- **DeepSeek model IDs** (`workers/src/services/deepseek.ts`): `PRO_MODEL` changed from `'deepseek-chat'` to `'deepseek-reasoner'` — Flash and Pro were using the same model
- **System prompt cached** (`workers/src/services/deepseek.ts`): Hoisted `buildSystemPrompt()` result to module-level `const SYSTEM_PROMPT`, deleted the function — was rebuilding on every LLM call
- **Emoji removal** (`workers/src/services/conversation.ts`): Removed 📄 (4 occurrences) and 👋 (1 occurrence) from `RESPONSE_MESSAGES` — SMS doesn't support emojis across carriers
- **AWAITING_BILL state reachable** (`workers/src/services/conversation.ts`): Added `case 'AWAITING_BILL':` to the transition response switch — TRANSITIONS already routed there but the response handler fell through to generic default
- **Trailing slash 404** (`workers/src/index.ts`): Added `app.get('/auth/gmail/', gmailConnectPage)` — Hono strict mode treats `/auth/gmail` and `/auth/gmail/` as distinct paths

### Python Service: Google Cloud Run Deployment

**Why not Cloudflare Workers:** Python parsers depend on pdfplumber + Pillow, which require native C libraries (libjpeg, zlib). V8 isolates can't run native code. Options were Fly.io, Google Cloud Run, or AWS App Runner.

**Deployment artifacts** (`python/Dockerfile`, already existed from prior session):
- Python 3.12-slim base, gunicorn + Flask, port 8080
- Health check at `/health`, Bearer token auth on `/parse` and `/compare`

**GCP project:** `flip-nz-power` (existing project)
- Region: `australia-southeast1` (Sydney)
- Service URL: `https://flip-python-360483648756.australia-southeast1.run.app`
- Auth token set via `SERVICE_AUTH_TOKEN` env var on Cloud Run

**IAM setup required for `gcloud run deploy --source`:**
- `roles/cloudbuild.builds.builder` on compute SA for Cloud Build
- `roles/storage.objectViewer` on compute SA for reading build context from GCS

### D1 Migration

Migration `0005_phone_encryption.sql` applied to remote D1 (`flip-db`):
- `ALTER TABLE users ADD COLUMN phone_encrypted TEXT`
- `ALTER TABLE users ADD COLUMN phone_hash TEXT`
- `ALTER TABLE messages ADD COLUMN body_encrypted TEXT`
- Individual `--command` execution (file import returned auth error 10000 despite valid permissions)

### Cloudflare Secrets Set

- `PYTHON_SERVICE_URL` → `https://flip-python-360483648756.australia-southeast1.run.app`
- `PYTHON_SERVICE_AUTH_TOKEN` → Bearer token for service-to-service auth
- `ENCRYPTION_KEY` → 256-bit AES key (base64-encoded, already set from prior session)

### Verification

- TypeScript: 0 errors (strict mode)
- Tests: 237 passing across 13 test files (Vitest)
- Python tests: 205 passing (pytest)
- Worker deployed: `https://flip-api.two-hoots-design.workers.dev`
- Python service deployed: `https://flip-python-360483648756.australia-southeast1.run.app`
- Health endpoints: both returning OK

### Remaining Open Issue

- **Sent API 404** — external dependency. Sent.dm onboarding not yet complete. Confirmation and scan-result messages will flow once API key is provisioned. Bill discovery works independently (scan runs regardless of message delivery).
