-- Seed realistic NZ power plans from major retailers
-- Pricing reflects typical 2025 NZ residential rates (c/kWh, c/day)

-- =====================
-- Contact Energy
-- =====================
INSERT INTO plans (id, retailer_id, name, region, c_per_kwh, c_per_day, low_user_eligible, source) VALUES
  ('p1001', 'ffcfa737-7546-4d1f-9f5e-8bfa1e6fc31a', 'Standard User', NULL, 25.2, 90.0, 0, 'manual'),
  ('p1002', 'ffcfa737-7546-4d1f-9f5e-8bfa1e6fc31a', 'Low User', NULL, 31.5, 33.0, 1, 'manual'),
  ('p1003', 'ffcfa737-7546-4d1f-9f5e-8bfa1e6fc31a', 'Good Nights', NULL, NULL, NULL, 0, 'manual');

-- Contact Good Nights: peak 30c, off-peak 18c, night 12c, 60c/day
UPDATE plans SET tier_thresholds_json = '{"peak":30.0,"off_peak":18.0,"night":12.0}', c_per_day = 60.0 WHERE id = 'p1003';

-- =====================
-- Mercury
-- =====================
INSERT INTO plans (id, retailer_id, name, region, c_per_kwh, c_per_day, low_user_eligible, source) VALUES
  ('p2001', '2951d6b6-436e-474b-8ea9-7fb5092cc069', 'Standard User', NULL, 24.8, 95.0, 0, 'manual'),
  ('p2002', '2951d6b6-436e-474b-8ea9-7fb5092cc069', 'Low User', NULL, 30.0, 35.0, 1, 'manual'),
  ('p2003', '2951d6b6-436e-474b-8ea9-7fb5092cc069', 'EV Plan', NULL, NULL, NULL, 0, 'manual');

-- Mercury EV Plan: peak 32c, off-peak 15c, night 10c, 100c/day
UPDATE plans SET tier_thresholds_json = '{"peak":32.0,"off_peak":15.0,"night":10.0}', c_per_day = 100.0 WHERE id = 'p2003';

-- =====================
-- Genesis Energy
-- =====================
INSERT INTO plans (id, retailer_id, name, region, c_per_kwh, c_per_day, low_user_eligible, source) VALUES
  ('p3001', 'a20f39b2-7f2c-48ef-8b17-12886402e2fd', 'Standard User', NULL, 26.0, 88.0, 0, 'manual'),
  ('p3002', 'a20f39b2-7f2c-48ef-8b17-12886402e2fd', 'Low User', NULL, 32.5, 33.0, 1, 'manual'),
  ('p3003', 'a20f39b2-7f2c-48ef-8b17-12886402e2fd', 'Peak Advantage', NULL, NULL, NULL, 0, 'manual');

-- Genesis Peak Advantage: peak 33c, off-peak 20c, night 11c, 85c/day
UPDATE plans SET tier_thresholds_json = '{"peak":33.0,"off_peak":20.0,"night":11.0}', c_per_day = 85.0 WHERE id = 'p3003';

-- =====================
-- Meridian Energy
-- =====================
INSERT INTO plans (id, retailer_id, name, region, c_per_kwh, c_per_day, low_user_eligible, source) VALUES
  ('p4001', '5efa7fa6-0ec7-4f81-b3cf-229951b3896b', 'Standard User', NULL, 25.5, 92.0, 0, 'manual'),
  ('p4002', '5efa7fa6-0ec7-4f81-b3cf-229951b3896b', 'Low User', NULL, 31.0, 33.0, 1, 'manual');

-- =====================
-- Electric Kiwi
-- =====================
INSERT INTO plans (id, retailer_id, name, region, c_per_kwh, c_per_day, low_user_eligible, source) VALUES
  ('p5001', '9b60928a-0d44-4b49-8d76-bb0e6295c63d', 'Standard User', NULL, 24.5, 85.0, 0, 'manual'),
  ('p5002', '9b60928a-0d44-4b49-8d76-bb0e6295c63d', 'Low User', NULL, 30.5, 33.0, 1, 'manual'),
  ('p5003', '9b60928a-0d44-4b49-8d76-bb0e6295c63d', 'MoveMaster', NULL, NULL, NULL, 0, 'manual');

-- Electric Kiwi MoveMaster (free hour of power equivalent): peak 28c, off-peak 0c (1hr), night 14c, 90c/day
UPDATE plans SET tier_thresholds_json = '{"peak":28.0,"free_hour":0.0,"night":14.0}', c_per_day = 90.0 WHERE id = 'p5003';

-- Down
-- DELETE FROM plans WHERE id IN ('p1001','p1002','p1003','p2001','p2002','p2003','p3001','p3002','p3003','p4001','p4002','p5001','p5002','p5003');
