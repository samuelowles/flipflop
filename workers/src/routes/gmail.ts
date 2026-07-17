import type { Context } from 'hono';
import { buildAuthUrl, parseOAuthState, exchangeCodeForTokens } from '../services/gmailAuth';
import { storeOAuthTokens, getOAuthTokens } from '../models/oauth';
import { findOrCreateByPhone } from '../models/users';
import { pollSingleUser, readScanProgress } from '../services/emailPoller';
import type { GmailPollingEnv } from '../services/emailPoller';
import { sendText } from '../services/messaging';
import { runEvalComparison } from './eval';
import { startStage, finishStage, failStage } from '../services/flowTrace';
import { mintFlowLink } from '../services/flowLink';
import { escapeHtml, renderProgressPage } from './gmailProgressPage';

const NONCE_KV_PREFIX = 'oauth:nonce:';
const NONCE_TTL = 600; // 10 minutes
const NZ_MOBILE_REGEX = /^\+64\d{7,11}$/;

function generateNonce(): string {
  return crypto.randomUUID();
}

// Connect page with phone number input
export async function gmailConnectPage(c: Context): Promise<Response> {
  const error = c.req.query('error');
  const errorHtml = error
    ? `<p class="error">${escapeHtml(error === 'invalid_phone' ? 'Please enter a valid NZ mobile number (e.g. +64211234567).' : 'This phone number is already linked to a Gmail account.' )}</p>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Flip — Connect Gmail</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 24px; }
    h1 { font-size: 1.5rem; margin-bottom: 8px; }
    p { color: #555; margin-bottom: 16px; }
    label { display: block; font-weight: 500; margin-bottom: 6px; }
    input[type="tel"] { width: 100%; padding: 10px 12px; font-size: 1rem; border: 1px solid #ccc; border-radius: 6px; margin-bottom: 20px; box-sizing: border-box; }
    input[type="tel"]:focus { border-color: #1a73e8; outline: none; box-shadow: 0 0 0 2px rgba(26,115,232,0.2); }
    .btn { display: inline-block; padding: 12px 24px; background: #1a73e8; color: #fff; border: none; border-radius: 6px; font-weight: 500; font-size: 1rem; cursor: pointer; }
    .btn:hover { background: #1557b0; }
    .error { color: #d93025; background: #fce8e6; padding: 10px 14px; border-radius: 6px; margin-bottom: 20px; }
  </style>
</head>
<body>
  <h1>Connect your Gmail</h1>
  <p>Flip reads power bill emails so you don&#39;t have to forward them. We only search for bills from NZ power retailers — nothing else.</p>
  <p>Enter your mobile number and we&#39;ll text you when we find something.</p>
  ${errorHtml}
  <form method="POST" action="/auth/gmail/login">
    <label for="phone">NZ mobile number</label>
    <input type="tel" id="phone" name="phone" placeholder="+64211234567"
           pattern="^\\+64\\d{7,11}$" required />
    <button type="submit" class="btn">Connect Gmail</button>
  </form>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// Handle phone submission and redirect to Google OAuth
export async function gmailLogin(c: Context): Promise<Response> {
  const clientId = c.env.GMAIL_CLIENT_ID as string | undefined;
  if (!clientId) {
    return c.json({ error: 'Gmail integration not configured', code: 'not_configured' }, 500);
  }

  // Parse phone from form body
  let phone: string;
  try {
    const body = await c.req.parseBody();
    phone = (body['phone'] as string | undefined)?.trim() ?? '';
  } catch {
    return c.redirect('/auth/gmail?error=invalid_phone', 302);
  }

  // Validate NZ mobile format
  if (!NZ_MOBILE_REGEX.test(phone)) {
    return c.redirect('/auth/gmail?error=invalid_phone', 302);
  }

  const db = c.env.DB as D1Database;
  const encryptionKey = c.env.ENCRYPTION_KEY as string | undefined;
  if (!encryptionKey) {
    return c.json({ error: 'Encryption not configured', code: 'not_configured' }, 500);
  }

  // Find or create user by phone
  const { user, created } = await findOrCreateByPhone(db, { ENCRYPTION_KEY: encryptionKey }, phone);

  // Check if user already has Gmail connected
  const existingTokens = await getOAuthTokens(db, user.id, 'gmail');
  if (existingTokens) {
    return c.redirect('/auth/gmail?error=already_connected', 302);
  }

  const kv = c.env.KV as KVNamespace;
  const nonce = generateNonce();

  // Build redirect URI from the request
  const url = new URL(c.req.url);
  const redirectUri = `${url.protocol}//${url.host}/auth/gmail/callback`;

  // Store nonce → { userId, phone } in KV for CSRF validation on callback
  await kv.put(
    `${NONCE_KV_PREFIX}${nonce}`,
    JSON.stringify({ userId: user.id, phone }),
    { expirationTtl: NONCE_TTL }
  );

  const authUrl = buildAuthUrl({
    clientId,
    redirectUri,
    state: { userId: user.id, phone, nonce },
  });

  console.log(JSON.stringify({
    type: 'gmail_login',
    userId: user.id,
    created,
    timestamp: new Date().toISOString(),
    // phone intentionally not logged
  }));

  return c.redirect(authUrl, 302);
}

