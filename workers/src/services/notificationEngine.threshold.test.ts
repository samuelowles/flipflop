/**
 * Issue #126 — unit tests for the notification threshold rule.
 *
 * The predicate `meetsThreshold` is a pure function (no D1), so this covers
 * the AC boundary cases directly:
 *   4999 cents -> no notification
 *   5000 cents -> notify (boundary, inclusive)
 *   5001 cents -> notify
 *
 * The default-when-missing behaviour is exercised against the model-layer
 * helper `getNotificationThreshold` using a stubbed D1Database, asserting it
 * falls back to 5000 cents when the user row or column is absent.
 */

import { describe, it, expect } from 'vitest';
import { meetsThreshold } from './notificationEngine';
import {
  getNotificationThreshold,
  DEFAULT_NOTIFICATION_THRESHOLD_CENTS,
} from '../models/users';
import type { EncryptionEnv } from '../models/encryption';

const env: EncryptionEnv = { ENCRYPTION_KEY: 'test-key-32-bytes-long-aaaaaaaa' };

describe('meetsThreshold (issue #126 pure rule)', () => {
  it('notifies when saving equals the threshold (boundary, inclusive)', () => {
    expect(meetsThreshold(5000, 5000)).toBe(true);
  });

  it('notifies when saving is one cent above the threshold', () => {
    expect(meetsThreshold(5001, 5000)).toBe(true);
  });

  it('does not notify when saving is one cent below the threshold', () => {
    expect(meetsThreshold(4999, 5000)).toBe(false);
  });

  it('respects a per-user configured threshold above the default', () => {
    expect(meetsThreshold(5000, 7000)).toBe(false);
    expect(meetsThreshold(7000, 7000)).toBe(true);
  });

  it('respects a per-user configured threshold below the default', () => {
    expect(meetsThreshold(3000, 2500)).toBe(true);
  });
});

describe('getNotificationThreshold (default-when-missing)', () => {
  it('returns the default when the user row does not exist', async () => {
    const stub = {
      prepare: () => ({
        bind: () => ({ first: async () => null }),
      }),
    } as unknown as D1Database;

    const threshold = await getNotificationThreshold(stub, env, 'no-such-user');
    expect(threshold).toBe(DEFAULT_NOTIFICATION_THRESHOLD_CENTS);
  });

  it('returns the default when the column is unset / non-positive', async () => {
    // Simulates a row where notification_threshold_cents came through as 0
    // (defensive — schema default is 5000, but guard at the read boundary).
    const stub = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({
            id: 'u1',
            phone: null,
            phone_encrypted: null,
            name: null,
            email: null,
            subscription_tier: 'free',
            stripe_customer_id: null,
            current_retailer_id: null,
            current_plan_name: null,
            icp_number: null,
            installation_address: null,
            notification_threshold_cents: 0,
            state: 'idle',
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
          }),
        }),
      }),
    } as unknown as D1Database;

    const threshold = await getNotificationThreshold(stub, env, 'u1');
    expect(threshold).toBe(DEFAULT_NOTIFICATION_THRESHOLD_CENTS);
  });
});
