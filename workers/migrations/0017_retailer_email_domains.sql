-- 0017_retailer_email_domains.sql
-- Issue #227 (E13.5): Gmail bill-discovery domain-based search.
--
-- Adds `retailers.email_domains` — a JSON array of sender domains each retailer
-- uses to deliver billing email. `emailPoller.buildSearchQuery` unions these
-- domains with the existing name-keyword from: clauses so nothing that matched
-- before stops matching (issue #227 fix 3).
--
-- The existing `retailers.domain` column (0001) is the retailer's *website*
-- domain (e.g. contact.co.nz) and frequently differs from the *billing sender*
-- domain (e.g. contactenergy.co.nz). A dedicated JSON array is needed because:
--   (a) some retailers bill from a subdomain or separate domain entirely
--       (Genesis → billing.genesisenergy.co.nz; Meridian → meridian.co.nz +
--       meridianenergy.co.nz), and
--   (b) the Gmail from: search is domain-scoped (`from:contactenergy.co.nz`),
--       so we must store every domain we want to match.
--
-- Sources per retailer (verified 2026-07-15; see docs/RETAILER_EMAIL_COVERAGE.md):
--   Contact Energy   — contactenergy.co.nz (help@contactenergy.co.nz, public support)
--   Mercury          — mercury.co.nz (customerservice@mercury.co.nz)
--   Genesis Energy   — genesisenergy.co.nz (noreply@billing.genesisenergy.co.nz;
--                       Genesis help FAQ explicitly names the billing subdomain;
--                       stored as the bare domain so subdomains match too)
--   Meridian Energy  — meridianenergy.co.nz, meridian.co.nz (bills now come from
--                       hub.meridian.co.nz; both root domains used historically)
--   Trustpower       — trustpower.co.nz (brand now absorbed by Mercury but the
--                       domain is still the canonical billing sender for legacy
--                       accounts still in migration)
--   Nova Energy      — novaenergy.co.nz (info@novaenergy.co.nz)
--   Electric Kiwi    — electrickiwi.co.nz (link-only billing; no PDF — see #114)
--   Powershop        — powershop.co.nz (also team.powershop.co.nz; link-only)
--   Flick Electric   — flickelectric.co.nz (brand absorbed by Meridian; domain
--                       still used for legacy accounts)
--   Pulse Energy     — pulseenergy.co.nz (customer.care@pulseenergy.co.nz)
--
-- JSON arrays are stored as TEXT; D1/SQLite has no native JSON type but the
-- application layer (models/retailers.ts) parses with JSON.parse.

ALTER TABLE retailers ADD COLUMN email_domains TEXT;

-- Seed all 10 active retailers. UUIDs match 0002_seed_retailers.sql.
UPDATE retailers SET email_domains = '["contactenergy.co.nz"]'                  WHERE id = 'ffcfa737-7546-4d1f-9f5e-8bfa1e6fc31a'; -- Contact Energy
UPDATE retailers SET email_domains = '["mercury.co.nz"]'                        WHERE id = '2951d6b6-436e-474b-8ea9-7fb5092cc069'; -- Mercury
UPDATE retailers SET email_domains = '["genesisenergy.co.nz"]'                   WHERE id = 'a20f39b2-7f2c-48ef-8b17-12886402e2fd'; -- Genesis Energy
UPDATE retailers SET email_domains = '["meridianenergy.co.nz","meridian.co.nz"]' WHERE id = '5efa7fa6-0ec7-4f81-b3cf-229951b3896b'; -- Meridian Energy
UPDATE retailers SET email_domains = '["trustpower.co.nz"]'                      WHERE id = '92a506ac-2ca0-4ff3-a46e-3a27d850ce6a'; -- Trustpower
UPDATE retailers SET email_domains = '["novaenergy.co.nz"]'                      WHERE id = '02b3f36d-27b2-475b-bc08-2863e2cc96c9'; -- Nova Energy
UPDATE retailers SET email_domains = '["electrickiwi.co.nz"]'                    WHERE id = '9b60928a-0d44-4b49-8d76-bb0e6295c63d'; -- Electric Kiwi
UPDATE retailers SET email_domains = '["powershop.co.nz","team.powershop.co.nz"]' WHERE id = '989a6f4d-bf36-4c0b-b920-43679aecf9a0'; -- Powershop
UPDATE retailers SET email_domains = '["flickelectric.co.nz"]'                   WHERE id = '41f1cccd-ee33-4f96-b9be-925d5ee399e9'; -- Flick Electric
UPDATE retailers SET email_domains = '["pulseenergy.co.nz"]'                     WHERE id = 'a14a71cc-a945-4fc2-a72f-80779a746429'; -- Pulse Energy

-- ===========================================================================
-- Down
-- ===========================================================================
-- SQLite cannot easily drop a column without a temp-table rebuild, so the
-- ALTER is intentionally one-way within this migration's lifetime (0006/0011
-- precedent). The UPDATEs are idempotent and safe to re-apply.

-- ===========================================================================
-- Adversarial self-verification
-- ===========================================================================
-- * ALTER TABLE ADD COLUMN is nullable — pre-existing rows and any future
--   retailer without seeded domains are unaffected (NULL → no domain match,
--   falls back to name-keyword matching, preserving prior behaviour).
-- * All 10 UPDATEs key off the immutable primary-key UUIDs from 0002, so
--   re-running is a no-op (idempotent UPDATE by PK).
-- * Genesis stores the bare domain (genesisenergy.co.nz) rather than the
--   billing subdomain (billing.genesisenergy.co.nz) because the Gmail
--   from: operator matches on substring — `from:genesisenergy.co.nz` catches
--   mail from any subdomain of genesisenergy.co.nz.
-- * Meridian/Powershop store multiple domains because both retailers operate
--   across two legitimate sender domains; the array form handles this
--   without a separate join table.
