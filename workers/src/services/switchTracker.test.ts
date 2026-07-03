import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  NOTIFIABLE_STATUSES,
  isNotifiableStatus,
  buildNextStep,
  notifySwitchUpdate,
  runSwitchSanityCheck,
  STUCK_SWITCH_AGE_DAYS,
} from './switchTracker';
import type { Switch } from '../types/switch';

// Mock the I/O dependencies of switchTracker. Each test wires the mock
// returns it needs. notifySwitchUpdate exercises the real predicate + render
// path; only the network/DB edges are stubbed.
vi.mock('./messaging', () => ({
  sendText: vi.fn(),
}));

vi.mock('../models/users', () => ({
  getUserById: vi.fn(),
}));

vi.mock('../models/retailers', () => ({
  getRetailerById: vi.fn(),
}));

vi.mock('../models/plans', () => ({
  getPlanById: vi.fn(),
}));

vi.mock('../models/switches', () => ({
  getStuckSwitches: vi.fn(),
}));

vi.mock('../models/notificationAudit', () => ({
  createNotificationAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./sentTemplates', () => ({
  // Real render for the switch_update template so tests assert the body.
  renderTemplate: vi.fn(
    (_name: string, vars: Record<string, string>) =>
      `Your switch to ${vars.to_retailer} is ${vars.status}. Next: ${vars.next_step}.`
  ),
}));

// failSwitch is imported by switchTracker at module load; stub it so the cron
// test asserts the call without exercising the full transition+email path
// (which has its own coverage in switchService.email.test.ts).
vi.mock('./switchService', async () => {
  const actual = await vi.importActual<typeof import('./switchService')>(
    './switchService'
  );
  return {
    ...actual,
    failSwitch: vi.fn(),
  };
});

import { sendText } from './messaging';
import { getUserById } from '../models/users';
import { getRetailerById } from '../models/retailers';
import { getPlanById } from '../models/plans';
import { getStuckSwitches } from '../models/switches';
import { createNotificationAudit } from '../models/notificationAudit';
import { failSwitch } from './switchService';

const mockedSendText = vi.mocked(sendText);
const mockedGetUserById = vi.mocked(getUserById);
const mockedGetRetailerById = vi.mocked(getRetailerById);
const mockedGetPlanById = vi.mocked(getPlanById);
const mockedGetStuckSwitches = vi.mocked(getStuckSwitches);
const mockedCreateAudit = vi.mocked(createNotificationAudit);
const mockedFailSwitch = vi.mocked(failSwitch);

const ENV = {
  DB: {} as D1Database,
  KV: {} as KVNamespace,
  SENT_API_KEY: 'sent-key',
  ENCRYPTION_KEY: 'enc-key',
  OPS_EMAIL: 'ops@flip.nz',
} as unknown as Parameters<typeof runSwitchSanityCheck>[0];

