import { describe, it, expect } from 'vitest';
import { detectRetailerBySender, nameToSearchKeywords } from './retailers';

describe('detectRetailerBySender (issue #40)', () => {
  // Each NZ retailer in migration 0002_seed_retailers.sql must resolve to its
  // primary-key retailer ID. Sender numbers are placeholders pending live Sent
  // inbound sender ID verification (see TODO in retailers.ts).
  it.each([
    ['+64 21 400 400', 'ffcfa737-7546-4d1f-9f5e-8bfa1e6fc31a', 'Contact Energy'],
    ['+64 21 500 500', '2951d6b6-436e-474b-8ea9-7fb5092cc069', 'Mercury'],
    ['+64 21 600 600', 'a20f39b2-7f2c-48ef-8b17-12886402e2fd', 'Genesis Energy'],
    ['+64 21 700 700', '5efa7fa6-0ec7-4f81-b3cf-229951b3896b', 'Meridian Energy'],
    ['+64 21 800 800', '92a506ac-2ca0-4ff3-a46e-3a27d850ce6a', 'Trustpower'],
    ['+64 21 900 900', '02b3f36d-27b2-475b-bc08-2863e2cc96c9', 'Nova Energy'],
    ['+64 21 100 100', '9b60928a-0d44-4b49-8d76-bb0e6295c63d', 'Electric Kiwi'],
    ['+64 21 200 200', '989a6f4d-bf36-4c0b-b920-43679aecf9a0', 'Powershop'],
    ['+64 21 300 300', '41f1cccd-ee33-4f96-b9be-925d5ee399e9', 'Flick Electric'],
    ['+64 21 450 450', 'a14a71cc-a945-4fc2-a72f-80779a746429', 'Pulse Energy'],
  ])('maps sender %s → %s (%s)', (sender, expectedId) => {
    expect(detectRetailerBySender(sender)).toBe(expectedId);
  });

  it('covers all 10 seeded NZ retailers', () => {
    // Sanity check: AC requires unit tests for all 10 retailers' sender numbers.
    const senders = [
      '+64 21 400 400',
      '+64 21 500 500',
      '+64 21 600 600',
      '+64 21 700 700',
      '+64 21 800 800',
      '+64 21 900 900',
      '+64 21 100 100',
      '+64 21 200 200',
      '+64 21 300 300',
      '+64 21 450 450',
    ];
    const detected = new Set(
      senders.map((s) => detectRetailerBySender(s)).filter((id): id is string => id !== null)
    );
    expect(detected.size).toBe(10);
  });

  it('returns null for an unknown sender number', () => {
    expect(detectRetailerBySender('+64 21 999 999')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(detectRetailerBySender('')).toBeNull();
  });

  it('is format-tolerant (whitespace and case)', () => {
    expect(detectRetailerBySender('+6421400400')).toBe(
      'ffcfa737-7546-4d1f-9f5e-8bfa1e6fc31a'
    );
    expect(detectRetailerBySender('+64 21 400 400')).toBe(
      'ffcfa737-7546-4d1f-9f5e-8bfa1e6fc31a'
    );
  });
});

// Re-export sanity check on the unrelated helper to keep this file a complete
// unit-test surface for models/retailers.ts without a separate spec.
describe('nameToSearchKeywords', () => {
  it('quotes multi-word retailer names', () => {
    expect(nameToSearchKeywords('Contact Energy')).toEqual(['"Contact Energy"']);
  });

  it('leaves single-word names as-is', () => {
    expect(nameToSearchKeywords('Mercury')).toEqual(['Mercury']);
  });
});
