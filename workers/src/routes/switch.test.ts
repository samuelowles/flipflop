import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createSwitchRoute } from './switch';

// ---------------------------------------------------------------------------
// Module mocks (hoisted)
// ---------------------------------------------------------------------------

vi.mock('../services/switchService', () => ({
  createSwitch: vi.fn(),
  DuplicateActiveSwitchError: class DuplicateActiveSwitchError extends Error {
    readonly existingSwitchId: string;
    constructor(id: string) {
      super('duplicate');
      this.name = 'DuplicateActiveSwitchError';
      this.existingSwitchId = id;
    }
  },
}));

vi.mock('../models/plans', () => ({
  getPlanById: vi.fn(),
}));

vi.mock('../models/users', () => ({
  getUserById: vi.fn(),
}));

vi.mock('../models/retailers', () => ({
  getRetailerById: vi.fn(),
}));

vi.mock('../services/switch/retailerAdapter', () => ({
  requestRetailerSwitch: vi.fn(),
}));

// Imported after vi.mock so the mocks apply.
import { createSwitch } from '../services/switchService';
import { getPlanById } from '../models/plans';
import { getUserById } from '../models/users';
import { getRetailerById } from '../models/retailers';
import { requestRetailerSwitch } from '../services/switch/retailerAdapter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp(): Hono {
  const app = new Hono();
  app.post('/api/switch', createSwitchRoute);
  return app;
}

function postBody(body: unknown): Request {
  return new Request('http://localhost/api/switch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const env = {
  DB: {} as D1Database,
  ENCRYPTION_KEY: 'test-key',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/switch (issue #130)', () => {
  it('201 on valid request — returns { switch_id, status: "requested" }', async () => {
    vi.mocked(getPlanById).mockResolvedValue({
      id: 'plan-b',
      retailerId: 'ret-b',
      name: 'Better Plan',
      region: null,
      cPerKwh: 20,
      cPerDay: 1,
      tierThresholdsJson: null,
      promptPaymentDiscount: null,
      conditionsJson: null,
      lowUserEligible: true,
      source: 'manual',
      eiep14aId: null,
      effectiveFrom: null,
      effectiveTo: null,
      provenance: null,
      sourceUrl: null,
      ingestedAt: null,
      contentHash: null,
      isCurrent: true,
    } as never);
    vi.mocked(getUserById).mockResolvedValue({
      id: 'u-1',
      phone: '+641',
      sentContactId: null,
      name: null,
      email: null,
      subscriptionTier: 'free',
      stripeCustomerId: null,
      currentRetailerId: 'ret-a',
      currentPlanName: null,
      icpNumber: null,
      installationAddress: null,
      notificationThresholdCents: 500,
      state: 'idle',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    } as never);
    vi.mocked(createSwitch).mockResolvedValue({
      id: 'sw-new',
      userId: 'u-1',
      fromRetailerId: 'ret-a',
      toPlanId: 'plan-b',
      status: 'requested',
      requestedAt: '2026-07-03T00:00:00.000Z',
      confirmedAt: null,
      completedAt: null,
    } as never);
    vi.mocked(getRetailerById).mockResolvedValue({
      id: 'ret-b',
      name: 'Better Retailer',
      domain: 'better.co.nz',
      parserId: null,
      isActive: true,
    } as never);
    vi.mocked(requestRetailerSwitch).mockResolvedValue({
      deepLink: 'https://better.co.nz/join?s=sw-new.token',
      method: 'deep_link',
    });

    const res = await buildApp().fetch(
      postBody({ user_id: 'u-1', to_plan_id: 'plan-b' }),
      env
    );

    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      switch_id: string;
      status: string;
      switch_url: string | null;
      method: string;
    };
    expect(json.switch_id).toBe('sw-new');
    expect(json.status).toBe('requested');
    expect(json.switch_url).toBe('https://better.co.nz/join?s=sw-new.token');
    expect(json.method).toBe('deep_link');

    // createSwitch called with derived from_retailer_id + actor=user.
    expect(createSwitch).toHaveBeenCalledWith(expect.anything(), {
      userId: 'u-1',
      fromRetailerId: 'ret-a',
      toPlanId: 'plan-b',
      actor: 'user',
    });
    // requestRetailerSwitch called with the created switch + target retailer.
    expect(requestRetailerSwitch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        switch: expect.objectContaining({ id: 'sw-new' }),
        retailer: expect.objectContaining({ id: 'ret-b' }),
      })
    );
  });

  it('409 when a duplicate active switch exists for the same user+plan', async () => {
    vi.mocked(getPlanById).mockResolvedValue({ id: 'plan-b' } as never);
    vi.mocked(getUserById).mockResolvedValue({
      id: 'u-1',
      currentRetailerId: 'ret-a',
    } as never);

    const { DuplicateActiveSwitchError } = await import('../services/switchService');
    vi.mocked(createSwitch).mockRejectedValue(
      new DuplicateActiveSwitchError('sw-existing')
    );

    const res = await buildApp().fetch(
      postBody({ user_id: 'u-1', to_plan_id: 'plan-b' }),
      env
    );

    expect(res.status).toBe(409);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe('duplicate_active_switch');
    expect(json.existing_switch_id).toBe('sw-existing');
  });

  it('400 on missing to_plan_id', async () => {
    const res = await buildApp().fetch(
      postBody({ user_id: 'u-1' }),
      env
    );

    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe('missing_to_plan_id');
    expect(createSwitch).not.toHaveBeenCalled();
  });

  it('400 on missing user_id', async () => {
    const res = await buildApp().fetch(
      postBody({ to_plan_id: 'plan-b' }),
      env
    );

    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe('missing_user_id');
    expect(createSwitch).not.toHaveBeenCalled();
  });

  it('400 when to_plan_id does not reference an existing plan', async () => {
    vi.mocked(getPlanById).mockResolvedValue(null);

    const res = await buildApp().fetch(
      postBody({ user_id: 'u-1', to_plan_id: 'nope' }),
      env
    );

    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe('unknown_plan');
    expect(createSwitch).not.toHaveBeenCalled();
  });

  it('400 when user_id does not reference an existing user', async () => {
    vi.mocked(getPlanById).mockResolvedValue({ id: 'plan-b' } as never);
    vi.mocked(getUserById).mockResolvedValue(null);

    const res = await buildApp().fetch(
      postBody({ user_id: 'ghost', to_plan_id: 'plan-b' }),
      env
    );

    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe('unknown_user');
    expect(createSwitch).not.toHaveBeenCalled();
  });

  it('400 when user has no current retailer set', async () => {
    vi.mocked(getPlanById).mockResolvedValue({ id: 'plan-b' } as never);
    vi.mocked(getUserById).mockResolvedValue({
      id: 'u-1',
      currentRetailerId: null,
    } as never);

    const res = await buildApp().fetch(
      postBody({ user_id: 'u-1', to_plan_id: 'plan-b' }),
      env
    );

    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe('no_current_retailer');
    expect(createSwitch).not.toHaveBeenCalled();
  });

  it('400 on invalid (non-object) JSON body', async () => {
    const req = new Request('http://localhost/api/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    const res = await buildApp().fetch(req, env);

    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe('invalid_body');
  });
});
