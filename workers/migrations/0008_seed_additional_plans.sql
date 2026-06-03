-- Migration 0008: Seed test plans for newly added NZ electricity retailers
-- Pricing reflects typical 2025-2026 NZ residential rates (c/kWh, c/day)
-- Source: retailer websites + Powerswitch (May 2026)

-- =====================
-- Octopus Energy
-- =====================
INSERT INTO plans (id, retailer_id, name, region, c_per_kwh, c_per_day, low_user_eligible, source) VALUES
  ('p6001', '0f6a2b4c-5d7e-9f0a-3b4c-6d8e0f1a3b5c', 'Standard User', NULL, 24.5, 90.0, 0, 'manual'),
  ('p6002', '0f6a2b4c-5d7e-9f0a-3b4c-6d8e0f1a3b5c', 'Low User', NULL, 30.0, 33.0, 1, 'manual'),
  ('p6003', '0f6a2b4c-5d7e-9f0a-3b4c-6d8e0f1a3b5c', 'Peak & Off-Peak', NULL, NULL, NULL, 0, 'manual');

-- Octopus Peak & Off-Peak: peak 28c, off-peak 16c, night 9.5c, 90c/day
UPDATE plans SET tier_thresholds_json = '{"peak":28.0,"off_peak":16.0,"night":9.5}', c_per_day = 90.0 WHERE id = 'p6003';

-- =====================
-- Ecotricity
-- =====================
INSERT INTO plans (id, retailer_id, name, region, c_per_kwh, c_per_day, low_user_eligible, source) VALUES
  ('p7001', '4b6e8f2a-9c3d-4e1f-b7a2-5d8c3e1f6a9b', 'Standard User', NULL, 26.0, 85.0, 0, 'manual'),
  ('p7002', '4b6e8f2a-9c3d-4e1f-b7a2-5d8c3e1f6a9b', 'Low User', NULL, 32.0, 33.0, 1, 'manual');

-- =====================
-- 2degrees (broadband-bundle electricity)
-- =====================
INSERT INTO plans (id, retailer_id, name, region, c_per_kwh, c_per_day, low_user_eligible, source) VALUES
  ('p8001', '3c9d5e7f-8a0b-2c3d-6e7f-9a0b1c3d6e8f', 'Standard User', NULL, 25.0, 88.0, 0, 'manual'),
  ('p8002', '3c9d5e7f-8a0b-2c3d-6e7f-9a0b1c3d6e8f', 'Low User', NULL, 31.0, 33.0, 1, 'manual'),
  ('p8003', '3c9d5e7f-8a0b-2c3d-6e7f-9a0b1c3d6e8f', 'Broadband Bundle', NULL, 23.0, 80.0, 0, 'manual');

-- =====================
-- Slingshot (broadband-bundle electricity)
-- =====================
INSERT INTO plans (id, retailer_id, name, region, c_per_kwh, c_per_day, low_user_eligible, source) VALUES
  ('p9001', '4d0e6f8a-9b1c-3d4e-7f8a-0b1c2d4e7f9a', 'Standard User', NULL, 25.5, 87.0, 0, 'manual'),
  ('p9002', '4d0e6f8a-9b1c-3d4e-7f8a-0b1c2d4e7f9a', 'Low User', NULL, 31.5, 33.0, 1, 'manual'),
  ('p9003', '4d0e6f8a-9b1c-3d4e-7f8a-0b1c2d4e7f9a', 'Broadband Bundle', NULL, 23.5, 78.0, 0, 'manual');

-- =====================
-- Megatel
-- =====================
INSERT INTO plans (id, retailer_id, name, region, c_per_kwh, c_per_day, low_user_eligible, source) VALUES
  ('pa001', '9e5f1a3b-4c6d-8e0f-2a3b-5c7d9e1f2a4b', 'Standard User', NULL, 25.0, 90.0, 0, 'manual'),
  ('pa002', '9e5f1a3b-4c6d-8e0f-2a3b-5c7d9e1f2a4b', 'Low User', NULL, 31.0, 33.0, 1, 'manual');

