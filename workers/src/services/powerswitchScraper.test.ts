import { describe, it, expect } from 'vitest';
import {
  isPowerswitchEnabled,
  parsePlanPage,
  detectSelectorDrift,
  listPlanPageUrls,
  scrapePowerswitchPlans,
  POWERSWITCH_BASE_URL,
  type EnvWithPowerswitch,
} from './powerswitchScraper';
import { upsertPowerswitchPlan } from '../models/plans';
import {
  contact_auckland_standard,
  mercury_christchurch_tou,
  flick_incomplete,
  drifted_structure,
  mercury_auckland_standard,
  genesis_auckland_standard,
  meridian_wellington_standard,
  nova_auckland_lowuser,
  electric_kiwi_christchurch,
} from './powerswitchFixtures';

/**
 * Issue #66 tests: Powerswitch scraper bridge — gate, parser, manual-protection,
 * selector drift, INERT default. Fixtures are inlined (TS) so the tests run
 * under @cloudflare/vitest-pool-workers without node:fs.
 */

describe('isPowerswitchEnabled (issue #66 gate)', () => {
  const base: EnvWithPowerswitch = { DB: {} as D1Database, KV: {} as KVNamespace };

  it('returns false when flag absent (INERT default)', () => {
    expect(isPowerswitchEnabled(base)).toBe(false);
  });

  it('returns false when flag is "false"', () => {
    expect(isPowerswitchEnabled({ ...base, POWERSWITCH_SCRAPER_ENABLED: 'false' })).toBe(false);
  });

  it('returns true only when flag is exactly "true"', () => {
    expect(isPowerswitchEnabled({ ...base, POWERSWITCH_SCRAPER_ENABLED: 'true' })).toBe(true);
  });

  it('is case-sensitive ("True" does not arm)', () => {
    expect(isPowerswitchEnabled({ ...base, POWERSWITCH_SCRAPER_ENABLED: 'True' })).toBe(false);
  });
});

describe('listPlanPageUrls', () => {
  it('returns only public plan-listing URLs under powerswitch.org.nz', () => {
    const urls = listPlanPageUrls();
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith(POWERSWITCH_BASE_URL)).toBe(true);
    }
  });
});

describe('parsePlanPage', () => {
  it('extracts rate fields from a standard fixture', () => {
    const html = contact_auckland_standard;
    const parsed = parsePlanPage(html, 'https://www.powerswitch.org.nz/plans/auckland');
    expect(parsed).not.toBeNull();
    expect(parsed!.retailer).toBe('Contact Energy');
    expect(parsed!.planName).toBe('Good Nights');
    expect(parsed!.region).toBe('Auckland');
    expect(parsed!.cPerKwh).toBe(28.54);
    expect(parsed!.cPerDay).toBe(2.10);
    expect(parsed!.promptPaymentDiscount).toBe(12);
    expect(parsed!.lowUserEligible).toBe(true);
  });

  it('extracts a TOU plan fixture', () => {
    const html = mercury_christchurch_tou;
    const parsed = parsePlanPage(html, 'https://www.powerswitch.org.nz/plans/christchurch');
    expect(parsed).not.toBeNull();
    expect(parsed!.conditions.tou).toBe(true);
  });

  it('returns null for incomplete fixture with both money fields missing', () => {
    const html = flick_incomplete;
    const parsed = parsePlanPage(html, 'https://www.powerswitch.org.nz/plans/auckland');
    expect(parsed).toBeNull();
  });

  it('returns null for drifted structure with no data attributes', () => {
    const html = drifted_structure;
    const parsed = parsePlanPage(html, 'https://www.powerswitch.org.nz/plans/auckland');
    expect(parsed).toBeNull();
  });

  it('parses across 5+ retailers (fixture variety)', () => {
    const fixtures = [
      contact_auckland_standard,
      mercury_auckland_standard,
      genesis_auckland_standard,
      meridian_wellington_standard,
      nova_auckland_lowuser,
      electric_kiwi_christchurch,
    ];
    const retailers = new Set<string>();
    for (const html of fixtures) {
      const parsed = parsePlanPage(html, 'x');
      expect(parsed).not.toBeNull();
      retailers.add(parsed!.retailer);
    }
    expect(retailers.size).toBeGreaterThanOrEqual(5);
  });
});

