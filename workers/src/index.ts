import { Hono, type Context } from 'hono';
import { errorHandler } from './middleware/errorHandler';
import { sentAuth } from './middleware/sentAuth';
import { rateLimit } from './middleware/rateLimit';
import { adminAuth } from './middleware/adminAuth';
import { messagingWebhook } from './routes/messaging';
import { gmailConnectPage, gmailLogin, gmailCallback, gmailScanStatus, gmailEvalStatus } from './routes/gmail';
import { evalUploadPage, evalUploadHandler, evalResultPage, evalStatus } from './routes/eval';
import { adminListTemplates, adminTemplateStatus } from './routes/adminTemplates';
import { adminRateLimitStatus } from './routes/adminRateLimit';
import { adminListNotifications } from './routes/adminNotifications';
import { createSwitchRoute } from './routes/switch';
import { purgeNotificationAudit } from './models/notificationAudit';
import { pollAllUsers } from './services/emailPoller';
import { refreshPlans, isEiep14aEnabled, type EnvWithPlans } from './services/eiep14a';
import { scrapePowerswitchPlans, isPowerswitchEnabled, type EnvWithPowerswitch } from './services/powerswitchScraper';
import { handleParseJob, ParseError } from './services/billParser';
import { updateBillFailed } from './models/bills';
import { runComparison } from './services/planComparator';
import { consumePlanDiffs, type PlanDiffConsumerEnv } from './services/planDiffConsumer';
import { evaluateAndNotify } from './services/notificationEngine';
import { purgeOldLLMAudit } from './services/llmAudit';
import { runFreeTierCheckin, type FreeTierCheckinEnv } from './services/freeTierCheckin';
import { runFixedTermExpiryScan, type FixedTermExpiryEnv } from './services/fixedTermExpiry';
import { runSwitchSanityCheck, type SwitchSanityEnv } from './services/switchTracker';

const app = new Hono();

// Global error boundary (MUST be first)
app.use('*', errorHandler);

// Health endpoint (no auth, no rate limit)
app.get('/', (c) => {
  return c.json({
    status: 'ok',
    service: 'flip-api',
    version: '0.1.0',
  });
});

// Also support /health path
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'flip-api',
    version: '0.1.0',
  });
});

// Messaging webhook (with auth + rate limit)
app.post(
  '/webhook/messaging',
  sentAuth,
  rateLimit({ userLimit: 100, globalLimit: 1000, windowMs: 60_000 }),
  messagingWebhook
);

// Gmail OAuth routes (test-only — no auth required, browser-facing)
app.get('/auth/gmail', gmailConnectPage);
app.get('/auth/gmail/', gmailConnectPage);
app.post('/auth/gmail/login', gmailLogin);
app.get('/auth/gmail/callback', gmailCallback);
app.get('/auth/gmail/scan-status', gmailScanStatus);
app.get('/auth/gmail/eval-status', gmailEvalStatus);

// Web evaluation routes (browser-facing, no Sent auth required)
app.get('/eval', evalUploadPage);
app.get('/eval/', evalUploadPage);
app.post('/eval/upload', evalUploadHandler); // inline rate limiter with HTML error page
app.get('/eval/result', rateLimit({ userLimit: 30, globalLimit: 300, windowMs: 60_000 }), evalResultPage);
app.get('/eval/status', rateLimit({ userLimit: 30, globalLimit: 300, windowMs: 60_000 }), evalStatus);

// Issue #130 — switch request API. Creates a switch for a user + target plan,
// rejecting duplicates (active switch for same user+plan). rateLimit mirrors
// the /eval user-facing routes (no user-session/JWT in the repo yet).
app.post(
  '/api/switch',
  rateLimit({ userLimit: 30, globalLimit: 300, windowMs: 60_000 }),
  createSwitchRoute
);

// Admin auth — gates EVERY /admin/* route behind ADMIN_API_KEY Bearer auth.
// Registered BEFORE the specific admin routes so the middleware runs first
// for all of them, including the /admin/* 501 catch-all. Non-admin paths
// (/, /health, /webhook/*, /auth/*, /eval*) are unaffected by the matcher.
app.use('/admin/*', adminAuth);

// Epic 2 #24-29: admin template status (registered before the /admin/* 501
// catch-all so Hono's first-match routing resolves these).
app.get('/admin/templates', adminListTemplates);
app.get('/admin/templates/status', adminTemplateStatus);

