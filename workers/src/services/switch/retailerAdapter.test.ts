import { describe, it, expect } from 'vitest';
import {
  getRetailerAdapter,
  requestRetailerSwitch,
  DeepLinkAdapter,
} from './retailerAdapter';
import type { Switch } from '../../types/switch';
import type { Retailer } from '../../types/retailer';

const ENV = { ENCRYPTION_KEY: 'test-secret-key' };

const CONTACT_ID = 'ffcfa737-7546-4d1f-9f5e-8bfa1e6fc31a'; // Contact Energy (mapped)
const UNKNOWN_ID = '00000000-0000-0000-0000-000000000000'; // not in config map

function buildSwitch(overrides: Partial<Switch> = {}): Switch {
  return {
    id: 'sw-1',
    userId: 'u-1',
    fromRetailerId: 'ret-a',
    toPlanId: 'plan-b',
    status: 'requested',
    requestedAt: '2026-07-03T00:00:00.000Z',
    confirmedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function buildRetailer(overrides: Partial<Retailer> = {}): Retailer {
  return {
    id: CONTACT_ID,
    name: 'Contact Energy',
    domain: 'contact.co.nz',
    emailDomains: ['contactenergy.co.nz'],
    parserId: 'contact',
    isActive: true,
    ...overrides,
  };
}

describe('getRetailerAdapter (issue #131)', () => {
  it('returns a DeepLinkAdapter for a known retailer', () => {
    const adapter = getRetailerAdapter(CONTACT_ID, ENV);
    expect(adapter).toBeInstanceOf(DeepLinkAdapter);
  });

  it('returns a DeepLinkAdapter for an unknown retailer (graceful default)', () => {
    const adapter = getRetailerAdapter(UNKNOWN_ID, ENV);
    expect(adapter).toBeInstanceOf(DeepLinkAdapter);
  });
});

describe('DeepLinkAdapter.requestSwitch (issue #131)', () => {
  it('builds a URL using the explicit config-map base for a known retailer', async () => {
    const adapter = getRetailerAdapter(CONTACT_ID, ENV);
    const result = await adapter.requestSwitch({
      switch: buildSwitch(),
      retailer: buildRetailer({ id: CONTACT_ID, domain: 'contact.co.nz' }),
    });

    expect(result.method).toBe('deep_link');
    const url = new URL(result.deepLink);
    expect(url.origin + url.pathname).toBe('https://contact.co.nz/join');
    // Opaque signed token present; no raw user PII.
    expect(url.searchParams.get('s')).toBeTruthy();
    expect(url.searchParams.get('s')).toMatch(/^sw-1\.[0-9a-f]+$/);
  });

  it('falls back to a domain-derived /join URL for an unknown retailer', async () => {
    const adapter = getRetailerAdapter(UNKNOWN_ID, ENV);
    const result = await adapter.requestSwitch({
      switch: buildSwitch(),
      retailer: buildRetailer({
        id: UNKNOWN_ID,
        name: 'Mystery Retailer',
        domain: 'mystery.co.nz',
      }),
    });

    const url = new URL(result.deepLink);
    expect(url.origin + url.pathname).toBe('https://mystery.co.nz/join');
    expect(url.searchParams.get('s')).toBeTruthy();
  });

  it('appends the plan code when provided', async () => {
    const adapter = getRetailerAdapter(CONTACT_ID, ENV);
    const result = await adapter.requestSwitch({
      switch: buildSwitch(),
      retailer: buildRetailer({ id: CONTACT_ID }),
      planCode: 'GOOD_PLAN',
    });

    const url = new URL(result.deepLink);
    expect(url.searchParams.get('plan')).toBe('GOOD_PLAN');
  });

  it('does NOT encode any PII in the query string', async () => {
    const adapter = getRetailerAdapter(CONTACT_ID, ENV);
    const result = await adapter.requestSwitch({
      switch: buildSwitch({
        userId: 'u-secret-user-id',
        fromRetailerId: 'ret-a',
      }),
      retailer: buildRetailer({ id: CONTACT_ID }),
    });

    const qs = result.deepLink.split('?')[1] ?? '';
    // No user id, phone, email, or raw switch internal fields beyond the opaque token.
    expect(qs).not.toContain('u-secret-user-id');
    expect(qs).not.toContain('user_id');
    expect(qs).not.toContain('phone');
    expect(qs).not.toContain('email');
    // The only params are `s` (token) and optionally `plan`.
    const params = new URLSearchParams(qs);
    for (const key of params.keys()) {
      expect(['s', 'plan']).toContain(key);
    }
  });

  it('produces a deterministic attribution token for the same switch id + key', async () => {
    const adapterA = getRetailerAdapter(CONTACT_ID, ENV);
    const adapterB = getRetailerAdapter(CONTACT_ID, ENV);
    const sw = buildSwitch({ id: 'sw-stable' });
    const retailer = buildRetailer({ id: CONTACT_ID });

    const a = await adapterA.requestSwitch({ switch: sw, retailer });
    const b = await adapterB.requestSwitch({ switch: sw, retailer });
    expect(a.deepLink).toBe(b.deepLink);
  });
});

describe('requestRetailerSwitch entry point (issue #131)', () => {
  it('returns a deep_link result and is callable from the route layer', async () => {
    // Silence the structured log during the test.
    const origLog = console.log;
    const logs: string[] = [];
    console.log = (msg: string) => logs.push(msg);

    try {
      const result = await requestRetailerSwitch(ENV, {
        switch: buildSwitch(),
        retailer: buildRetailer({ id: CONTACT_ID }),
        planCode: 'PLAN_X',
      });

      expect(result.method).toBe('deep_link');
      expect(result.deepLink).toContain('contact.co.nz/join');
      expect(result.deepLink).toContain('plan=PLAN_X');

      // AC #131: "All calls logged with request_id and retailer".
      const logLine = logs.find((l) => l.includes('retailer_switch_request'));
      expect(logLine).toBeTruthy();
      const parsed = JSON.parse(logLine as string);
      expect(parsed.retailer_id).toBe(CONTACT_ID);
      expect(parsed.switch_id).toBe('sw-1');
      expect(parsed.request_id).toBeTruthy();
    } finally {
      console.log = origLog;
    }
  });
});
