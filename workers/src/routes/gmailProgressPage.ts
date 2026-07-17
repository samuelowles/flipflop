/**
 * OAuth-callback progress page (extracted from gmail.ts — file-size cap).
 *
 * Renders the post-connect page that live-polls:
 *   - /auth/gmail/scan-status  — inbox scan counters
 *   - /auth/gmail/eval-status  — parsed bill + plan comparison box
 *   - /flow/status.json (signed) — the FULL pipeline trace: per-stage status
 *     with durations/details/artifacts PLUS the append-only event log, so
 *     multi-bill test runs are fully observable from this one page.
 */

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderProgressPage(userId: string, setupLog: string[], _isError = false, flowUrl?: string): string {
  const logsJson = JSON.stringify(setupLog);
  const flowJsonUrl = flowUrl ? flowUrl.replace('/flow/status?', '/flow/status.json?') : '';
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
    /* Pipeline trace panel */
    .st-ok { color: #1e8e3e; font-weight: 700; }
    .st-failed { color: #d93025; font-weight: 700; }
    .st-running { color: #1a73e8; font-weight: 700; }
    .st-skipped { color: #888; font-weight: 700; }
    .st-pending { color: #bbb; font-weight: 700; }
    .stage-detail { color: #444; font-size: 0.78rem; }
    .stage-error { color: #d93025; font-family: monospace; font-size: 0.75rem; }
    .artifact { display: inline-block; background: #f0f4ff; color: #1a4ec5; padding: 1px 7px; border-radius: 4px; font-size: 0.7rem; margin: 1px; font-family: monospace; }
    #event-log { font-family: 'SF Mono', 'Consolas', monospace; font-size: 0.72rem; background: #0f1419; color: #d6deeb; border-radius: 6px; padding: 12px; max-height: 340px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; }
    .ev-ts { color: #7fdbca; }
    .ev-stage { color: #c792ea; font-weight: 700; }
    .ev-ok { color: #a6e22e; } .ev-failed { color: #ff5370; } .ev-running { color: #82aaff; } .ev-skipped { color: #8a919d; }
    .ev-art { color: #ffcb6b; }
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
      <div class="stat"><span class="stat-label">Already imported (previous scans)</span><span class="stat-value" id="stat-duplicates">—</span></div>
      <div class="stat"><span class="stat-label">Skipped (no bill subject)</span><span class="stat-value" id="stat-nosubject">—</span></div>
      <div class="stat"><span class="stat-label">Skipped (no PDF)</span><span class="stat-value" id="stat-nopdf">—</span></div>
      <div class="stat"><span class="stat-label">Status</span><span class="stat-value" id="stat-status"><span class="spinner"></span>Running...</span></div>
    </div>
  </div>

  <div class="card" id="trace-card" style="display:none;">
    <h3>Pipeline Trace <span style="font-weight:400;font-size:0.75rem;color:#888;" id="trace-updated"></span></h3>
    <table><thead><tr><th></th><th>Stage</th><th>Duration</th><th>Detail</th></tr></thead>
    <tbody id="trace-stages"></tbody></table>
    <h4 style="margin:16px 0 8px;font-size:0.9rem;">Event Log <span style="font-weight:400;font-size:0.72rem;color:#888;">(every stage transition, all bills — newest last)</span></h4>
    <div id="event-log">waiting for events…</div>
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
    var flowJsonUrl = '${escapeHtml(flowJsonUrl)}';
    var pollTimer;
    var evalTimer;
    var traceTimer;
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
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ---- Pipeline trace panel (stages + append-only event log) ----
    var STATUS_ICON = { ok: '✓', failed: '✗', running: '●', skipped: '⊘', pending: '○' };
    var lastEventCount = -1;

    function stageDuration(s) {
      if (!s.startedAt || !s.finishedAt) return '—';
      var ms = new Date(s.finishedAt) - new Date(s.startedAt);
      return ms >= 0 ? (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms') : '—';
    }

    function artifactsHtml(a) {
      if (!a) return '';
      return Object.keys(a).map(function(k) {
        return '<span class="artifact">' + esc(k) + ': ' + esc(a[k]) + '</span>';
      }).join('');
    }

    function renderTrace(t) {
      document.getElementById('trace-card').style.display = '';
      document.getElementById('trace-updated').textContent = t.updatedAt ? 'updated ' + new Date(t.updatedAt).toLocaleTimeString() : '';

      document.getElementById('trace-stages').innerHTML = (t.stages || []).map(function(s) {
        return '<tr>'
          + '<td class="st-' + esc(s.status) + '">' + (STATUS_ICON[s.status] || '?') + '</td>'
          + '<td style="font-weight:600;text-transform:capitalize;">' + esc(s.stage) + '</td>'
          + '<td>' + stageDuration(s) + '</td>'
          + '<td><div class="stage-detail">' + esc(s.detail || '') + '</div>'
          + (s.error ? '<div class="stage-error">' + esc(s.error) + '</div>' : '')
          + '<div>' + artifactsHtml(s.artifacts) + '</div></td>'
          + '</tr>';
      }).join('');

      var events = t.events || [];
      if (events.length !== lastEventCount) {
        lastEventCount = events.length;
        var el = document.getElementById('event-log');
        el.innerHTML = events.length === 0 ? 'no events yet…' : events.map(function(e) {
          var ts = e.ts ? new Date(e.ts).toLocaleTimeString('en-NZ', { hour12: false }) + '.' + String(new Date(e.ts).getMilliseconds()).padStart(3, '0') : '—';
          var arts = e.artifacts ? Object.keys(e.artifacts).map(function(k) { return k + '=' + e.artifacts[k]; }).join(' ') : '';
          return '<span class="ev-ts">' + esc(ts) + '</span> '
            + '<span class="ev-stage">' + esc(e.stage) + '</span> '
            + '<span class="ev-' + esc(e.status) + '">' + esc(e.status).toUpperCase() + '</span> '
            + esc(e.detail || e.error || '')
            + (arts ? ' <span class="ev-art">[' + esc(arts) + ']</span>' : '');
        }).join('\\n');
        el.scrollTop = el.scrollHeight;
      }
    }

    function pollTrace() {
      if (!flowJsonUrl) return;
      fetch(flowJsonUrl)
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(t) { if (t && t.stages) renderTrace(t); })
        .catch(function() { /* retry on next poll */ });
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
      document.getElementById('stat-duplicates').textContent = data.billsAlreadyImported || 0;
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

    // Detailed pipeline trace: poll every 2 seconds for as long as the page
    // is open — this is the test-run observability panel, it never gives up.
    if (flowJsonUrl) {
      pollTrace();
      traceTimer = setInterval(pollTrace, 2000);
    }
  </script>
</body>
</html>`;
}
