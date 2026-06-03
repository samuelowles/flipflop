# Bugs

## Fixed (2026-05-15)

### SECURITY: Phone stored as plaintext in D1
- **File:** models/users.ts, models/encryption.ts, migrations/0005_phone_encryption.sql
- **Fix:** Added `phone_encrypted` (AES-256-GCM) and `phone_hash` (SHA-256 blind index, no salt) columns. `getUserByPhone()` uses blind index for lookup, falls back to legacy `WHERE phone = ?1 AND phone_hash IS NULL`. `createUser()` encrypts phone and stores hash. `rowToUser()` decrypts on read.

### SECURITY: Messages stored in plaintext
- **File:** models/messages.ts, migrations/0005_phone_encryption.sql
- **Fix:** Added `body_encrypted` column. `createMessage()` encrypts body before insert. `rowToMessage()` reads from `body_encrypted` first, falls back to legacy `body`. Dual-write pattern for migration.

### SECURITY: OAuth token encryption not enforced by model layer
- **File:** models/oauth.ts, services/emailPoller.ts, routes/gmail.ts
- **Fix:** `storeOAuthTokens()` now accepts plaintext `accessToken`/`refreshToken` and encrypts internally via `encrypt()` from encryption.ts. Callers pass plaintext tokens + `EncryptionEnv`.

### STYLE: DeepSeek Flash/Pro use same model ID
- **File:** services/deepseek.ts
- **Fix:** `PRO_MODEL` changed from `'deepseek-chat'` to `'deepseek-reasoner'`.

### COMPLIANCE: Emojis in SMS-eligible messages
- **File:** services/conversation.ts
- **Fix:** Removed 📄 (4 occurrences) and 👋 (1 occurrence) from `RESPONSE_MESSAGES`.

### INFO: AWAITING_BILL state unreachable
- **File:** services/conversation.ts
- **Fix:** Added `case 'AWAITING_BILL':` to the transition response switch (was falling through to generic default message). TRANSITIONS already routed `ONBOARDING + help/usage/compare/status → AWAITING_BILL`.

### TEST: System prompt rebuilt on every LLM call
- **File:** services/deepseek.ts
- **Fix:** Hoisted `buildSystemPrompt()` result to module-level `const SYSTEM_PROMPT`. Deleted the function.

### TRAILING SLASH: /auth/gmail/ returned 404
- **File:** index.ts
- **Fix:** Added `app.get('/auth/gmail/', gmailConnectPage)` alongside the existing `/auth/gmail` route. Hono strict mode treats them as distinct paths.

## Fixed (2026-05-14)

### CRITICAL: Media never downloaded to R2
- **File:** routes/messaging.ts
- **Fix:** Added `downloadMedia()` call + `billsBucket.put()` between bill insert and queue send. The media buffer is now downloaded from Sent CDN and stored in R2 before the parse job is enqueued.

### MEDIUM: D1 state column never updated
- **File:** routes/messaging.ts
- **Fix:** `transition()` now updates both KV and D1 `users.state` after every state change. The `updateUserState()` function is imported and called.

### INFO: Duplicate validateSentSignature
- **Files:** middleware/sentAuth.ts, services/messaging.ts
- **Fix:** Removed the copy from services/messaging.ts. Imported from sentAuth.ts instead.

### D1Result<T> type double-wrapping (10 instances across 7 files)
- **Files:** models/retailers.ts, emailPoller.ts, bills.ts, comparisons.ts, notifications.ts, messages.ts, plans.ts
- **Fix:** Changed all `all<{ results: Record<string, unknown>[] }>()` to `all<Record<string, unknown>>()`. D1Result.results is already `T[]`, so the extra `{ results: ... }` wrapper created nested `results.results`.

### TS2532 errors in emailPoller.test.ts (19 instances)
- **File:** services/emailPoller.test.ts
- **Fix:** Added `!` non-null assertions on array index access (`results[0]!.userId`, `mock.calls[0]![0]`).

### messaging.test.ts mock missing cdn.sent.dm
- **File:** routes/messaging.test.ts
- **Fix:** Added `cdn.sent.dm` URL match to mock returning `{ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }`.

