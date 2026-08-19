// PRD §6.1 — the two saving thresholds. A proactive alert to a paying
// customer requires ≥ $200/yr; the web savings preview fires at the lower
// $50/yr. The probe drives the comparison surface with a scenario whose
// annual saving lands BETWEEN the two bars, then asserts the preview still
// surfaces the saving while no proactive alert was dispatched. The two
// thresholds are never conflated — that conflation is exactly the bug class
// this claim exists to prevent.
//
// Routes (workers/src/index.ts, workers/src/routes/eval.ts):
//   POST /eval/upload          multipart form: file=<bill.pdf>, phone=<mobile>
//                              → 303 redirect to /eval/result?token=<uuid>
//   GET  /eval/status?token=   { found, parsedData, comparisons, ... }
//   GET  /admin/notifications  notification audit; ?status=sent&since=<ISO>

import { readFileSync } from "node:fs";
import { skip, assert } from "../lib/probe.mjs";

// PRD §6.1, in annual cents. Same table, two different bars.
const PREVIEW_THRESHOLD_CENTS = 5000; // $50/yr — the customer is present and asking
const ALERT_THRESHOLD_CENTS = 20000; // $200/yr — interrupting someone unprompted

// Scenario-scoped phone: passes the server's NZ mobile check
// (routes/eval.ts: /^\+64\d{7,11}$/) but belongs to no real customer. Every
// write this probe makes is scoped to it.
const SCENARIO_PHONE = "+6499990001";

export default {
  id: "001-below-threshold",
  claim: "PRD §6.1",
  describes: "a saving between $50 and $200/yr still shows in the preview but sends no proactive alert",
  async run(ctx) {
    if (!ctx.baseUrl) throw skip("FLIP_ACCEPTANCE_BASE_URL is not set — no staging deployment to probe");
    const fixture = process.env.FLIP_ACCEPTANCE_MIDBAND_PDF;
    if (!fixture) throw skip("FLIP_ACCEPTANCE_MIDBAND_PDF is not set — no curated bill whose comparison lands between $50 and $200/yr exists yet");
    const adminKey = process.env.FLIP_ACCEPTANCE_ADMIN_KEY;
    if (!adminKey) throw skip("FLIP_ACCEPTANCE_ADMIN_KEY is not set — cannot read GET /admin/notifications to prove no alert was dispatched");

    const since = new Date().toISOString();

    // 1. Drive the comparison through the web eval surface. fetch follows the
    //    303, so the final URL carries the result token.
    //    TODO(staging): curate a bill that parses cleanly (confidence ≥ 0.6)
    //    and compares to a saving in the $50–$200 band against the staging
    //    plan data; none can be verified without a staging deployment.
    const form = new FormData();
    form.append("file", new Blob([readFileSync(fixture)], { type: "application/pdf" }), "midband.pdf");
    form.append("phone", SCENARIO_PHONE);
    const upload = await ctx.fetch("/eval/upload", { method: "POST", body: form });
    assert(upload.ok, `POST /eval/upload came back ${upload.status} ${upload.statusText}`);
    const token = new URL(upload.url).searchParams.get("token");
    assert(token, "upload did not redirect to a result token");

    // 2. The preview must still surface the saving — the $50 bar is met.
    const status = await (await ctx.fetch(`/eval/status?token=${encodeURIComponent(token)}`)).json();
    assert(status.found, `eval status not found for token ${token}`);
    const rows = status.comparisons || [];
    assert(rows.length > 0, "the preview surfaced no comparison rows at all");
    const best = rows.reduce((a, c) => ((c.saving_cents ?? 0) > (a.saving_cents ?? -1) ? c : a));
    assert(
      best.saving_cents > PREVIEW_THRESHOLD_CENTS && best.saving_cents < ALERT_THRESHOLD_CENTS,
      `scenario is not mid-band: best saving_cents=${best.saving_cents} (need strictly between ${PREVIEW_THRESHOLD_CENTS} and ${ALERT_THRESHOLD_CENTS})`
    );

    // 3. No proactive alert may have been dispatched — the $200 bar is not met.
    //    The notification audit is the deployed record of dispatch outcomes.
    //    TODO(staging): scope this to the scenario user once a probe-visible
    //    phone → userId resolution exists; today /admin/flow-link returns a
    //    signed link, not the id, so a quiet-staging window is the assertion.
    const audit = await (
      await ctx.fetch(`/admin/notifications?status=sent&since=${encodeURIComponent(since)}`, {
        headers: { Authorization: `Bearer ${adminKey}` },
      })
    ).json();
    const alerts = (audit.notifications || []).filter((n) => n.notificationType === "saving_alert");
    assert(alerts.length === 0, `${alerts.length} saving_alert(s) dispatched while the best saving was $${best.saving_cents / 100}/yr — below the $200/yr alert bar`);
  },
};
