import type { Context } from 'hono';
import { classifyIntent } from '../services/deepseek';
import { transition, handleNewUser, getWelcomeMessage } from '../services/conversation';
import { sendAndLog, downloadMedia } from '../services/messaging';
import { createUser, getUserByPhone, updateUserState } from '../models/users';
import { createBill, getBillBySourceMessageId } from '../models/bills';
import { detectRetailerBySender } from '../models/retailers';
import { createMessage } from '../models/messages';

interface SentWebhookPayload {
  readonly id: string;
  readonly from: string;
  readonly body?: string;
  readonly media?: {
    readonly url: string;
    readonly type: string;
  };
  readonly channel: 'whatsapp' | 'sms';
  readonly timestamp: string;
}

export async function messagingWebhook(c: Context): Promise<Response> {
  const apiKey = c.env.SENT_API_KEY as string;
  const deepseekKey = c.env.DEEPSEEK_API_KEY as string;
  const db = c.env.DB as D1Database;
  const kv = c.env.KV as KVNamespace;
  const billsBucket = c.env.BILLS as R2Bucket;
  const parseQueue = c.env.PARSE_QUEUE as Queue<{ billId: string; r2Key: string; userId: string }>;

  try {
    const payload = await c.req.json<SentWebhookPayload>();
    const { from: phone, body, media, channel, id: sentMessageId } = payload;
    // 1. Look up or create user
    let user = await getUserByPhone(db, c.env as { ENCRYPTION_KEY: string }, phone);

    if (!user) {
      // New user — register and welcome
      user = await createUser(db, c.env as { ENCRYPTION_KEY: string }, { phone });
      await handleNewUser(kv, user.id, phone);

      // Store inbound message
      await createMessage(db, c.env as { ENCRYPTION_KEY: string }, {
        userId: user.id,
        direction: 'inbound',
        channel,
        body: body ?? null,
        mediaUrl: media?.url ?? null,
        sentMessageId,
      });

      // Send welcome message
      const welcomeMsg = getWelcomeMessage();
      await sendAndLog(apiKey, db, c.env as { ENCRYPTION_KEY: string }, user.id, phone, welcomeMsg);

      return c.json({ status: 'ok' }, 200);
    }

    // 2. Store inbound message
    await createMessage(db, c.env as { ENCRYPTION_KEY: string }, {
      userId: user.id,
      direction: 'inbound',
      channel,
      body: body ?? null,
      mediaUrl: media?.url ?? null,
      sentMessageId,
    });

    // 3. Handle media (bill forwarding)
    if (media?.url) {
      // Idempotent dispatch (issue #38): a duplicate Sent redelivery for the
      // same message_id must not produce a second R2 put, bill row, or
      // PARSE_QUEUE enqueue. Bail out early if already processed.
      if (sentMessageId) {
        const existing = await getBillBySourceMessageId(db, sentMessageId);
        if (existing) {
          return c.json({ status: 'ok', duplicate: true }, 200);
        }
      }

      const ext = media.type === 'pdf' ? 'pdf' : 'jpg';
      const r2Key = `bills/${user.id}/${crypto.randomUUID()}.${ext}`;

      // Download media from Sent and store in R2 (R2 SSE-KMS is bucket-level
      // config per docs/DEPLOY.md, not a per-put option in the R2 JS API).
      const mediaBuffer = await downloadMedia(apiKey, media.url);
      await billsBucket.put(r2Key, mediaBuffer);

      // Create bill record. Detect retailer from the inbound sender number
      // when it matches a known retailer (issue #40); otherwise leave
      // retailer_id NULL so downstream logic prompts the user.
      const retailerHint = detectRetailerBySender(phone);
      const bill = await createBill(db, {
        userId: user.id,
        rawR2Key: r2Key,
        source: channel,
        sourceMessageId: sentMessageId,
        retailerId: retailerHint ?? undefined,
      });

      // Enqueue parse job
      await parseQueue.send({ billId: bill.id, r2Key, userId: user.id });

      // Acknowledge
      const confirmMsg = "Got your bill! I'll analyse it and get back to you shortly. This usually takes less than a minute.";
      await sendAndLog(apiKey, db, c.env as { ENCRYPTION_KEY: string }, user.id, phone, confirmMsg);

      return c.json({ status: 'ok' }, 200);
    }

    // 4. Handle text message via intent classification
    if (body) {
      // Quick 2-second acknowledgment
      const ackPromise = sendAndLog(apiKey, db, c.env as { ENCRYPTION_KEY: string }, user.id, phone, 'Got it, let me check...');

      // Classify intent
      const classification = await classifyIntent(body, deepseekKey);

      // Attempt transition (KV-backed state machine)
      const result = await transition(kv, user.id, classification.intent);

      // Sync state to D1 so admin/cron queries see correct state
      await updateUserState(db, user.id, result.to);

      // If transition didn't change state (invalid), send help
      const responseMsg = result.from === result.to && result.message.includes("can't")
        ? "Sorry, I can't do that right now. Type \"help\" to see what's available."
        : result.message;

      await ackPromise;
      await sendAndLog(apiKey, db, c.env as { ENCRYPTION_KEY: string }, user.id, phone, responseMsg);

      return c.json({ status: 'ok' }, 200);
    }

    // Empty message — send help
    await sendAndLog(apiKey, db, c.env as { ENCRYPTION_KEY: string }, user.id, phone, "I didn't catch that — type \"help\" to see what I can do.");
    return c.json({ status: 'ok' }, 200);
  } catch (err) {
    console.log(JSON.stringify({
      level: 'error',
      message: 'Messaging webhook error',
      error: (err as Error).message,
      timestamp: new Date().toISOString(),
    }));

    // Always return 200 to Sent (prevents retries)
    return c.json({ status: 'error', message: 'Internal error' }, 200);
  }
}
