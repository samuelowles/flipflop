/**
 * Issue #228 / #241 — FlowTrace observation routes (Epic 13 DoD).
 *
 *   GET /flow/status?u=…&exp=…&sig=…    — server-rendered HTML trace page.
 *   GET /flow/status.json?u=…&exp=…&sig=… — JSON the page polls every 2s.
 *
 * Auth: EITHER a valid signed-link triple (mintFlowLink/verifyFlowLink) OR the
 * existing admin Bearer header (ADMIN_API_KEY). The standalone adminAuth
 * middleware was REMOVED from these routes (#241) so a browser can load the
 * page without a manual Authorization header. The `phone` query-param path was
 * removed (phone → userId enumeration surface); admins mint a signed link via
 * GET /admin/flow-link?phone=… instead.
 *
 * The page is one HTML string (no SPA/framework), mirroring the existing
 * /auth/gmail/scan-status pattern. Each stage = a row: name, status icon,
 * duration, detail sentence, error verbatim, artifact links.
 */

import type { Context } from 'hono';
import { getUserByPhone } from '../models/users';
import { readFlowTrace } from '../services/flowTrace';
import { verifyFlowLink, mintFlowLink } from '../services/flowLink';
import { timingSafeEqual } from '../middleware/adminAuth';
import type { FlowStage, FlowStageStatus } from '../types/flowTrace';

interface FlowRouteEnv {
  readonly DB: D1Database;
  readonly KV: KVNamespace;
  readonly ENCRYPTION_KEY: string;
  readonly ADMIN_API_KEY?: string;
}

/** Signed-link query params extracted from the request. */
interface SignedParams {
  readonly u: string | undefined;
  readonly exp: string | undefined;
  readonly sig: string | undefined;
}

function readSignedParams(c: Context): SignedParams {
  return {
    u: c.req.query('u') ?? undefined,
    exp: c.req.query('exp') ?? undefined,
    sig: c.req.query('sig') ?? undefined,
  };
}

/**
 * Authorize the request: valid signed-link triple OR admin Bearer header.
 * Returns the authorized userId, or a Response (400/401/500) to return.
 * Rejects the removed `phone` param (400) and requires ?u= for admin Bearer.
 */
async function authorize(
  c: Context
): Promise<{ userId: string } | { response: Response }> {
  // #241: phone param is no longer accepted on /flow/* (enumeration surface).
  if (c.req.query('phone') !== undefined) {
    return { response: c.json({ error: 'The phone param is no longer accepted; use a signed link (/admin/flow-link).', code: 'phone_removed' }, 400) };
  }

  const env = c.env as FlowRouteEnv;
  if (!env.ENCRYPTION_KEY) {
    return { response: c.json({ error: 'Encryption not configured' }, 500) };
  }

  const { u, exp, sig } = readSignedParams(c);

  // Path 1: admin Bearer header. Checked first so an admin with ?u= but no
  // signed-link params still gets through. Requires ?u= for the trace target.
  const authHeader = c.req.header('Authorization') ?? '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : '';
  if (env.ADMIN_API_KEY && provided && timingSafeEqual(provided, env.ADMIN_API_KEY)) {
    if (u) return { userId: u };
    return { response: c.json({ error: 'Admin Bearer requires a ?u=<userId> param on /flow/*', code: 'missing_user' }, 400) };
  }

  // Path 2: signed-link triple (the browser path — no Bearer header).
  if (u !== undefined || exp !== undefined || sig !== undefined) {
    if (await verifyFlowLink(env.ENCRYPTION_KEY, u, exp, sig)) {
      return { userId: u! };
    }
    return { response: c.json({ error: 'Invalid or expired signed link', code: 'unauthorized' }, 401) };
  }

  return { response: c.json({ error: 'Unauthorized — provide a valid signed link or admin Bearer token', code: 'unauthorized' }, 401) };
}

/** JSON endpoint polled by the trace page. */
export async function flowStatusJson(c: Context): Promise<Response> {
  const auth = await authorize(c);
  if ('response' in auth) return auth.response;
  const kv = (c.env as FlowRouteEnv).KV;
  const trace = await readFlowTrace(kv, auth.userId);
  if (!trace) return c.json({ error: 'No flow trace found for this user (run /auth/gmail first)' }, 404);
  return c.json(trace);
}

/**
 * GET /admin/flow-link?phone=+64… — admin-only (gated by the /admin/*
 * adminAuth middleware in index.ts). Resolves phone → userId and returns a
 * freshly minted signed /flow/status link for that user.
 */
export async function adminFlowLink(c: Context): Promise<Response> {
  const env = c.env as FlowRouteEnv;
  const phone = (c.req.query('phone') ?? '').trim();
  if (!phone) return c.json({ error: 'Missing phone parameter' }, 400);
  if (!env.ENCRYPTION_KEY) return c.json({ error: 'Encryption not configured' }, 500);
  const user = await getUserByPhone(env.DB, { ENCRYPTION_KEY: env.ENCRYPTION_KEY }, phone);
  if (!user) return c.json({ error: `No user found for phone ${phone}` }, 404);
  const url = await mintFlowLink(env.ENCRYPTION_KEY, user.id);
  return c.json({ url });
}

