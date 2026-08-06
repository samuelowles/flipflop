-- 0019_mercury_billing_domain.sql
-- Bill discovery: Mercury's real billing sender domain was missing.
--
-- Migration 0017 seeded Mercury's `retailers.email_domains` as
-- ["mercury.co.nz"]. Mercury actually delivers residential bills from
-- onlinebills@mercuryonline.co.nz. The string `mercuryonline.co.nz` does NOT
-- contain the substring `mercury.co.nz`, so:
--   (a) `emailPipeline.matchRetailer`'s domain check (a substring match on
--       `@<domain>` / bare domain) missed a directly-delivered Mercury bill, and
--   (b) Gmail's `from:mercury.co.nz` query did not match it either.
-- A directly-delivered Mercury bill was therefore invisible to the scan even
-- before forwarding. Adding `mercuryonline.co.nz` fixes both the `from:` search
-- term (the forwarded case is already covered by the `subject:Mercury` term
-- added in emailPipeline.buildSearchQuery) and the From-header retailer match
-- in `processMessage`, so the bill row gets the correct retailer_id and thus
-- the retailer-specific Python parser.
--
-- Source: observed on a real customer bill (From:
-- onlinebills@mercuryonline.co.nz), 2026-08-06.

UPDATE retailers
SET email_domains = '["mercury.co.nz","mercuryonline.co.nz"]'
WHERE id = '2951d6b6-436e-474b-8ea9-7fb5092cc069'; -- Mercury

-- ===========================================================================
-- Down
-- ===========================================================================
-- The UPDATE keys off the immutable primary-key UUID from 0002 and writes the
-- full literal array, so re-running is a no-op (idempotent). To roll back, set
-- the array back to '["mercury.co.nz"]' — no schema change is needed (the
-- email_domains column itself was added by 0017).

-- ===========================================================================
-- Adversarial self-verification
-- ===========================================================================
-- * Only Mercury's row is touched (WHERE id = <Mercury PK> from 0002). The
--   other nine retailers are deliberately untouched — none has been
--   contradicted by evidence, and a wrong domain in matchRetailer is a
--   false-positive risk (the domain check is a substring match).
-- * The full literal array is written rather than JSON surgery in SQL, so the
--   column always lands on exactly ["mercury.co.nz","mercuryonline.co.nz"]
--   regardless of prior state — safe to re-run.
-- * `mercuryonline.co.nz` is a substring of no other seeded domain and no other
--   seeded domain is a substring of it, so it cannot cause cross-retailer
--   matches. (It does not contain `mercury.co.nz` — that was the original bug —
--   and `mercury.co.nz` does not contain it.)
-- * Array order is immaterial: matchRetailer iterates the array and
--   buildSearchQuery emits a `from:` term for every domain, so both domains
--   contribute independently.