// Scan status endpoint — polled by the callback progress page
export async function gmailScanStatus(c: Context): Promise<Response> {
  const userId = c.req.query('userId');
  if (!userId) {
    return c.json({ error: 'Missing userId parameter' }, 400);
  }

  const kv = c.env.KV as KVNamespace;
  const progress = await readScanProgress(kv, userId);

  if (!progress) {
    return c.json({ error: 'No scan in progress' }, 404);
  }

  return c.json(progress);
}

// Eval/comparison status endpoint — polled by the callback progress page
// after scan completes, to show plan comparison results
export async function gmailEvalStatus(c: Context): Promise<Response> {
  const userId = c.req.query('userId');
  if (!userId) {
    return c.json({ error: 'Missing userId parameter' }, 400);
  }

  const kv = c.env.KV as KVNamespace;
  const cacheKey = `gmail:eval:${userId}`;

  // Return cached results if available — but only REAL results. Earlier code
  // cached empty found:true responses computed while bills were still queue-
  // parsing (found in the #242 deployed run: the callback page rendered
  // "no comparisons" seconds after scan and the empty answer stuck for 24h).
  // Empty/invalid cache entries are deleted so poisoned users self-heal.
  const cached = await kv.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as { found?: boolean; comparisons?: unknown[] };
      if (parsed.found && Array.isArray(parsed.comparisons) && parsed.comparisons.length > 0) {
        return c.json(parsed);
      }
    } catch {
      // fall through to recompute
    }
    await kv.delete(cacheKey);
  }

  const db = c.env.DB as D1Database;
  const pythonUrl = c.env.PYTHON_SERVICE_URL as string | undefined;
  const pythonAuthToken = c.env.PYTHON_SERVICE_AUTH_TOKEN as string | undefined;
  const encryptionKey = c.env.ENCRYPTION_KEY as string | undefined;

  if (!encryptionKey) {
    return c.json({ error: 'Encryption not configured' }, 500);
  }

  try {
    const result = await runEvalComparison(
      {
        DB: db,
        KV: kv,
        BILLS: c.env.BILLS as R2Bucket,
        ENCRYPTION_KEY: encryptionKey,
        PYTHON_SERVICE_URL: pythonUrl,
        PYTHON_SERVICE_AUTH_TOKEN: pythonAuthToken,
      },
      userId
    );

    // Bills still parsing (or none parsed/comparable yet) → PENDING, never
    // cached, with parse progress so the page can narrate ("Parsing 3/12…").
    if (!result.parsedData || result.comparisons.length === 0) {
      return c.json({
        found: false,
        pending: true,
        billsTotal: result.billsTotal,
        billsParsed: result.billsParsed,
      });
    }

    const body = {
      found: true,
      parsedData: result.parsedData,
      comparisons: result.comparisons,
      billsTotal: result.billsTotal,
      billsParsed: result.billsParsed,
    };

    // Cache REAL results for 24 hours
    await kv.put(cacheKey, JSON.stringify(body), { expirationTtl: 86400 });

    return c.json(body);
  } catch (err) {
    console.log(JSON.stringify({
      type: 'gmail_eval_error',
      userId,
      error: (err as Error).message,
      timestamp: new Date().toISOString(),
    }));

    return c.json({
      found: false,
      pending: true,
      error: 'Comparison not yet available. Bills may still be processing.',
      detail: (err as Error).message,
    });
  }
}