### CRITICAL: doPostConnectFlow not executing in production
- **File:** routes/gmail.ts
- **Root cause:** `c.executionCtx.waitUntil()` silently failed; the catch fallback used un-awaited fire-and-forget which Workers cancelled when the response was returned.
- **Fix:** Access `c.executionCtx` in try/catch (Miniflare throws on access); if `waitUntil` available use it, otherwise `await` the flow directly before responding.

### MEDIUM: sendMessage failure blocked bill scanning
- **File:** routes/gmail.ts
- **Root cause:** `doPostConnectFlow` had a single try/catch — a `sendMessage` 404 jumped over `pollSingleUser`, so bills were never discovered.
- **Fix:** Each step (confirmation, scan, result message) has independent try/catch. Scan always runs regardless of message success.

### MEDIUM: Meridian Energy domain incorrect
- **File:** Remote D1 retailers table
- **Root cause:** Domain seeded as `meridianenergy.co.nz` but Meridian billing emails come from `meridian.co.nz`.
- **Fix:** Updated domain in remote D1; broadened domain matching to use keywords (see below).

### MEDIUM: Gmail search too narrow (exact domain match)
- **Files:** services/emailPoller.ts (buildSearchQuery, matchRetailerByDomain)
- **Root cause:** `from:meridian.co.nz` only matched exact domain. Subdomains like `email.meridian.co.nz` were missed.
- **Fix:** `buildSearchQuery` now adds keyword-based `from:` terms (e.g. `from:meridian` matches any sender containing "meridian"). `matchRetailerByDomain` does 3-level matching: exact domain, subdomain suffix, and keyword-in-any-segment. Applied to all 10 retailers.
- **Superseded 2026-05-14:** Replaced entirely by name-based matching (see below).

### CRITICAL: Bare-word from: keywords cause false Gmail positives
- **File:** services/emailPoller.ts (buildSearchQuery via nameToSearchKeywords)
- **Root cause:** `from:Contact` (first-word fallback from "Contact Energy") matched `contact@nznativeplantcentre.co.nz` and `contact@patagonia.com.au` — "contact" appears in many email addresses.
- **Fix:** Removed all bare-word fallbacks from `nameToSearchKeywords()`. Only full retailer names are used (`from:"Contact Energy"`) — specific enough to avoid false positives. Subject filter would have caught them anyway, but the narrower Gmail query reduces noise.

### CRITICAL: 30-day lookback misses historical bills
- **File:** services/emailPoller.ts
- **Root cause:** Both `pollSingleUser()` and first-time `pollAllUsers()` hardcoded a 30-day search window. Users connecting Gmail for the first time only saw ~1 bill instead of the full history.
- **Fix:** `INITIAL_LOOKBACK_DAYS = 365` — both poll entry points now search 12 months back.

### MEDIUM: No pagination on Gmail search results
- **File:** services/emailPoller.ts, services/gmailAuth.ts
- **Root cause:** `searchMessages()` defaulted to 50 results per page with no `pageToken` loop. Users with many bills could hit the cap.
- **Fix:** Added `searchAllMessages()` pagination helper; bumped `DEFAULT_MAX_RESULTS` 50→500.

### MEDIUM: Meridian Energy domain wrong in seed migration
- **File:** migrations/0002_seed_retailers.sql
- **Root cause:** Migration has `meridianenergy.co.nz` but Meridian billing emails come from `meridian.co.nz`. Remote D1 was hot-fixed but the migration file wasn't updated.
- **Fix:** Domain-based matching replaced with name-based, making this moot. Migration file not changed — names are the source of truth now.

### MEDIUM: No visibility into scan progress
- **File:** routes/gmail.ts
- **Root cause:** Callback returned plain text "Gmail connected!" while scan ran in waitUntil. No way to see progress without tailing logs.
- **Fix:** Callback now returns an HTML page that polls `/auth/gmail/scan-status` every 1.5s. Shows live progress: phase, search query, messages found, bills discovered, sender breakdown, errors.

## Open

### CRITICAL: Sent API returns 404 on all messages
- **File:** services/messaging.ts
- **Problem:** All `POST https://api.sent.dm/v1/messages` calls return 404. Sent.dm onboarding not yet complete — API key may not be provisioned.
- **Impact:** Users receive no confirmation or scan-result messages after Gmail connect. Bill discovery works (scan runs independently).