// Issue #37 AC #4: admin visibility into per-user rate-limit state.
// Registered before the /admin/* catch-all.  Auth-gated via ADMIN_API_KEY.
app.get('/admin/rate-limit/:userKey', adminRateLimitStatus);

// Issue #82 (Epic #8): notification compliance audit trail. Registered before
// the /admin/* catch-all. Auth-gated via ADMIN_API_KEY (adminAuth middleware).
app.get('/admin/notifications', adminListNotifications);

// Epic 1 issue #17 — 501 stubs for unimplemented webhook + admin surfaces.
// Placed after specific routes so Hono's first-match routing resolves
// /webhook/messaging, /admin/plans/*, /admin/scrape-powerswitch before falling
// through to the catch-alls.
const notImplemented = (_c: Context): Response => {
  return new Response(
    JSON.stringify({
      error: 'Not implemented',
      code: 'not_implemented',
      status: 501,
    }),
    {
      status: 501,
      headers: { 'Content-Type': 'application/json' },
    }
  );
};

app.post('/webhook/stripe', notImplemented);
app.get('/webhook/email/*', notImplemented);
app.get('/admin/*', notImplemented);

// Queue consumer router — dispatches to the correct handler by queue name
async function queue(
  batch: MessageBatch<Record<string, unknown>>,
  env: Record<string, unknown>,
  _ctx: ExecutionContext
): Promise<void> {
  const queueName = batch.queue;

  for (const message of batch.messages) {
    try {
      if (queueName === 'flip-parse-queue') {
        const body = message.body as { billId: string; r2Key: string; userId?: string };
        await handleParseJob(body.billId, body.r2Key, {
          DB: env.DB as D1Database,
          BILLS: env.BILLS as R2Bucket,
          COMPARE_QUEUE: env.COMPARE_QUEUE as Queue<{ user_id: string; bill_id: string; parsed_at: string }>,
          SENT_API_KEY: env.SENT_API_KEY as string,
          ENCRYPTION_KEY: env.ENCRYPTION_KEY as string,
          PYTHON_SERVICE_URL: env.PYTHON_SERVICE_URL as string | undefined,
          PYTHON_SERVICE_AUTH_TOKEN: env.PYTHON_SERVICE_AUTH_TOKEN as string | undefined,
        });
        message.ack();
      } else if (queueName === 'flip-compare-queue') {
        // Issue #43: message shape is { user_id, bill_id, parsed_at } (snake_case).
        const body = message.body as { user_id: string; bill_id: string; parsed_at?: string };
        await runComparison(body.user_id, {
          DB: env.DB as D1Database,
          NOTIFY_QUEUE: env.NOTIFY_QUEUE as Queue<{ userId: string; comparisonId: string }>,
          SENT_API_KEY: env.SENT_API_KEY as string,
          PYTHON_SERVICE_URL: env.PYTHON_SERVICE_URL as string | undefined,
          PYTHON_SERVICE_AUTH_TOKEN: env.PYTHON_SERVICE_AUTH_TOKEN as string | undefined,
        });
        message.ack();
      } else if (queueName === 'flip-notify-queue') {
        const body = message.body as { userId: string; comparisonId: string };
        await evaluateAndNotify(body.userId, body.comparisonId, {
          DB: env.DB as D1Database,
          KV: env.KV as KVNamespace,
          SENT_API_KEY: env.SENT_API_KEY as string,
          ENCRYPTION_KEY: env.ENCRYPTION_KEY as string,
          DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY as string | undefined,
        });
        message.ack();
      } else {
        console.log(JSON.stringify({
          type: 'queue_unknown',
          queueName,
          timestamp: new Date().toISOString(),
        }));
        message.ack();
      }
    } catch (error) {
      // Issue #39: parse-queue retry/DLQ policy.
      // - ParseError carries `transient` (5xx/network/timeout → retry) vs
      //   terminal (4xx, extract_failed, no_media → fail immediately).
      // - Transient: retry with exponential backoff until max attempts, then
      //   mark the bill failed + ack (the platform DLQ is the safety net).
      // - Terminal: mark the bill failed + ack immediately. No retry.
      // - Unknown non-ParseError: treat as transient (retain prior behaviour).
      if (queueName === 'flip-parse-queue') {
        const body = message.body as { billId?: string };
        const billId = body?.billId;
        const isParseError = error instanceof ParseError;
        const transient = !isParseError || error.transient;
        const errorCode = isParseError ? error.errorCode : 'unknown_error';

        if (transient && message.attempts < MAX_PARSE_ATTEMPTS) {
          console.log(JSON.stringify({
            type: 'parse_queue_retry',
            queueName,
            billId,
            errorCode,
            attempts: message.attempts,
            timestamp: new Date().toISOString(),
          }));
          message.retry({ delaySeconds: parseBackoffSeconds(message.attempts) });
          continue;
        }

        // Retries exhausted OR terminal error — persist failure, ack.
        if (billId) {
          try {
            await updateBillFailed(env.DB as D1Database, billId, errorCode);
          } catch (dbErr) {
            console.log(JSON.stringify({
              type: 'parse_queue_fail_write_error',
              billId,
              error: dbErr instanceof Error ? dbErr.message : 'unknown',
              timestamp: new Date().toISOString(),
            }));
          }
        }
        console.log(JSON.stringify({
          type: 'parse_queue_failed',
          queueName,
          billId,
          errorCode,
          terminal: !transient,
          attempts: message.attempts,
          timestamp: new Date().toISOString(),
        }));
        message.ack();
        continue;
      }

      // Issue #70: compare-queue retry/DLQ policy. Mirrors the parse-queue
      // pattern. No terminal/transient distinction here (the comparator does
      // not throw a classified error type), so every error is retryable until
      // MAX_COMPARE_ATTEMPTS is exhausted, then ack (platform DLQ is the
      // safety net). Compare jobs have no bill-row failure state to persist,
      // so unlike parse there is no DB write on exhaustion.
      if (queueName === 'flip-compare-queue') {
        const body = message.body as { user_id?: string; bill_id?: string };
        const errorMessage = error instanceof Error ? error.message : 'unknown';

        if (message.attempts < MAX_COMPARE_ATTEMPTS) {
          console.log(JSON.stringify({
            type: 'compare_queue_retry',
            queueName,
            userId: body?.user_id,
            billId: body?.bill_id,
            error: errorMessage,
            attempts: message.attempts,
            timestamp: new Date().toISOString(),
          }));
          message.retry({ delaySeconds: compareBackoffSeconds(message.attempts) });
          continue;
        }

        console.log(JSON.stringify({
          type: 'compare_queue_failed',
          queueName,
          userId: body?.user_id,
          billId: body?.bill_id,
          error: errorMessage,
          attempts: message.attempts,
          timestamp: new Date().toISOString(),
        }));
        message.ack();
        continue;
      }

      console.log(JSON.stringify({
        type: 'queue_error',
        queueName,
        error: error instanceof Error ? error.message : 'unknown',
        timestamp: new Date().toISOString(),
      }));
      message.ack(); // ack to avoid infinite retry loop
    }
  }
}

