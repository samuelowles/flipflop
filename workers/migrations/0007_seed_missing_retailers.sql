-- Migration 0007: Seed missing NZ electricity retailers into the retailers table
-- Adds 15 retailers not covered by 0002 (covering all 25 known NZ residential electricity retailers)
-- Source: Powerswitch + Electricity Authority registry (May 2026)

-- Up

-- Independent retailers
INSERT INTO retailers (id, name, domain, parser_id, is_active) VALUES ('4b6e8f2a-9c3d-4e1f-b7a2-5d8c3e1f6a9b', 'Ecotricity', 'ecotricity.co.nz', 'generic', 1);
INSERT INTO retailers (id, name, domain, parser_id, is_active) VALUES ('7c3d9e1f-2a4b-6c8d-0e1f-3a5b7c9d1e2f', 'Globug', 'globug.co.nz', 'generic', 1);
INSERT INTO retailers (id, name, domain, parser_id, is_active) VALUES ('8d4e0f2a-3b5c-7d9e-1f2a-4b6c8d0e1f3a', 'Hanergy', 'hanergy.co.nz', 'generic', 1);
INSERT INTO retailers (id, name, domain, parser_id, is_active) VALUES ('9e5f1a3b-4c6d-8e0f-2a3b-5c7d9e1f2a4b', 'Megatel', 'megatel.co.nz', 'generic', 1);
INSERT INTO retailers (id, name, domain, parser_id, is_active) VALUES ('0f6a2b4c-5d7e-9f0a-3b4c-6d8e0f1a3b5c', 'Octopus Energy', 'octopusenergy.co.nz', 'generic', 1);
INSERT INTO retailers (id, name, domain, parser_id, is_active) VALUES ('1a7b3c5d-6e8f-0a1b-4c5d-7e9f0a1b4c6d', 'Tensor', 'tensor.co.nz', 'generic', 1);
INSERT INTO retailers (id, name, domain, parser_id, is_active) VALUES ('2b8c4d6e-7f9a-1b2c-5d6e-8f0a1b2c5d7e', 'Toast Electric', 'toastelectric.co.nz', 'generic', 1);

-- Broadband-bundle retailers (2degrees, Slingshot)
INSERT INTO retailers (id, name, domain, parser_id, is_active) VALUES ('3c9d5e7f-8a0b-2c3d-6e7f-9a0b1c3d6e8f', '2degrees', '2degrees.nz', 'generic', 1);
INSERT INTO retailers (id, name, domain, parser_id, is_active) VALUES ('4d0e6f8a-9b1c-3d4e-7f8a-0b1c2d4e7f9a', 'Slingshot', 'slingshot.co.nz', 'generic', 1);

-- Pulse Energy portfolio brands
INSERT INTO retailers (id, name, domain, parser_id, is_active) VALUES ('5e1f7a9b-0c2d-4e5f-8a9b-1c2d3e5f8a0b', 'Grey Power Electricity', 'greypowerelectricity.co.nz', 'generic', 1);
INSERT INTO retailers (id, name, domain, parser_id, is_active) VALUES ('6f2a8b0c-1d3e-5f6a-9b0c-2d3e4f6a9b1c', 'Black Box Power', 'blackboxpower.co.nz', 'generic', 1);
INSERT INTO retailers (id, name, domain, parser_id, is_active) VALUES ('7a3b9c1d-2e4f-6a7b-0c1d-3e4f5a7b0c2d', 'Just Energy', 'justenergy.co.nz', 'generic', 1);

-- Māori-owned / community retailers
INSERT INTO retailers (id, name, domain, parser_id, is_active) VALUES ('8b4c0d2e-3f5a-7b8c-1d2e-4f5a6b8c1d3e', 'Nau Mai Rā', 'naumaira.co.nz', 'generic', 1);

-- Prepay / sub-meter retailers
INSERT INTO retailers (id, name, domain, parser_id, is_active) VALUES ('9c5d1e3f-4a6b-8c9d-2e3f-5a6b7c9d2e4f', 'Wise Prepay Energy', 'wiseprepay.co.nz', 'generic', 1);

-- Legacy / rebranded (formerly Trustpower's generation business)
INSERT INTO retailers (id, name, domain, parser_id, is_active) VALUES ('0d6e2f4a-5b7c-9d0e-3f4a-6b7c8d0e3f5a', 'Manawa Energy', 'manawaenergy.co.nz', 'generic', 1);

-- Down
-- DELETE FROM retailers WHERE id IN (
--   '4b6e8f2a-9c3d-4e1f-b7a2-5d8c3e1f6a9b', '7c3d9e1f-2a4b-6c8d-0e1f-3a5b7c9d1e2f',
--   '8d4e0f2a-3b5c-7d9e-1f2a-4b6c8d0e1f3a', '9e5f1a3b-4c6d-8e0f-2a3b-5c7d9e1f2a4b',
--   '0f6a2b4c-5d7e-9f0a-3b4c-6d8e0f1a3b5c', '1a7b3c5d-6e8f-0a1b-4c5d-7e9f0a1b4c6d',
--   '2b8c4d6e-7f9a-1b2c-5d6e-8f0a1b2c5d7e', '3c9d5e7f-8a0b-2c3d-6e7f-9a0b1c3d6e8f',
--   '4d0e6f8a-9b1c-3d4e-7f8a-0b1c2d4e7f9a', '5e1f7a9b-0c2d-4e5f-8a9b-1c2d3e5f8a0b',
--   '6f2a8b0c-1d3e-5f6a-9b0c-2d3e4f6a9b1c', '7a3b9c1d-2e4f-6a7b-0c1d-3e4f5a7b0c2d',
--   '8b4c0d2e-3f5a-7b8c-1d2e-4f5a6b8c1d3e', '9c5d1e3f-4a6b-8c9d-2e3f-5a6b7c9d2e4f',
--   '0d6e2f4a-5b7c-9d0e-3f4a-6b7c8d0e3f5a'
-- );
