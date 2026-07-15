/**
 * Issue #228 — FlowTrace observation routes (Epic 13 DoD).
 *
 *   GET /flow/status?phone=+64…    — server-rendered HTML trace page (admin-auth'd
 *                                     like /admin/*; resolves phone → userId).
 *   GET /flow/status.json?phone=+64… — JSON the page polls every 2s.
 *
 * The page is one HTML string (no SPA/framework), mirroring the existing
 * /auth/gmail/scan-status pattern. Each stage = a row: name, status icon,
 * duration, detail sentence, error verbatim, artifact links.
 */

import type { Context } from 'hono';
import { getUserByPhone } from '../models/users';
import { readFlowTrace } from '../services/flowTrace';
import type { FlowStage, FlowStageStatus } from '../types/flowTrace';

interface FlowRouteEnv {
  readonly DB: D1Database;
  readonly KV: KVNamespace;
  readonly ENCRYPTION_KEY: string;
}

/** Resolve a phone param to a userId (or null). */
async function resolveUserId(c: Context): Promise<{ userId: string | null; phone: string; error?: string }> {
  const phone = (c.req.query('phone') ?? '').trim();
  if (!phone) return { userId: null, phone, error: 'Missing phone parameter' };
  const env = c.env as FlowRouteEnv;
  if (!env.ENCRYPTION_KEY) return { userId: null, phone, error: 'Encryption not configured' };
  const user = await getUserByPhone(env.DB, { ENCRYPTION_KEY: env.ENCRYPTION_KEY }, phone);
  if (!user) return { userId: null, phone, error: `No user found for phone ${phone}` };
  return { userId: user.id, phone };
}

/** JSON endpoint polled by the trace page. */
export async function flowStatusJson(c: Context): Promise<Response> {
  const { userId, error } = await resolveUserId(c);
  if (error) return c.json({ error }, 400);
  const kv = (c.env as FlowRouteEnv).KV;
  const trace = await readFlowTrace(kv, userId!);
  if (!trace) return c.json({ error: 'No flow trace found for this user (run /auth/gmail first)' }, 404);
  return c.json(trace);
}

/** Server-rendered HTML trace page (polls status.json every 2s). */
export async function flowStatusPage(c: Context): Promise<Response> {
  const { userId, phone, error } = await resolveUserId(c);
  const kv = (c.env as FlowRouteEnv).KV;

  // Initial snapshot for SSR (so the page isn't blank before the first poll).
  let initialStages: FlowStage[] = [];
  if (userId) {
    const trace = await readFlowTrace(kv, userId);
    if (trace) initialStages = trace.stages;
  }

  const html = renderTracePage(phone, userId, error, initialStages);
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

function renderTracePage(phone: string, userId: string | null, error: string | undefined, stages: FlowStage[]): string {
  const rows = stages.map((s) => stageRowHtml(s)).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Flip — Pipeline Trace ${escapeHtml(phone)}</title>
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
    .err-banner { color: #d93025; background: #fce8e6; padding: 10px 14px; border-radius: 6px; margin-bottom: 16px; font-size: 0.88rem; }
  </style>
</head>
<body>
  <h1>Pipeline Trace</h1>
  <p class="subtitle">Phone: ${escapeHtml(phone)}${userId ? ` · user <code>${escapeHtml(userId)}</code>` : ''}</p>
  ${error ? `<div class="err-banner">${escapeHtml(error)}</div>` : ''}
  <div class="card">
    <table>
      <thead><tr><th></th><th>Stage</th><th>Duration</th><th>Detail</th></tr></thead>
      <tbody id="stages">
        ${rows || '<tr><td colspan="4" style="color:#888;text-align:center;padding:24px;">No trace yet — start at <a href="/auth/gmail">/auth/gmail</a></td></tr>'}
      </tbody>
    </table>
  </div>
  <p class="subtitle"><span class="spinner"></span> Auto-refresh every 2s · <a href="/flow/status.json?phone=${encodeURIComponent(phone)}">JSON</a></p>
  <script>
    var phone = ${JSON.stringify(phone)};
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
      fetch('/flow/status.json?phone='+encodeURIComponent(phone))
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