// Issue #39: 3 attempts with exponential backoff (30s, 60s) before DLQ/fail.
const MAX_PARSE_ATTEMPTS = 3;

function parseBackoffSeconds(attempts: number): number {
  // attempts is 1-based on first delivery. 30s then 60s.
  return 30 * attempts;
}

// Issue #70: same retry shape as parse — 3 attempts, 30s then 60s backoff.
const MAX_COMPARE_ATTEMPTS = 3;

function compareBackoffSeconds(attempts: number): number {
  // attempts is 1-based on first delivery. 30s then 60s.
  return 30 * attempts;
}

// Cron trigger handler
async function scheduled(
  controller: ScheduledController,
  env: Record<string, unknown>
): Promise<void> {
  const cron = controller.cron;

  // 0 3 * * * — Plan ingestion from EIEP14A feed (daily at 03:00 UTC).
  // #64: ships INERT behind EIF_EIEP14A_ENABLED (defaults false); flips live
  // in October when the EA EIEP14A feed becomes available.
  if (cron.includes('3')) {
    const plansEnv = env as unknown as EnvWithPlans;
    if (isEiep14aEnabled(plansEnv)) {
      await refreshPlans(plansEnv);
    } else {
      console.log(JSON.stringify({
        type: 'eiep14a_skipped',
        reason: 'EIF_EIEP14A_ENABLED not "true"',
        timestamp: new Date().toISOString(),
      }));
    }
    // #66 — Temporary Powerswitch scraper bridge. Runs in the same 03:00 UTC
    // window. INERT behind POWERSWITCH_SCRAPER_ENABLED (defaults false). Sunset
    // when #64 EIEP14A feed covers the retailers (see docs/AI_RULES.md override).
    const psEnv = env as unknown as EnvWithPowerswitch;
    if (isPowerswitchEnabled(psEnv)) {
      await scrapePowerswitchPlans(psEnv);
    } else {
      console.log(JSON.stringify({
        type: 'powerswitch_skipped',
        reason: 'POWERSWITCH_SCRAPER_ENABLED not "true"',
        timestamp: new Date().toISOString(),
      }));
    }
    // #36 — daily 30-day purge of LLM audit metadata.
    await purgeOldLLMAudit(env.DB as D1Database, 30);
    // #82 — daily 90-day purge of notification audit rows. Same 03:00 UTC slot
    // as the LLM-audit purge (both are daily compliance purges; reusing the
    // slot keeps the cron list from growing). Safe + idempotent.
    await purgeNotificationAudit(env.DB as D1Database, 90);
    return;
  }

  // 0 6 * * * — First daily Gmail email polling (06:00 UTC)
  if (cron.includes('6')) {
    await pollAllUsers(env as {
      DB: D1Database;
      KV: KVNamespace;
      BILLS: R2Bucket;
      PARSE_QUEUE: Queue<{ billId: string; r2Key: string; userId: string }>;
      GMAIL_CLIENT_ID: string;
      GMAIL_CLIENT_SECRET: string;
      ENCRYPTION_KEY: string;
    });
    return;
  }

  // 0 14 * * * — Second daily Gmail email polling (14:00 UTC)
  if (cron.includes('14')) {
    await pollAllUsers(env as {
      DB: D1Database;
      KV: KVNamespace;
      BILLS: R2Bucket;
      PARSE_QUEUE: Queue<{ billId: string; r2Key: string; userId: string }>;
      GMAIL_CLIENT_ID: string;
      GMAIL_CLIENT_SECRET: string;
      ENCRYPTION_KEY: string;
    });
    return;
  }

  // 0 8 * * * — Daily re-compare sanity check (issue #75). Scans the
  // `plans:diff:{retailer_id}` KV keys written by plan ingestion (EIEP14A/
  // powerswitch) and enqueues affected users to COMPARE_QUEUE. INERT-by-nature:
  // no-op when no diff keys are present. 7-day per-user dedup via KV.
  if (cron.includes('8')) {
    await consumePlanDiffs(env as unknown as PlanDiffConsumerEnv);

    // Issue #78 — free-tier monthly check-in. Runs in the same 08:00 UTC slot
    // with a day-of-month guard (1st of each month) so no new wrangler cron
    // slot is consumed (ponytail: daily slot + guard beats a monthly cron that
    // would collide with the `cron.includes('3')` matcher). Per-user KV dedup
    // (`free_tier_checkin:{userId}`, 28d) is the backstop if this fires twice.
    if (new Date().getUTCDate() === 1) {
      await runFreeTierCheckin(env as unknown as FreeTierCheckinEnv);
    }

    // Issue #79 — fixed-term expiry notifications (60/30/7-day windows). Daily
    // in the same 08:00 UTC slot. No collision: planDiffConsumer is inert
    // without KV diff keys, #78 is day-1 guarded, and this scan's KV dedup
    // (`fixed_term_expiry:{userId}:{expiry}:{window}`, 30d) caps each window
    // to one notification per expiry. No new wrangler cron slot consumed.
    await runFixedTermExpiryScan(env as unknown as FixedTermExpiryEnv);

    // Issue #81 — switch sanity cron. Daily in the same 08:00 UTC slot. Scans
    // for switches stuck `in_progress` >7 days (no retailer webhook
    // confirmation) and fails them via failSwitch (which fires the #132 ops
    // email) + notifies the user. No collision with the other 08:00 jobs:
    // planDiffConsumer is inert without KV keys, #78 is day-1 guarded, #79 is
    // KV-deduped, and this scan is gated by the stuck-age threshold. No new
    // wrangler cron slot consumed.
    await runSwitchSanityCheck(env as unknown as SwitchSanityEnv);
    return;
  }

  console.log(JSON.stringify({
    type: 'cron_tick',
    cron: controller.cron,
    note: 'unrecognised cron schedule',
    timestamp: new Date().toISOString(),
  }));
}

export default {
  fetch: app.fetch,
  queue,
  scheduled,
};
