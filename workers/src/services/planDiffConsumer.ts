/**
 * Issue #75 — plan-data-change re-compare consumer.
 *
 * The EIEP14A ingestion worker (services/eiep14a.ts → writePlanDiffs) writes a
 * per-retailer diff to KV at `plans:diff:{retailer_id}` whenever a plan's
 * tracked fields change. This module is the matching CONSUMER: on each daily
 * cron tick it scans those diff keys, finds the affected users, and enqueues a
 * fresh COMPARE_QUEUE message per user so runComparison recomputes against the
 * new plan data.
 *
 * Ships INERT-by-nature: the loop body only does work when KV holds diff keys,
 * which only happens when EIEP14A/powerswitch ingestion runs (both currently
 * disabled, live October). No feature flag needed.
 *
 * Dedup: a 7-day KV idempotency key (`recompare:{userId}`) prevents enqueuing
 * the same user twice within 7 days. The comparison itself also dedups
 * notifications downstream; this KV gate just saves queue bandwidth.
 *
 * Ack semantics: after a diff key is processed (users enqueued or skipped via
 * dedup) the key is deleted so it is not re-consumed every cron tick. If a new
 * change lands before the 7-day dedup window elapses, the diff key is
 * re-written by the writer and users NOT yet past the dedup window are simply
 * skipped — which is the desired behaviour (no duplicate notifications).
 */

import { getUsersByRetailer } from '../models/users';

/** KV key written by services/eiep14a.ts writePlanDiffs(). */
const DIFF_KEY_PREFIX = 'plans:diff:';
/** 7-day dedup window per user (Cloudflare KV TTL granularity is seconds). */
const DEDUP_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface PlanDiffConsumerEnv {
  readonly DB: D1Database;
  readonly KV: KVNamespace;
  readonly COMPARE_QUEUE: Queue<{ user_id: string; bill_id?: string; parsed_at?: string }>;
}

interface PlanDiffPayload {
  readonly retailer_id: string;
  readonly changed_fields: readonly string[];
  readonly detected_at: string;
}

/**
 * Consume every pending `plans:diff:{retailer_id}` KV key. For each affected
 * retailer, enqueue affected users to COMPARE_QUEUE (7-day dedup per user),
 * then delete the diff key so it is not reprocessed on the next tick.
 *
 * Returns a summary for observability. Emits ZERO PII to logs (only counts +
 * retailer ids).
 */
export async function consumePlanDiffs(env: PlanDiffConsumerEnv): Promise<{
  retailersProcessed: number;
  usersEnqueued: number;
  usersSkippedDedup: number;
}> {
  let retailersProcessed = 0;
  let usersEnqueued = 0;
  let usersSkippedDedup = 0;

  // List diff keys. KV list is eventually consistent across writes, but the
  // writer and consumer both run in the same Worker so the put→list ordering
  // is fine on the daily cadence.
  const list = await env.KV.list({ prefix: DIFF_KEY_PREFIX });

  for (const key of list.keys) {
    const retailerId = key.name.slice(DIFF_KEY_PREFIX.length);
    if (!retailerId) continue;

    let payload: PlanDiffPayload | null = null;
    try {
      const raw = await env.KV.get(key.name);
      if (!raw) continue; // race: deleted between list and get
      payload = JSON.parse(raw) as PlanDiffPayload;
    } catch {
      // Malformed payload — ack (delete) so it does not loop forever.
      console.log(JSON.stringify({
        type: 'plan_diff_malformed',
        retailer_id: retailerId,
        timestamp: new Date().toISOString(),
      }));
      await safeDelete(env.KV, key.name);
      continue;
    }

    const userIds = await getUsersByRetailer(env.DB, retailerId);

    for (const userId of userIds) {
      const dedupKey = `recompare:${userId}`;
      const existing = await env.KV.get(dedupKey);
      if (existing !== null) {
        usersSkippedDedup++;
        continue;
      }
      try {
        // Set the dedup gate BEFORE enqueuing so a concurrent tick cannot
        // double-enqueue. KV writes are strongly consistent within a Worker.
        await env.KV.put(dedupKey, payload!.detected_at, {
          expirationTtl: DEDUP_TTL_SECONDS,
        });
        await env.COMPARE_QUEUE.send({ user_id: userId });
        usersEnqueued++;
      } catch {
        // Best-effort: roll back the dedup key if the enqueue failed so the
        // next tick can retry the user.
        await safeDelete(env.KV, dedupKey);
        console.log(JSON.stringify({
          type: 'recompare_enqueue_error',
          retailer_id: retailerId,
          timestamp: new Date().toISOString(),
        }));
      }
    }

    retailersProcessed++;
    // Ack the diff so the next tick does not reprocess it. Users that were
    // skipped by dedup this run will NOT be re-enqueued unless the writer
    // emits a fresh diff key (which it does on the next real change).
    await safeDelete(env.KV, key.name);

    console.log(JSON.stringify({
      type: 'plan_diff_consumed',
      retailer_id: retailerId,
      changed_fields: payload!.changed_fields,
      detected_at: payload!.detected_at,
      affected_users: userIds.length,
      enqueued: usersEnqueued,
      timestamp: new Date().toISOString(),
    }));
  }

  console.log(JSON.stringify({
    type: 'plan_diff_consumer_run',
    retailers_processed: retailersProcessed,
    users_enqueued: usersEnqueued,
    users_skipped_dedup: usersSkippedDedup,
    timestamp: new Date().toISOString(),
  }));

  return { retailersProcessed, usersEnqueued, usersSkippedDedup };
}

/** Delete a KV key, swallowing errors (KV may be unavailable in some envs). */
async function safeDelete(kv: KVNamespace, key: string): Promise<void> {
  try {
    await kv.delete(key);
  } catch {
    // non-fatal
  }
}
