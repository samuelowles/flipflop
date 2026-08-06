-- Migration 0021: raise the notification threshold to $200/year.
--
-- The threshold is compared against an ANNUAL saving (the comparator projects
-- over 365 days), so the seeded 5000 meant "$50 per year" — about $4/month.
-- PRD 5.3 always intended "$50 over the next 3 months"; the implementation
-- switched to an annual projection and the number never followed, leaving the
-- bar 4x lower than specified. Confirmed as a product decision: $200/year.
--
-- This matters because the alert is the product. A threshold near the
-- comparison's own error margin (modelled TOU splits, assumed prompt-payment
-- discounts) produces alerts that cannot be justified when a customer checks
-- them, and trains people to ignore the ones that matter.
--
-- Only rows still holding the old seeded default are moved. A user who has
-- deliberately chosen their own threshold keeps it — this is a default
-- correction, not a reset of anyone's preference.
--
-- The column DEFAULT in 0001_initial stays 5000: changing it means rebuilding
-- the table, which trips strict FK enforcement on a populated D1
-- (docs/TESTING_RUN.md §2a). createUser now binds the value explicitly
-- instead, so DEFAULT_NOTIFICATION_THRESHOLD_CENTS is the single source of
-- truth and the stale column default is never reached.

UPDATE users
   SET notification_threshold_cents = 20000,
       updated_at = datetime('now')
 WHERE notification_threshold_cents = 5000;