/** Server-rendered HTML trace page (polls status.json every 2s). */
export async function flowStatusPage(c: Context): Promise<Response> {
  const auth = await authorize(c);
  if ('response' in auth) return auth.response;
  const userId = auth.userId;
  const kv = (c.env as FlowRouteEnv).KV;

  // Initial snapshot for SSR (so the page isn't blank before the first poll).
  let initialStages: FlowStage[] = [];
  const trace = await readFlowTrace(kv, userId);
  if (trace) initialStages = trace.stages;

  const { u, exp, sig } = readSignedParams(c);
  const html = renderTracePage(userId, initialStages, u, exp, sig);
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

const STATUS_ICON: Record<FlowStageStatus, string> = {
  pending: '○',
  running: '◐',
  ok: '✓',
  failed: '✗',
  skipped: '–',
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Render the trace page. The signed-link params are forwarded to status.json
 * so the page's polling fetch stays authenticated without a Bearer header.
 */
function renderTracePage(
  userId: string,
  stages: FlowStage[],
  u: string | undefined,
  exp: string | undefined,
  sig: string | undefined
): string {
  const rows = stages.map((s) => stageRowHtml(s)).join('\n');
  // Build the query string the polling JS appends to /flow/status.json. When
  // loaded via signed link these are present; the admin-Bearer path has no
  // signed params (the browser would need to send the header, which only tests
  // do — the page itself is primarily for signed-link browser use).
  const signedQuery = u && exp && sig
    ? `?u=${encodeURIComponent(u)}&exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}`
    : '';
  const signedQueryJs = JSON.stringify(signedQuery);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Flip — Pipeline Trace</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 820px; margin: 32px auto; padding: 0 24px; background: #fafafa; }
    h1 { font-size: 1.25rem; margin-bottom: 4px; }
    .subtitle { color: #666; margin-bottom: 20px; font-size: 0.9rem; }
    .card { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px 20px; margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
    th { text-align: left; padding: 8px 8px; border-bottom: 2px solid #e0e0e0; color: #666; font-weight: 600; }
    td { padding: 10px 8px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
    .icon { font-size: 1.1rem; font-weight: 700; width: 28px; }
    .icon.ok { color: #1e8e3e; } .icon.failed { color: #d93025; } .icon.running { color: #1a73e8; } .icon.skipped { color: #888; } .icon.pending { color: #bbb; }
    .stage-name { font-weight: 600; text-transform: capitalize; }
    .detail { color: #444; font-size: 0.82rem; }
    .error { color: #d93025; font-family: 'SF Mono', Consolas, monospace; font-size: 0.78rem; margin-top: 4px; }
    .artifacts { margin-top: 4px; }
    .artifact { display: inline-block; background: #f0f4ff; color: #1a4ec5; padding: 1px 7px; border-radius: 4px; font-size: 0.72rem; margin: 1px; font-family: monospace; }
    .spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid #ccc; border-top-color: #1a73e8; border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: middle; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <h1>Pipeline Trace</h1>
  <p class="subtitle">user <code>${escapeHtml(userId)}</code></p>
  <div class="card">
    <table>
      <thead><tr><th></th><th>Stage</th><th>Duration</th><th>Detail</th></tr></thead>
      <tbody id="stages">
        ${rows || '<tr><td colspan="4" style="color:#888;text-align:center;padding:24px;">No trace yet — start at <a href="/auth/gmail">/auth/gmail</a></td></tr>'}
      </tbody>
    </table>
  </div>
  <p class="subtitle"><span class="spinner"></span> Auto-refresh every 2s · <a href="/flow/status.json${escapeHtml(signedQuery)}">JSON</a></p>
  <script>
    var signedQuery = ${signedQueryJs};
    function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
    function iconFor(status){return ({pending:'○',running:'◐',ok:'✓',failed:'✗',skipped:'–'})[status]||'○';}
    function durMs(s){
      if(!s.startedAt) return '—';
      var end = s.finishedAt ? new Date(s.finishedAt).getTime() : Date.now();
      return Math.max(0, end - new Date(s.startedAt).getTime()) + 'ms';
    }
    function artifactHtml(a){
      if(!a) return '';
      return Object.keys(a).map(function(k){return '<span class="artifact">'+esc(k)+': '+esc(a[k])+'</span>';}).join('');
    }
    function rowHtml(s){
      var icon = iconFor(s.status);
      var err = s.error ? '<div class="error">'+esc(s.error)+'</div>' : '';
      var art = artifactHtml(s.artifacts);
      return '<tr>'
        + '<td class="icon '+s.status+'">'+icon+'</td>'
        + '<td class="stage-name">'+esc(s.stage)+'</td>'
        + '<td>'+durMs(s)+'</td>'
        + '<td><div class="detail">'+esc(s.detail||'')+'</div>'+err+'<div class="artifacts">'+art+'</div></td>'
        + '</tr>';
    }
    function poll(){
      fetch('/flow/status.json' + signedQuery)
        .then(function(r){return r.json();})
        .then(function(trace){
          if(trace && trace.stages){
            document.getElementById('stages').innerHTML = trace.stages.map(rowHtml).join('\\n');
          }
        })
        .catch(function(){/* retry next poll */});
    }
    setInterval(poll, 2000);
  </script>
</body>
</html>`;
}

function stageRowHtml(s: FlowStage): string {
  const icon = STATUS_ICON[s.status] ?? '○';
  const errorHtml = s.error ? `<div class="error">${escapeHtml(s.error)}</div>` : '';
  const artifactHtml = s.artifacts
    ? Object.entries(s.artifacts)
        .map(([k, v]) => `<span class="artifact">${escapeHtml(k)}: ${escapeHtml(v)}</span>`)
        .join('')
    : '';
  const duration = s.startedAt
    ? `${Math.max(0, (s.finishedAt ? new Date(s.finishedAt).getTime() : Date.now()) - new Date(s.startedAt).getTime())}ms`
    : '—';
  return `        <tr>
          <td class="icon ${s.status}">${icon}</td>
          <td class="stage-name">${escapeHtml(s.stage)}</td>
          <td>${duration}</td>
          <td><div class="detail">${escapeHtml(s.detail ?? '')}</div>${errorHtml}<div class="artifacts">${artifactHtml}</div></td>
        </tr>`;
}
