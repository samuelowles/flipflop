# NZ Privacy Act 2020 — Rate Limit Notes

This note records the privacy posture of `src/middleware/rateLimit.ts` so
future audits can verify continued compliance without re-deriving it.

## Data collected

| Field           | Source                            | Retention            | Purpose                                  |
| --------------- | --------------------------------- | -------------------- | ---------------------------------------- |
| `phone_hash`    | `sentAuth` middleware (SHA-256)   | DO storage, ~70s TTL | Per-user rate-limit keying               |
| Hashed IP       | `CF-Connecting-IP` header         | DO storage, ~70s TTL | Per-caller keying for non-webhook routes |
| Timestamp array | `Date.now()` on each request      | DO storage, ~70s TTL | Sliding-window counter                   |

## Lawful basis (IPP 1 / IPP 11)

Rate limiting is a necessary, narrowly-scoped operational safeguard that
prevents abuse of the public webhook endpoint. The data minimisation
principle (IPP 1) is satisfied by:

- Hashing the phone with SHA-256 immediately on receipt — the raw phone
  is *not* persisted to DO storage. (The raw `phone` context value is
  short-lived and never logged.)
- Hashing the client IP for non-webhook routes, never storing the raw IP.
- Capping retention to the active window (~70s — the longest configured
  `windowMs` of 60s plus a small jitter margin).

## IPP 6 / IPP 7 — access and correction

Users do not have a right to access timestamp arrays or hashed IPs —
these are operational telemetry, not personal information in the
identifiable sense under IPP 2 (no re-identification path without the
raw phone).

## IPP 9 — retention

Storage is bounded by `windowMs`. Once timestamps fall outside the
window they are filtered on the next read and overwritten on the next
write, providing automatic deletion within ~70 seconds.

## Audit trail

| Date       | Change                                                  | PR     |
| ---------- | ------------------------------------------------------- | ------ |
| 2026-06-23 | Rewrite with Durable Object; hash phone & IP; add doc.  | #151   |