function makeSwitch(overrides: Partial<Switch> = {}): Switch {
  return {
    id: 'sw-1',
    userId: 'u-1',
    fromRetailerId: 'ret-a',
    toPlanId: 'plan-b',
    status: 'confirmed',
    requestedAt: '2026-01-01T00:00:00.000Z',
    confirmedAt: null,
    completedAt: null,
    failureReason: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Pure helpers — notifiable predicate + next-step copy
// ---------------------------------------------------------------------------

describe('isNotifiableStatus (issue #81 AC milestones)', () => {
  it('flags requested, confirmed, completed, failed as notifiable', () => {
    // AC #81 names SUBMITTED(requested), ACCEPTED(confirmed), ACTIVE(completed),
    // FAILED — all four warrant a user-facing switch_update.
    expect(isNotifiableStatus('requested')).toBe(true);
    expect(isNotifiableStatus('confirmed')).toBe(true);
    expect(isNotifiableStatus('completed')).toBe(true);
    expect(isNotifiableStatus('failed')).toBe(true);
  });

  it('does NOT flag in_progress (noisy intermediate, not in AC)', () => {
    expect(isNotifiableStatus('in_progress')).toBe(false);
  });

  it('NOTIFIABLE_STATUSES contains exactly the 4 AC milestones', () => {
    expect([...NOTIFIABLE_STATUSES].sort()).toEqual(
      ['completed', 'confirmed', 'failed', 'requested']
    );
  });
});

describe('buildNextStep (issue #81 copy per milestone)', () => {
  it('returns non-empty copy for every notifiable status', () => {
    for (const s of ['requested', 'confirmed', 'completed', 'failed'] as const) {
      expect(buildNextStep(s).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. notifySwitchUpdate — dedicated-sender path
// ---------------------------------------------------------------------------

describe('notifySwitchUpdate (issue #81 dedicated sender)', () => {
  it('skips silently for non-notifiable status (in_progress)', async () => {
    const result = await notifySwitchUpdate(ENV, {
      switchRecord: makeSwitch({ status: 'in_progress' }),
      toStatus: 'in_progress',
    });
    expect(result).toBe(false);
    expect(mockedSendText).not.toHaveBeenCalled();
    expect(mockedCreateAudit).not.toHaveBeenCalled();
  });

  it('skips silently when the user has no phone', async () => {
    mockedGetUserById.mockResolvedValue({
      id: 'u-1',
      phone: '',
    } as unknown as Awaited<ReturnType<typeof getUserById>>);

    const result = await notifySwitchUpdate(ENV, {
      switchRecord: makeSwitch(),
      toStatus: 'confirmed',
    });
    expect(result).toBe(false);
    expect(mockedSendText).not.toHaveBeenCalled();
  });

  it('renders + sends + audits on a notifiable milestone (confirmed)', async () => {
    mockedGetUserById.mockResolvedValue({
      id: 'u-1',
      phone: '+64215551111',
    } as unknown as Awaited<ReturnType<typeof getUserById>>);
    mockedGetPlanById.mockResolvedValue({
      retailerId: 'ret-b',
      name: 'Better Plan',
    } as unknown as Awaited<ReturnType<typeof getPlanById>>);
    mockedGetRetailerById.mockResolvedValue({
      name: 'Better Energy',
    } as unknown as Awaited<ReturnType<typeof getRetailerById>>);
    mockedSendText.mockResolvedValue({ messageId: 'sent-msg-1', channel: 'whatsapp' });

    const result = await notifySwitchUpdate(ENV, {
      switchRecord: makeSwitch(),
      toStatus: 'confirmed',
    });

    expect(result).toBe(true);
    expect(mockedSendText).toHaveBeenCalledTimes(1);
    // Template body asserts the to_retailer resolution + status + next_step.
    const body = mockedSendText.mock.calls[0]?.[2] as string;
    expect(body).toContain('Better Energy');
    expect(body).toContain('confirmed');
    expect(mockedCreateAudit).toHaveBeenCalledWith(
      ENV.DB,
      expect.objectContaining({
        userId: 'u-1',
        notificationType: 'switch_update',
        template: 'switch_update',
        sentMessageId: 'sent-msg-1',
        status: 'sent',
      })
    );
  });

  it('swallows send failures and records a failed audit row (no throw)', async () => {
    mockedGetUserById.mockResolvedValue({
      id: 'u-1',
      phone: '+64215551111',
    } as unknown as Awaited<ReturnType<typeof getUserById>>);
    mockedGetPlanById.mockResolvedValue(null);
    mockedGetRetailerById.mockResolvedValue({ name: 'Better Energy' } as never);
    mockedSendText.mockRejectedValue(new Error('Sent 500'));

    // MUST NOT throw — the transition already committed; messaging is best-effort.
    await expect(
      notifySwitchUpdate(ENV, {
        switchRecord: makeSwitch(),
        toStatus: 'failed',
        reason: 'retailer rejected',
      })
    ).resolves.toBe(false);

    expect(mockedCreateAudit).toHaveBeenCalledWith(
      ENV.DB,
      expect.objectContaining({
        userId: 'u-1',
        notificationType: 'switch_update',
        status: 'failed',
      })
    );
  });
});

// ---------------------------------------------------------------------------
// 3. runSwitchSanityCheck — daily cron, stuck switches -> failSwitch
// ---------------------------------------------------------------------------

describe('runSwitchSanityCheck (issue #81 daily cron)', () => {
  it('calls failSwitch for each stuck switch with the cron actor', async () => {
    const stuckRows = [
      {
        id: 'sw-stuck-1',
        userId: 'u-1',
        fromRetailerId: 'ret-a',
        toPlanId: 'plan-b',
        requestedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'sw-stuck-2',
        userId: 'u-2',
        fromRetailerId: 'ret-a',
        toPlanId: 'plan-c',
        requestedAt: '2026-01-02T00:00:00.000Z',
      },
    ];
    mockedGetStuckSwitches.mockResolvedValue(stuckRows);
    // failSwitch returns the post-failure switch; notifySwitchUpdate will then
    // run but skip because getUserById has no phone by default.
    mockedFailSwitch.mockResolvedValue(makeSwitch({ id: 'sw-stuck-1', status: 'failed' }));

    const result = await runSwitchSanityCheck(ENV);

    expect(mockedGetStuckSwitches).toHaveBeenCalledWith(
      ENV.DB,
      expect.objectContaining({ olderThanDays: STUCK_SWITCH_AGE_DAYS })
    );
    expect(mockedFailSwitch).toHaveBeenCalledTimes(2);
    // Each failSwitch call carries actor='cron' + the sanity reason.
    for (const call of mockedFailSwitch.mock.calls) {
      const input = call[2] as { actor: string; reason: string };
      expect(input.actor).toBe('cron');
      expect(input.reason).toContain('No retailer confirmation');
    }
    expect(result.failed).toBe(2);
    expect(result.stuckScanned).toBe(2);
  });

  it('passes the stuck threshold through to the query', async () => {
    mockedGetStuckSwitches.mockResolvedValue([]);
    await runSwitchSanityCheck(ENV, { olderThanDays: 14 });
    expect(mockedGetStuckSwitches).toHaveBeenCalledWith(
      ENV.DB,
      expect.objectContaining({ olderThanDays: 14 })
    );
  });

  it('continues processing when one switch throws (no abort)', async () => {
    mockedGetStuckSwitches.mockResolvedValue([
      {
        id: 'sw-err',
        userId: 'u-1',
        fromRetailerId: 'ret-a',
        toPlanId: 'plan-b',
        requestedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'sw-ok',
        userId: 'u-2',
        fromRetailerId: 'ret-a',
        toPlanId: 'plan-c',
        requestedAt: '2026-01-02T00:00:00.000Z',
      },
    ]);
    mockedFailSwitch
      .mockRejectedValueOnce(new Error('transition blew up'))
      .mockResolvedValueOnce(makeSwitch({ id: 'sw-ok', status: 'failed' }));

    const result = await runSwitchSanityCheck(ENV);

    expect(mockedFailSwitch).toHaveBeenCalledTimes(2);
    expect(result.failed).toBe(1);
    expect(result.errors).toBe(1);
  });

  it('sends a failed switch_update to the user after failing (milestone notify)', async () => {
    mockedGetStuckSwitches.mockResolvedValue([
      {
        id: 'sw-stuck-1',
        userId: 'u-1',
        fromRetailerId: 'ret-a',
        toPlanId: 'plan-b',
        requestedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    mockedFailSwitch.mockResolvedValue(
      makeSwitch({ id: 'sw-stuck-1', status: 'failed', userId: 'u-1' })
    );
    mockedGetUserById.mockResolvedValue({
      id: 'u-1',
      phone: '+64215550000',
    } as unknown as Awaited<ReturnType<typeof getUserById>>);
    mockedGetPlanById.mockResolvedValue(null);
    mockedGetRetailerById.mockResolvedValue({ name: 'Better Energy' } as never);
    mockedSendText.mockResolvedValue({ messageId: 'm1', channel: 'whatsapp' });

    const result = await runSwitchSanityCheck(ENV);

    expect(mockedSendText).toHaveBeenCalledTimes(1);
    expect(result.failedNotifySent).toBe(1);
    expect(mockedCreateAudit).toHaveBeenCalledWith(
      ENV.DB,
      expect.objectContaining({
        userId: 'u-1',
        notificationType: 'switch_update',
        status: 'sent',
      })
    );
  });

  it('STUCK_SWITCH_AGE_DAYS is 7 (the documented threshold)', () => {
    expect(STUCK_SWITCH_AGE_DAYS).toBe(7);
  });
});
