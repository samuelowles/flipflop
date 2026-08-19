// PRD §8.3 — an alert only fires when the underlying bill reconciled
// arithmetically against its printed total. A bill whose extracted rates and
// usage cannot multiply back to its printed total has at least one
// mis-extracted field, so it must not be auto-accepted no matter how many
// fields were populated. The probe submits a bill that fails reconcile_total
// and asserts no alert fires and the bill is routed to review.
//
// Routes (workers/src/index.ts, workers/src/routes/eval.ts,
// workers/src/routes/adminNotifications.ts):
//   POST /eval/upload          multipart form: file=<bill.pdf>, phone=<mobile>
//                              → 303 redirect to /eval/result?token=<uuid>
//   GET  /eval/status?token=   { found, parsedData, comparisons, ... }
//   GET  /admin/notifications  notification audit; ?status=sent&since=<ISO>
//
// Where the guard lives: python/parsers/base.py caps confidence at
// RECONCILE_FAIL_CONFIDENCE when reconcile_total reports disagreement, and
// routes/eval.ts stores the bill as needs_review below the 0.6 auto-accept
// bar. runEvalComparison then excludes non-parsed bills from comparison, so
// nothing reaches the notify path. No route exposes the bill row directly —
// the confidence bar plus the absence of comparisons is the observable form
// of "routed to review".

import { readFileSync } from "node:fs";
import { skip, assert } from "../lib/probe.mjs";

// routes/eval.ts line ~807: status = confidence >= 0.6 ? 'parsed' : 'needs_review'
const AUTO_ACCEPT_CONFIDENCE = 0.6;

// Scenario-scoped phone, fresh per run so no earlier bill of this probe's user
// can mask the unreconciled one. Passes the server's NZ mobile check; belongs
// to no real customer.
const SCENARIO_PHONE = "+6499990003";

export default {
  id: "003-parse-reconciliation",
  claim: "PRD §8.3",
  describes: "a bill that fails arithmetic reconciliation raises no alert and is routed to review",
  async run(ctx) {
    if (!ctx.baseUrl) throw skip("FLIP_ACCEPTANCE_BASE_URL is not set — no staging deployment to probe");
    const fixture = process.env.FLIP_ACCEPTANCE_UNRECONCILED_PDF;
    if (!fixture) throw skip("FLIP_ACCEPTANCE_UNRECONCILED_PDF is not set — no curated bill that fails reconcile_total exists yet");
    const adminKey = process.env.FLIP_ACCEPTANCE_ADMIN_KEY;
    if (!adminKey) throw skip("FLIP_ACCEPTANCE_ADMIN_KEY is not set — cannot read GET /admin/notifications to prove no alert fired");

    const since = new Date().toISOString();

    // 1. Submit the bill through the web eval surface.
    //    TODO(staging): curate a bill whose line items are all extractable but
    //    whose printed total disagrees (reconcile_total > RECONCILE_TOLERANCE)
    //    — e.g. a doctored total on a real layout. A hard parse error is NOT
    //    this scenario; the fixture must parse and then fail reconciliation.
    const form = new FormData();
    form.append("file", new Blob([readFileSync(fixture)], { type: "application/pdf" }), "unreconciled.pdf");
    form.append("phone", SCENARIO_PHONE);
    const upload = await ctx.fetch("/eval/upload", { method: "POST", body: form });
    assert(upload.ok, `POST /eval/upload came back ${upload.status} ${upload.statusText}`);
    const token = new URL(upload.url).searchParams.get("token");
    assert(token, "upload did not redirect to a result token");

    // 2. The bill must be routed to review, not auto-accepted. The externally
    //    visible form of that routing is the capped confidence.
    const status = await (await ctx.fetch(`/eval/status?token=${encodeURIComponent(token)}`)).json();
    assert(status.found, `eval status not found for token ${token}`);
    assert(status.parsedData, `the fixture errored out entirely (error: ${status.error ?? "none"}) instead of failing reconciliation — it is not exercising PRD §8.3`);
    const confidence = Number(status.parsedData.confidence);
    assert(
      !Number.isNaN(confidence) && confidence < AUTO_ACCEPT_CONFIDENCE,
      `unreconciled bill was auto-accepted: confidence ${status.parsedData.confidence} ≥ ${AUTO_ACCEPT_CONFIDENCE}, so it stored as parsed rather than needs_review`
    );

    // 3. No alert may fire. A needs_review bill is excluded from comparison,
    //    so a fresh scenario user must show no comparison rows at all.
    const rows = status.comparisons || [];
    assert(rows.length === 0, `${rows.length} comparison row(s) built from an unreconciled bill — it should never have reached the comparator`);

    // 4. …and nothing was dispatched. Belt and braces: even if a comparison
    //    had slipped through, the audit must show no dispatch.
    const audit = await (
      await ctx.fetch(`/admin/notifications?status=sent&since=${encodeURIComponent(since)}`, {
        headers: { Authorization: `Bearer ${adminKey}` },
      })
    ).json();
    const dispatched = (audit.notifications || []).filter((n) => n.status === "sent");
    assert(dispatched.length === 0, `${dispatched.length} notification(s) dispatched from a bill that failed reconciliation`);
  },
};