// Handle Google OAuth callback
export async function gmailCallback(c: Context): Promise<Response> {
  const clientId = c.env.GMAIL_CLIENT_ID as string | undefined;
  const clientSecret = c.env.GMAIL_CLIENT_SECRET as string | undefined;
  const encryptionKey = c.env.ENCRYPTION_KEY as string | undefined;

  if (!clientId || !clientSecret || !encryptionKey) {
    return c.json({ error: 'Gmail integration not configured', code: 'not_configured' }, 500);
  }

  const url = new URL(c.req.url);
  const code = url.searchParams.get('code');
  const stateStr = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  // User denied consent
  if (error) {
    return new Response('Connection cancelled. You can try again anytime.', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  if (!code || !stateStr) {
    return c.json({ error: 'Missing code or state parameter', code: 'invalid_request' }, 400);
  }

  // Validate state (CSRF protection)
  const parsedState = parseOAuthState(stateStr);
  if (parsedState instanceof Error) {
    return c.json({ error: parsedState.message, code: 'invalid_state' }, 400);
  }

  const kv = c.env.KV as KVNamespace;
  const storedJson = await kv.get(`${NONCE_KV_PREFIX}${parsedState.nonce}`);
  if (!storedJson) {
    return c.json({ error: 'Invalid or expired OAuth state', code: 'invalid_state' }, 400);
  }

  let stored: { userId: string; phone: string };
  try {
    stored = JSON.parse(storedJson);
  } catch {
    return c.json({ error: 'Invalid OAuth state data', code: 'invalid_state' }, 400);
  }

  if (stored.userId !== parsedState.userId) {
    return c.json({ error: 'OAuth state mismatch', code: 'invalid_state' }, 400);
  }

  // Clean up nonce (one-time use)
  await kv.delete(`${NONCE_KV_PREFIX}${parsedState.nonce}`);

  // Build redirect URI
  const redirectUri = `${url.protocol}//${url.host}/auth/gmail/callback`;

  // Issue #228 — seed the FlowTrace at the connect stage so the trace page can
  // poll from the moment the callback lands. Additive; no-ops on KV failure.
  await startStage(kv, stored.userId, 'connect');

  // Collect setup log entries for the progress page
  const setupLog: string[] = [];
  const log = (msg: string) => { setupLog.push(msg); };

  try {
    log('Exchanging authorization code for Gmail tokens...');
    const tokenResponse = await exchangeCodeForTokens({
      code,
      clientId,
      clientSecret,
      redirectUri,
    });

    const expiry = new Date(
      Date.now() + tokenResponse.expires_in * 1000
    ).toISOString();

    log('Tokens received. Storing...');
    const db = c.env.DB as D1Database;

    await storeOAuthTokens(db, { ENCRYPTION_KEY: encryptionKey }, {
      userId: stored.userId,
      provider: 'gmail',
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token ?? null,
      expiry,
    });
    log('Gmail connected. Starting inbox scan...');

    // Issue #228 — connect stage ok (OAuth tokens stored). Additive trace call;
    // no-ops if KV is unavailable (see services/flowTrace.ts invariant).
    await finishStage(kv, stored.userId, 'connect', {
      detail: 'OAuth tokens stored',
      artifacts: { provider: 'gmail' },
    });

    // Post-connect: confirmation message + immediate scan (runs async, progress in KV)
    const sentApiKey = c.env.SENT_API_KEY as string | undefined;
    if (sentApiKey && stored.phone) {
      const pollingEnv: GmailPollingEnv = {
        DB: db,
        KV: kv,
        BILLS: c.env.BILLS as R2Bucket,
        PARSE_QUEUE: c.env.PARSE_QUEUE as Queue<{ billId: string; r2Key: string; userId: string }>,
        GMAIL_CLIENT_ID: clientId,
        GMAIL_CLIENT_SECRET: clientSecret,
        ENCRYPTION_KEY: encryptionKey,
      };

      console.log(JSON.stringify({
        type: 'post_connect_start',
        userId: stored.userId,
        phone: stored.phone ? stored.phone.slice(-4) : 'none',
        timestamp: new Date().toISOString(),
      }));

      // Use waitUntil if available (Workers production), otherwise await directly (test/miniflare)
      let ctx: { waitUntil(p: Promise<unknown>): void } | null = null;
      try {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const ec = c.executionCtx;
        ctx = ec as unknown as { waitUntil(p: Promise<unknown>): void };
      } catch {
        // Miniflare test env — executionCtx access throws
      }
      if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(
          doPostConnectFlow(pollingEnv, stored.userId, stored.phone, sentApiKey)
        );
      } else {
        await doPostConnectFlow(pollingEnv, stored.userId, stored.phone, sentApiKey);
      }
    }

    // Issue #241 — mint a signed /flow/status link so the user can watch the
    // pipeline live in a browser (no Bearer header needed).
    const flowUrl = await mintFlowLink(encryptionKey, stored.userId);

    // Return progress page that polls /auth/gmail/scan-status and /auth/gmail/eval-status
    return new Response(renderProgressPage(stored.userId, setupLog, false, flowUrl), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  } catch (err) {
    const errMsg = (err as Error).message;
    log(`Error: ${errMsg}`);
    console.log(JSON.stringify({
      level: 'error',
      type: 'gmail_callback_error',
      error: errMsg,
      timestamp: new Date().toISOString(),
    }));
    return new Response(renderProgressPage(stored.userId, setupLog, true), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

// Post-connect async flow: send confirmation, scan inbox, send results
async function doPostConnectFlow(
  pollingEnv: GmailPollingEnv,
  userId: string,
  phone: string,
  sentApiKey: string
): Promise<void> {
  console.log(JSON.stringify({
    type: 'post_connect_flow_begin',
    userId,
    timestamp: new Date().toISOString(),
  }));

  // 1. Send confirmation message (non-blocking — scan proceeds regardless)
  try {
    await sendText(
      sentApiKey,
      phone,
      "Cheers! Flip's hooked up to your Gmail. Having a quick squiz for any power bills now — back in a tick."
    );
  } catch (msgErr) {
    console.log(JSON.stringify({
      level: 'warn',
      type: 'post_connect_confirmation_failed',
      userId,
      error: (msgErr as Error).message,
      timestamp: new Date().toISOString(),
    }));
  }

  // 2. Scan the user's Gmail inbox (always runs — progress written to KV by pollSingleUser)
  await startStage(pollingEnv.KV, userId, 'scan');
  let billsFound = 0;
  let scanErrors: readonly string[] = [];
  try {
    const result = await pollSingleUser(pollingEnv, userId);
    billsFound = result.billsFound;
    scanErrors = result.errors;
    // Issue #228 — scan stage ok (additive trace; no-op on KV failure).
    await finishStage(pollingEnv.KV, userId, 'scan', {
      detail: `${billsFound} bill(s) found, ${scanErrors.length} error(s)`,
      artifacts: { billsFound: String(billsFound) },
    });
    console.log(JSON.stringify({
      type: 'post_connect_scan_complete',
      userId,
      billsFound,
      errorCount: scanErrors.length,
      timestamp: new Date().toISOString(),
    }));
  } catch (scanErr) {
    scanErrors = [(scanErr as Error).message];
    await failStage(pollingEnv.KV, userId, 'scan', (scanErr as Error).message);
    console.log(JSON.stringify({
      level: 'error',
      type: 'post_connect_scan_failed',
      userId,
      error: (scanErr as Error).message,
      timestamp: new Date().toISOString(),
    }));
  }

  // 3. Send result message (best-effort)
  try {
    if (billsFound > 0) {
      await sendText(
        sentApiKey,
        phone,
        `Found ${billsFound} bill(s) in your inbox. We'll keep an eye out daily. If you're on a dud plan, we'll let you know.`
      );
    } else if (scanErrors.length > 0) {
      await sendText(
        sentApiKey,
        phone,
        "Had a bit of trouble checking your inbox just now. No worries — we'll try again at 6am. Nothing needed from you."
      );
    } else {
      await sendText(
        sentApiKey,
        phone,
        "Didn't spot any power bills in your inbox just yet. No worries — Flip checks daily, so we'll catch the next one. Keen to help if you flick us a message."
      );
    }
  } catch (resultMsgErr) {
    console.log(JSON.stringify({
      level: 'warn',
      type: 'post_connect_result_message_failed',
      userId,
      error: (resultMsgErr as Error).message,
      timestamp: new Date().toISOString(),
    }));
  }
}