describe('detectSelectorDrift', () => {
  it('does not flag drift across well-formed fixtures', () => {
    const samples = [
      { html: contact_auckland_standard },
      { html: mercury_auckland_standard },
      { html: genesis_auckland_standard },
    ];
    const { drift, missingRatio } = detectSelectorDrift(samples);
    expect(drift).toBe(false);
    expect(missingRatio).toBeLessThanOrEqual(0.5);
  });

  it('flags drift when required money fields exceed missing-threshold', () => {
    const samples = [
      { html: drifted_structure },
      { html: flick_incomplete },
    ];
    const { drift } = detectSelectorDrift(samples);
    expect(drift).toBe(true);
  });
});

/**
 * Minimal in-memory D1 mock for the manual-protection upsert path.
 */
function mockD1(existing: { id: string; provenance: string | null } | null) {
  const updates: unknown[] = [];
  const inserts: unknown[] = [];

  const handler: ProxyHandler<Record<string, unknown>> = {
    get: (_t, prop) => {
      if (prop === 'prepare') {
        return (sql: string) => {
          const trimmed = sql.trim().replace(/\s+/g, ' ');
          const bind = (...args: unknown[]) => ({
            run: async () => {
              if (trimmed.startsWith('UPDATE')) updates.push(args);
              else if (trimmed.startsWith('INSERT')) inserts.push(args);
            },
            first: async () => {
              if (trimmed.startsWith('SELECT id, provenance')) return existing;
              return null;
            },
          });
          return { bind };
        };
      }
      return undefined;
    },
  };

  return { db: new Proxy({} as Record<string, unknown>, handler) as unknown as D1Database, updates, inserts };
}

describe('upsertPowerswitchPlan manual-protection (issue #66)', () => {
  const plan = {
    retailer: 'Contact Energy',
    retailerId: 'contact',
    planName: 'Good Nights',
    region: 'Auckland',
    cPerKwh: 28.54,
    cPerDay: 2.10,
    promptPaymentDiscount: 12,
    lowUserEligible: true,
    conditions: {},
    sourceUrl: 'https://www.powerswitch.org.nz/plans/auckland',
  };

  it('blocks UPDATE when an existing row is provenance=manual', async () => {
    const { db, updates } = mockD1({ id: 'row-1', provenance: 'manual' });
    const res = await upsertPowerswitchPlan(db, { plan, ingestedAt: '2026-07-02T00:00:00Z' });
    expect(res.changed).toBe(false);
    expect(res.blockedByManual).toBe(true);
    expect(updates).toHaveLength(0);
  });

  it('issues UPDATE when existing row is provenance=powerswitch', async () => {
    const { db, updates } = mockD1({ id: 'row-1', provenance: 'powerswitch' });
    const res = await upsertPowerswitchPlan(db, { plan, ingestedAt: '2026-07-02T00:00:00Z' });
    expect(res.changed).toBe(true);
    expect(res.blockedByManual).toBe(false);
    expect(updates).toHaveLength(1);
  });

  it('issues INSERT when no existing row', async () => {
    const { db, inserts } = mockD1(null);
    const res = await upsertPowerswitchPlan(db, { plan, ingestedAt: '2026-07-02T00:00:00Z' });
    expect(res.changed).toBe(true);
    expect(res.blockedByManual).toBe(false);
    expect(inserts).toHaveLength(1);
  });
});

describe('scrapePowerswitchPlans (issue #66 INERT gate)', () => {
  it('returns zero counts and never fetches when flag is false', async () => {
    const env: EnvWithPowerswitch = {
      DB: {} as D1Database,
      KV: {} as KVNamespace,
      POWERSWITCH_SCRAPER_ENABLED: 'false',
    };
    const counts = await scrapePowerswitchPlans(env);
    expect(counts.fetched).toBe(0);
    expect(counts.parsed).toBe(0);
    expect(counts.failed).toBe(0);
  });
});
