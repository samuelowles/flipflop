-- Migration 0020: take the fabricated seed plans out of the live comparison set.
--
-- Migrations 0004 ("seed_test_plans") and 0008 inserted 39 plans with invented
-- pricing — "typical NZ residential rates" typed by hand, not sourced from any
-- retailer. They were fixtures for building the comparator before real plan
-- data existed. They are still live, and two things make that dangerous now
-- that a real user can reach the pipeline:
--
--   1. planComparator falls back to these rows whenever the Powerswitch bridge
--      is unavailable, so a transient Powerswitch failure produces a confident
--      recommendation priced off fiction. The invented daily charges are the
--      worst of it: Contact "Standard User" is seeded at 90 c/day while the
--      real Mercury bill in `example bills/` charges 291 c/day — a $700/yr
--      phantom saving before a single kWh is counted.
--
--   2. getCanonicalPlans resolves ties by source precedence
--      manual > eiep14a > powerswitch, so for any plan name that collides
--      (Contact "Standard User", Mercury "Low User", …) the fabricated row
--      OUTRANKS real scraped data and replaces it in the canonical set.
--
-- Expire rather than DELETE: plan_comparisons.plan_id is a FK to plans(id), so
-- deleting rows a historical comparison points at would break referential
-- integrity (and lose the audit trail of what was recommended). Every read path
-- (getActivePlans, getPlansByRetailer, getPlansByRegion) already filters on
-- `effective_to IS NULL OR effective_to >= datetime('now')`, so expiry is the
-- mechanism the schema already provides. It is also trivially reversible.
--
-- Consequence, accepted deliberately: with no seeded plans the fallback path
-- yields no comparison when the Powerswitch bridge fails, and the user is not
-- notified. For a comparison product, silence is strictly better than a
-- confident number derived from invented pricing.
--
-- The e2e pipeline suite re-activates these rows for its own database — they
-- remain a legitimate test fixture, just not production data. See
-- workers/src/e2e/apply-migrations.ts.

UPDATE plans
   SET effective_to = '2000-01-01T00:00:00Z',
       is_current = 0
 WHERE source = 'manual'
   AND effective_to IS NULL;
