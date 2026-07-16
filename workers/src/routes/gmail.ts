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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderProgressPage(userId: string, setupLog: string[], _isError = false, flowUrl?: string): string {
  const logsJson = JSON.stringify(setupLog);
  const traceLinkHtml = flowUrl
    ? `<p style="margin-top:8px;"><a href="${escapeHtml(flowUrl)}" style="display:inline-block;padding:10px 20px;background:#1e8e3e;color:#fff;border-radius:6px;text-decoration:none;font-weight:500;">Watch your pipeline live →</a></p>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Flip — Scanning Inbox</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 24px; background: #fafafa; }
    h1 { font-size: 1.25rem; margin-bottom: 4px; }
    .subtitle { color: #666; margin-bottom: 24px; font-size: 0.9rem; }
    .card { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 16px; }
    .log-entry { font-family: 'SF Mono', 'Consolas', monospace; font-size: 0.8rem; padding: 4px 0; color: #333; border-bottom: 1px solid #f5f5f5; }
    .log-entry.error { color: #d93025; }
    .log-entry.success { color: #1e8e3e; }
    .stat { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #f0f0f0; }
    .stat:last-child { border-bottom: none; }
    .stat-label { color: #666; }
    .stat-value { font-weight: 600; }
    .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #ccc; border-top-color: #1a73e8; border-radius: 50%; animation: spin 0.8s linear infinite; margin-right: 6px; vertical-align: middle; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .phase-badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 0.75rem; font-weight: 600; }
    .phase-badge.connecting { background: #fff3cd; color: #856404; }
    .phase-badge.searching { background: #cce5ff; color: #004085; }
    .phase-badge.scanning { background: #cce5ff; color: #004085; }
    .phase-badge.complete { background: #d4edda; color: #155724; }
    .sender-tag { display: inline-block; background: #f0f0f0; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; margin: 2px; font-family: monospace; }
    .error-msg { color: #d93025; font-size: 0.8rem; padding: 4px 0; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th { text-align: left; padding: 8px 6px; border-bottom: 2px solid #e0e0e0; color: #666; font-weight: 600; }
    th.num { text-align: right; }
    td { padding: 8px 6px; border-bottom: 1px solid #f0f0f0; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
    .retailer-sub { color: #888; font-size: 0.75rem; }
    .saving-positive { color: #1e8e3e; font-weight: 600; }
    .saving-neutral { color: #888; }
    .badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 0.7rem; font-weight: 600; white-space: nowrap; }
    .badge-stay { background: #d4edda; color: #155724; }
    .badge-switch { background: #fff3cd; color: #856404; }
    .row-stay { background: #f9fff9; }
  </style>
</head>
<body>
  <h1>Scanning your Gmail inbox</h1>
  <p class="subtitle">Searching for power bills from all NZ retailers over the past 12 months.</p>
  ${traceLinkHtml}

  <div class="card">
    <h3>Setup</h3>
    <div id="setup-logs"></div>
  </div>

  <div class="card">
    <h3>Scan Progress <span id="phase-badge" class="phase-badge connecting">connecting</span></h3>
    <div id="progress-stats">
      <div class="stat"><span class="stat-label">Messages found</span><span class="stat-value" id="stat-found">—</span></div>
      <div class="stat"><span class="stat-label">Scanned</span><span class="stat-value" id="stat-scanned">—</span></div>
      <div class="stat"><span class="stat-label">Bills discovered</span><span class="stat-value" id="stat-bills">—</span></div>
      <div class="stat"><span class="stat-label">Skipped (no bill subject)</span><span class="stat-value" id="stat-nosubject">—</span></div>
      <div class="stat"><span class="stat-label">Skipped (no PDF)</span><span class="stat-value" id="stat-nopdf">—</span></div>
      <div class="stat"><span class="stat-label">Status</span><span class="stat-value" id="stat-status"><span class="spinner"></span>Running...</span></div>
    </div>
  </div>

  <div class="card" id="bill-senders-card" style="display:none;">
    <h3>Bill Senders</h3>
    <div id="bill-senders-list"></div>
  </div>

  <div class="card" id="filtered-senders-card" style="display:none;">
    <h3 style="color:#888;">Filtered Out (matched search, excluded by subject/PDF checks)</h3>
    <div id="filtered-senders-list"></div>
  </div>

  <div class="card" id="errors-card" style="display:none;">
    <h3>Errors</h3>
    <div id="errors-list"></div>
  </div>

  <div class="card" id="eval-card" style="display:none;">
    <h3>Plan Comparison</h3>
    <div id="eval-status-line"><span class="spinner"></span>Analysing your bills...</div>
    <div id="eval-results" style="display:none;"></div>
  </div>

  <script>
    var userId = '${escapeHtml(userId)}';
    var setupLogs = ${logsJson};
    var pollTimer;
    var evalTimer;
    var scanComplete = false;
    var evalDone = false;

    // Render setup logs
    var setupEl = document.getElementById('setup-logs');
    setupLogs.forEach(function(msg) {
      var div = document.createElement('div');
      div.className = 'log-entry' + (msg.toLowerCase().indexOf('error') !== -1 ? ' error' : '');
      div.textContent = msg;
      setupEl.appendChild(div);
    });

    function formatCents(c) {
      return (c / 100).toFixed(2);
    }

    function formatSavings(c) {
      if (c <= 0) return '$0';
      return '$' + Math.round(c / 100).toString();
    }

    function esc(s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function renderComparison(data) {
      if (evalDone) return;
      evalDone = true;
      clearInterval(evalTimer);

      var card = document.getElementById('eval-card');
      card.style.display = '';

      if (!data || !data.found || !data.parsedData || !data.comparisons || !data.comparisons.length) {
        document.getElementById('eval-status-line').innerHTML = data && data.pending
          ? '<span class="spinner"></span>Bills are still being processed. Check back soon.'
          : "No comparisons available yet. We'll text you when your results are ready.";
        return;
      }

      document.getElementById('eval-status-line').style.display = 'none';

      var pd = data.parsedData;
      var billFields = [
        ['Retailer', String(pd.retailer_name || pd.retailer || '—')],
        ['Plan', String(pd.plan_name || '—')],
        ['Period', pd.period_start && pd.period_end ? pd.period_start + ' — ' + pd.period_end : '—'],
        ['Days', pd.days != null ? String(pd.days) : '—'],
        ['Usage', pd.usage_kwh != null ? pd.usage_kwh + ' kWh' : '—'],
        ['Total cost', pd.total_cents != null ? '$' + formatCents(Number(pd.total_cents)) : '—'],
        ['Meter type', String(pd.meter_type || '—')],
        ['Parse confidence', pd.confidence != null ? Math.round(Number(pd.confidence) * 100) + '%' : '—']
      ];

      var billRows = billFields.map(function(f) {
        return '<div class="stat"><span class="stat-label">' + esc(f[0]) + '</span><span class="stat-value">' + esc(f[1]) + '</span></div>';
      }).join('');

      var compRows = data.comparisons.map(function(c) {
        var planName = String(c.plan_name || '—');
        var retailer = String(c.retailer_name || c.retailer_id || '—');
        var projected = Number(c.projected_cost_cents || 0);
        var saving = Number(c.saving_cents || 0);
        var confidence = Number(c.confidence || 0);
        var stay = Boolean(c.stay_where_you_are);

        var savingClass = stay ? 'saving-neutral' : 'saving-positive';
        var badge = stay
          ? '<span class="badge badge-stay">Stay where you are</span>'
          : '<span class="badge badge-switch">Could save</span>';

        return '<tr class="' + (stay ? 'row-stay' : '') + '">'
          + '<td>' + esc(planName) + '<br><span class="retailer-sub">' + esc(retailer) + '</span></td>'
          + '<td class="num">$' + formatCents(projected) + '</td>'
          + '<td class="num ' + savingClass + '">' + (saving > 0 ? '$' + formatSavings(saving) : '$0') + '</td>'
          + '<td class="num">' + Math.round(confidence * 100) + '%</td>'
          + '<td>' + badge + '</td>'
          + '</tr>';
      }).join('');

      var html = '<div style="margin-top:16px;"><h4 style="margin-bottom:8px;font-size:0.9rem;">Parsed Bill</h4>'
        + '<div style="margin-bottom:16px;">' + billRows + '</div>'
        + '<h4 style="margin-bottom:8px;font-size:0.9rem;">Plan Comparison</h4>'
        + '<table><thead><tr>'
        + '<th>Plan</th><th class="num">Projected / year</th><th class="num">Savings / year</th><th class="num">Confidence</th><th>Recommendation</th>'
        + '</tr></thead><tbody>' + compRows + '</tbody></table></div>';

      document.getElementById('eval-results').innerHTML = html;
      document.getElementById('eval-results').style.display = '';
    }

    // Comparison polling runs until real results land (bills parse through the
    // queue for a minute or two after the scan), narrating parse progress, and
    // only gives up after ~5 minutes — the earlier code rendered its terminal
    // "no comparisons" message on the FIRST empty response (#242 live run).
    var evalAttempts = 0;
    var EVAL_MAX_ATTEMPTS = 150; // x 2s = 5 minutes
    function pollEvalStatus() {
      evalAttempts++;
      fetch('/auth/gmail/eval-status?userId=' + encodeURIComponent(userId))
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data && data.found) {
            renderComparison(data);
            return;
          }
          if (evalAttempts >= EVAL_MAX_ATTEMPTS) {
            evalDone = true;
            clearInterval(evalTimer);
            document.getElementById('eval-status-line').textContent =
              "Still working on your comparison. We'll text you when your results are ready.";
            return;
          }
          // Pending — narrate parse progress while the queue works.
          var line = document.getElementById('eval-status-line');
          if (data && data.pending && typeof data.billsParsed === 'number' && data.billsTotal > 0) {
            line.innerHTML = '<span class="spinner"></span>Parsing your bills (' + data.billsParsed + '/' + data.billsTotal + ')… comparison runs as soon as one is ready.';
          } else {
            line.innerHTML = '<span class="spinner"></span>Analysing your bills…';
          }
        })
        .catch(function() { /* retry */ });
    }

    function updateProgress(data) {
      var badge = document.getElementById('phase-badge');
      badge.textContent = data.phase;
      badge.className = 'phase-badge ' + data.phase;

      document.getElementById('stat-found').textContent = data.messagesFound;
      document.getElementById('stat-scanned').textContent = data.messagesScanned;
      document.getElementById('stat-bills').textContent = data.billsFound;
      document.getElementById('stat-nosubject').textContent = data.messagesSkippedNoSubject;
      document.getElementById('stat-nopdf').textContent = data.messagesSkippedNoPdf;

      if (data.complete) {
        document.getElementById('stat-status').innerHTML = 'Done' + (data.finishedAt ? ' at ' + new Date(data.finishedAt).toLocaleTimeString() : '');
        clearInterval(pollTimer);

        if (!scanComplete) {
          scanComplete = true;
          document.getElementById('eval-card').style.display = '';
          pollEvalStatus();
          evalTimer = setInterval(pollEvalStatus, 2000);
        }
      }

      // Bill senders
      if (data.billSenders && data.billSenders.length > 0) {
        document.getElementById('bill-senders-card').style.display = '';
        var billList = document.getElementById('bill-senders-list');
        billList.innerHTML = data.billSenders.map(function(s) {
          return '<span class="sender-tag">' + s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</span>';
        }).join('');
      }

      // Filtered senders
      if (data.filteredSenders && data.filteredSenders.length > 0) {
        document.getElementById('filtered-senders-card').style.display = '';
        var filteredList = document.getElementById('filtered-senders-list');
        filteredList.innerHTML = data.filteredSenders.map(function(s) {
          return '<span class="sender-tag" style="background:#fff3cd;">' + s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</span>';
        }).join('');
      }

      // Errors
      if (data.errors && data.errors.length > 0) {
        document.getElementById('errors-card').style.display = '';
        var list = document.getElementById('errors-list');
        list.innerHTML = data.errors.map(function(e) {
          return '<div class="error-msg">' + e.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</div>';
        }).join('');
      }
    }

    function pollStatus() {
      fetch('/auth/gmail/scan-status?userId=' + encodeURIComponent(userId))
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.error) return;
          updateProgress(data);
        })
        .catch(function() { /* retry on next poll */ });
    }

    // Poll every 1.5 seconds
    pollStatus();
    pollTimer = setInterval(pollStatus, 1500);
  </script>
</body>
</html>`;
}
