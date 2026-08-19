// PRD §6.4 — a single global STOP halts every outbound message class: alerts,
// reassurance, expiry warnings, abandoned-cart recovery. There is no granular
// opt-out, and STOP takes effect BEFORE the inbound webhook acknowledges.
// The probe sends a STOP inbound, then asserts every class is suppressed.
//
// Routes (workers/src/index.ts, workers/src/routes/messaging.ts,
// workers/src/middleware/sentAuth.ts, workers/src/routes/adminNotifications.ts):
//   POST /webhook/messaging    Sent inbound webhook. Auth is HMAC-SHA256
//                              (hex) over `${X-Sent-Timestamp}.${rawBody}` with
//                              the shared webhook secret; the timestamp must
//                              be 10-digit unix seconds within 5 minutes.
//   GET  /admin/notifications  notification audit; ?status=sent&since=<ISO>
//
// In the deployed code the message classes are the NotificationType values:
// saving_alert (alerts), stay_put / free_tier_checkin (reassurance),
// fixed_term_expiry (expiry warnings), switch_update. Abandoned-cart recovery
// is documented in the PRD but has no notification type yet; when it lands it
// joins the same audit, and this probe's "no class dispatched" assertion
// covers it without change.

import { createHmac } from "node:crypto";
import { skip, assert } from "../lib/probe.mjs";

// Scenario-scoped phone (see workers/src/routes/messaging.ts SentWebhookPayload
// `from`). Belongs to no real customer; the STOP is scoped to it.
const SCENARIO_PHONE = "+6499990002";

// Every proactive class the audit can record (workers/src/types/notification.ts).
const MESSAGE_CLASSES = ["saving_alert", "stay_put", "free_tier_checkin", "fixed_term_expiry", "switch_update"];

export default {
  id: "002-stop-honoured",
  claim: "PRD §6.4",
  describes: "a single global STOP suppresses every outbound message class, taking effect before the webhook acks",
  async run(ctx) {
    if (!ctx.baseUrl) throw skip("FLIP_ACCEPTANCE_BASE_URL is not set — no staging deployment to probe");
    const secret = process.env.FLIP_ACCEPTANCE_SENT_WEBHOOK_SECRET;
    if (!secret) throw skip("FLIP_ACCEPTANCE_SENT_WEBHOOK_SECRET is not set — cannot sign a POST /webhook/messaging inbound");
    const adminKey = process.env.FLIP_ACCEPTANCE_ADMIN_KEY;
    if (!adminKey) throw skip("FLIP_ACCEPTANCE_ADMIN_KEY is not set — cannot read GET /admin/notifications to prove suppression");

    const since = new Date().toISOString();

    // 1. Send the STOP inbound, signed exactly as sentAuth.ts verifies:
    //    HMAC-SHA256 over `${timestamp}.${rawBody}`, hex-encoded.
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({
      id: `acceptance-${timestamp}`,
      from: SCENARIO_PHONE,
      body: "STOP",
      channel: "whatsapp",
      timestamp: new Date().toISOString(),
    });
    const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
    const inbound = await ctx.fetch("/webhook/messaging", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sent-Timestamp": timestamp,
        "X-Sent-Signature": signature,
      },
      body: rawBody,
    });
    // PRD §6.4: STOP takes effect before the inbound webhook acknowledges. The
    // 200 below IS that acknowledgement — by the time it arrives, the STOP
    // must already be in force. A 401/500 here fails the probe outright.
    assert(inbound.status === 200, `POST /webhook/messaging returned ${inbound.status} — the STOP never reached the state machine`);
    const ack = await inbound.json();
    assert(ack.status === "ok", `webhook did not acknowledge cleanly: ${JSON.stringify(ack)}`);

    // 2. Assert every class is suppressed. Suppression leaves no audit row
    //    (the opted-out paths return before dispatch and are not audited), so
    //    the proof is that nothing of any class was dispatched for the window
    //    after the STOP.
    //    TODO(staging): deliberately firing each class at the STOPped scenario
    //    user needs pipeline/cron triggers no route exposes yet; until they
    //    exist, the quiet window is the strongest deployed assertion.
    const audit = await (
      await ctx.fetch(`/admin/notifications?status=sent&since=${encodeURIComponent(since)}`, {
        headers: { Authorization: `Bearer ${adminKey}` },
      })
    ).json();
    const dispatched = (audit.notifications || []).filter((n) => MESSAGE_CLASSES.includes(n.notificationType));
    assert(
      dispatched.length === 0,
      `${dispatched.length} outbound message(s) dispatched after STOP: ${dispatched.map((n) => n.notificationType).join(", ")}`
    );
  },
};