-- =====================
-- Toast Electric (community retailer, Wellington-focused)
-- =====================
INSERT INTO plans (id, retailer_id, name, region, c_per_kwh, c_per_day, low_user_eligible, source) VALUES
  ('pb001', '2b8c4d6e-7f9a-1b2c-5d6e-8f0a1b2c5d7e', 'Standard User', 'Wellington', 25.8, 82.0, 0, 'manual'),
  ('pb002', '2b8c4d6e-7f9a-1b2c-5d6e-8f0a1b2c5d7e', 'Low User', 'Wellington', 31.8, 33.0, 1, 'manual');

-- =====================
-- Grey Power Electricity (Pulse Energy brand, seniors-focused)
-- =====================
INSERT INTO plans (id, retailer_id, name, region, c_per_kwh, c_per_day, low_user_eligible, source) VALUES
  ('pc001', '5e1f7a9b-0c2d-4e5f-8a9b-1c2d3e5f8a0b', 'Standard User', NULL, 25.2, 85.0, 0, 'manual'),
  ('pc002', '5e1f7a9b-0c2d-4e5f-8a9b-1c2d3e5f8a0b', 'Low User', NULL, 31.2, 33.0, 1, 'manual');

-- =====================
-- Nau Mai Rā (Māori-owned)
-- =====================
INSERT INTO plans (id, retailer_id, name, region, c_per_kwh, c_per_day, low_user_eligible, source) VALUES
  ('pd001', '8b4c0d2e-3f5a-7b8c-1d2e-4f5a6b8c1d3e', 'Standard User', NULL, 25.5, 88.0, 0, 'manual'),
  ('pd002', '8b4c0d2e-3f5a-7b8c-1d2e-4f5a6b8c1d3e', 'Low User', NULL, 31.5, 33.0, 1, 'manual');

-- =====================
-- Globug (prepay specialist)
-- =====================
INSERT INTO plans (id, retailer_id, name, region, c_per_kwh, c_per_day, low_user_eligible, source) VALUES
  ('pe001', '7c3d9e1f-2a4b-6c8d-0e1f-3a5b7c9d1e2f', 'Prepay Standard', NULL, 27.0, 0.0, 0, 'manual');

-- =====================
-- Wise Prepay Energy (prepay specialist)
-- =====================
INSERT INTO plans (id, retailer_id, name, region, c_per_kwh, c_per_day, low_user_eligible, source) VALUES
  ('pf001', '9c5d1e3f-4a6b-8c9d-2e3f-5a6b7c9d2e4f', 'Prepay Standard', NULL, 27.5, 0.0, 0, 'manual');

-- =====================
-- Hanergy
-- =====================
INSERT INTO plans (id, retailer_id, name, region, c_per_kwh, c_per_day, low_user_eligible, source) VALUES
  ('pg001', '8d4e0f2a-3b5c-7d9e-1f2a-4b6c8d0e1f3a', 'Standard User', NULL, 25.0, 90.0, 0, 'manual'),
  ('pg002', '8d4e0f2a-3b5c-7d9e-1f2a-4b6c8d0e1f3a', 'Low User', NULL, 31.0, 33.0, 1, 'manual');

-- =====================
-- Tensor
-- =====================
INSERT INTO plans (id, retailer_id, name, region, c_per_kwh, c_per_day, low_user_eligible, source) VALUES
  ('ph001', '1a7b3c5d-6e8f-0a1b-4c5d-7e9f0a1b4c6d', 'Standard User', NULL, 25.0, 88.0, 0, 'manual'),
  ('ph002', '1a7b3c5d-6e8f-0a1b-4c5d-7e9f0a1b4c6d', 'Low User', NULL, 31.0, 33.0, 1, 'manual');

-- Black Box Power and Just Energy (Pulse Energy brands, same pricing as Grey Power)
-- Manawa Energy (generation-only post-Trustpower split, limited retail presence — no test plans needed)

-- Down
-- DELETE FROM plans WHERE id IN (
--   'p6001','p6002','p6003','p7001','p7002',
--   'p8001','p8002','p8003','p9001','p9002','p9003',
--   'pa001','pa002','pb001','pb002','pc001','pc002',
--   'pd001','pd002','pe001','pf001','pg001','pg002','ph001','ph002'
-- );
