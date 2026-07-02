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
import { pollAllUsers } from './services/emailPoller';
import { refreshPlans } from './services/planIngestion';
import { handleParseJob, ParseError } from './services/billParser';
import { updateBillFailed } from './models/bills';
import { runComparison } from './services/planComparator';
import { evaluateAndNotify } from './services/notificationEngine';
import { purgeOldLLMAudit } from './services/llmAudit';

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
          COMPARE_QUEUE: env.COMPARE_QUEUE as Queue<{ userId: string; billId: string }>,
          SENT_API_KEY: env.SENT_API_KEY as string,
          ENCRYPTION_KEY: env.ENCRYPTION_KEY as string,
          PYTHON_SERVICE_URL: env.PYTHON_SERVICE_URL as string | undefined,
          PYTHON_SERVICE_AUTH_TOKEN: env.PYTHON_SERVICE_AUTH_TOKEN as string | undefined,
        });
        message.ack();
      } else if (queueName === 'flip-compare-queue') {
        const body = message.body as { userId: string; billId: string };
        await runComparison(body.userId, {
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

// Cron trigger handler
async function scheduled(
  controller: ScheduledController,
  env: Record<string, unknown>
): Promise<void> {
  const cron = controller.cron;

  // 0 3 * * * — Plan ingestion from EIEP14A feed (daily at 03:00 UTC)
  if (cron.includes('3')) {
    await refreshPlans(env as {
      DB: D1Database;
      KV: KVNamespace;
      PYTHON_SERVICE_URL?: string;
      EIEP14A_API_KEY?: string;
    });
    // #36 — daily 30-day purge of LLM audit metadata.
    await purgeOldLLMAudit(env.DB as D1Database, 30);
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
