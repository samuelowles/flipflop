/**
 * Issue #130 — POST /api/switch route.
 *
 * Creates a new switch request for a user + target plan, rejecting if an
 * active switch already exists for the same (user, plan) pair. Returns the
 * created switch id + status `requested` (201), or 409 on duplicate.
 *
 * Auth: there is no user-session/JWT in the repo yet. Mirrors the closest
 * user-facing route (`/eval`) — body carries `user_id`, gated by rateLimit
 * only. When a real user-auth layer lands it plugs in here as middleware.
 *
 * SEAM for #131: the response returns `{ switch_id, status }` only. Issue
 * #131 will extend it with the retailer deep-link / switch URL (the actual
 * retailer API call is #131, NOT this route).
 */

import type { Context } from 'hono';
import { createSwitch, DuplicateActiveSwitchError } from '../services/switchService';
import { requestRetailerSwitch } from '../services/switch/retailerAdapter';
import { getPlanById } from '../models/plans';
import { getUserById } from '../models/users';
import { getRetailerById } from '../models/retailers';
import type { EncryptionEnv } from '../models/encryption';

interface SwitchRequestBody {
  readonly user_id?: unknown;
  readonly to_plan_id?: unknown;
}

interface SwitchRouteEnv {
  DB: D1Database;
}

/**
 * POST /api/switch — create a switch request.
 *
 * Body: `{ user_id: string, to_plan_id: string }`
 *  - 201 `{ switch_id, status: 'requested' }` on success
 *  - 400 on missing/invalid body or unknown plan/user
 *  - 409 if an active switch already exists for this user + plan
 */
export async function createSwitchRoute(c: Context): Promise<Response> {
  const env = c.env as SwitchRouteEnv & EncryptionEnv;
  const db = env.DB;

  const body = (await c.req.json().catch(() => null)) as SwitchRequestBody | null;
  if (!body || typeof body !== 'object') {
    return c.json(
      { error: 'Invalid JSON body', code: 'invalid_body' },
      400
    );
  }

  const userId = body.user_id;
  const toPlanId = body.to_plan_id;
  if (typeof userId !== 'string' || userId.trim() === '') {
    return c.json(
      { error: 'user_id is required', code: 'missing_user_id' },
      400
    );
  }
  if (typeof toPlanId !== 'string' || toPlanId.trim() === '') {
    return c.json(
      { error: 'to_plan_id is required', code: 'missing_to_plan_id' },
      400
    );
  }

  // Validate the target plan exists (boundary validation — AC #130).
  const plan = await getPlanById(db, toPlanId);
  if (!plan) {
    return c.json(
      { error: 'to_plan_id does not reference an existing plan', code: 'unknown_plan' },
      400
    );
  }

  // Derive from_retailer_id from the user's current retailer.
  const user = await getUserById(db, env, userId);
  if (!user) {
    return c.json(
      { error: 'user_id does not reference an existing user', code: 'unknown_user' },
      400
    );
  }
  if (!user.currentRetailerId) {
    return c.json(
      { error: 'user has no current retailer set', code: 'no_current_retailer' },
      400
    );
  }

  try {
    const switchRecord = await createSwitch(db, {
      userId,
      fromRetailerId: user.currentRetailerId,
      toPlanId,
      actor: 'user',
    });

    // Issue #131 — resolve the TARGET retailer (the plan's retailer) and build
    // the signed deep-link the user follows to action the switch on their site.
    const targetRetailer = await getRetailerById(db, plan.retailerId);
    let switchUrl: string | null = null;
    let switchMethod: 'deep_link' | 'api' = 'deep_link';
    if (targetRetailer) {
      const result = await requestRetailerSwitch(env, {
        switch: switchRecord,
        retailer: targetRetailer,
        planCode: plan.name,
      });
      switchUrl = result.deepLink;
      switchMethod = result.method;
    }

    // ponytail: keep the existing 201 shape, just add switch_url + method.
    return c.json(
      {
        switch_id: switchRecord.id,
        status: switchRecord.status,
        switch_url: switchUrl,
        method: switchMethod,
      },
      201
    );
  } catch (error) {
    if (error instanceof DuplicateActiveSwitchError) {
      return c.json(
        {
          error: 'An active switch already exists for this user + plan',
          code: 'duplicate_active_switch',
          existing_switch_id: error.existingSwitchId,
        },
        409
      );
    }
    throw error;
  }
}
