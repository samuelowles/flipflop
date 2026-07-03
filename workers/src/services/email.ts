/**
 * Issue #132 (Epic #8) — minimal outbound email sender.
 *
 * EMAIL INFRA DECISION: no email provider helper existed in the repo (grep for
 * resend/sendgrid/mailchannels/ops@ turned up nothing). Epic #12 (#136-143,
 * Email OAuth) will wire full email later. For #132 we need ONE thing: an
 * ops-only alert when a switch fails, so a human can triage.
 *
 * Design: a minimal Resend fetch (the standard Cloudflare Workers choice —
 * single `fetch` to `https://api.resend.com/emails` with a Bearer key).
 *
 * INERT-BY-DEFAULT: if `RESEND_API_KEY` is unset, the send is skipped and the
 * alert is emitted as a structured `console.log` instead. This means:
 *   - No hard dependency on a provider being configured (works in dev/test/no-key envs).
 *   - The switch failure path NEVER breaks because the email provider is down
 *     or unconfigured — the state machine has already marked the switch failed.
 *
 * The ops alert is INTERNAL: it may carry the opaque user_id but NEVER raw
 * phone/email/name (see buildSwitchFailureEmail).
 */

/** Env shape consumed by the email sender. */
export interface EmailEnv {
  /** Resend API key. When absent, sends become structured log lines (inert). */
  readonly RESEND_API_KEY?: string;
  /** Address that receives ops alerts. Defaults to ops@flip. */
  readonly OPS_EMAIL?: string;
}

/** A built email ready to hand to a provider. */
export interface BuiltEmail {
  readonly subject: string;
  readonly text: string;
}

interface SendEmailInput {
  /** The already-built email (subject + text body). */
  readonly email: BuiltEmail;
  /** Recipient (To:). For ops alerts this is typically OPS_EMAIL. */
  readonly to: string;
  /** BCC recipient. Issue #132 AC: bcc ops@flip. */
  readonly bcc?: string;
}

interface ResendSendResult {
  readonly ok: boolean;
  /** Provider message id on success; structured-log note on inert/fallback. */
  readonly detail: string;
}

/**
 * Send one email via Resend. INERT when `RESEND_API_KEY` is unset — logs the
 * email payload as a structured JSON line and returns ok=true so callers treat
 * the no-provider path as a non-error (the alert is still delivered to logs).
 *
 * This function MUST NOT throw on send failure — callers (notably failSwitch)
 * depend on the failure-tolerance guarantee: a broken email provider must never
 * roll back a switch state transition. All errors are caught + logged.
 */
export async function sendEmail(
  env: EmailEnv,
  input: SendEmailInput
): Promise<ResendSendResult> {
  const opsEmail = env.OPS_EMAIL ?? 'ops@flip.nz';

  // INERT path: no API key → structured log only. The alert still exists (in
  // logs), so ops triage is possible in environments without a provider wired.
  if (!env.RESEND_API_KEY) {
    console.log(
      JSON.stringify({
        level: 'warn',
        type: 'ops_email_inert',
        reason: 'RESEND_API_KEY unset; logging alert instead of sending',
        to: input.to,
        bcc: input.bcc ?? opsEmail,
        subject: input.email.subject,
        body: input.email.text,
        timestamp: new Date().toISOString(),
      })
    );
    return { ok: true, detail: 'inert:logged (no RESEND_API_KEY)' };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `Flip Ops <${opsEmail}>`,
        to: input.to,
        bcc: input.bcc ?? opsEmail,
        subject: input.email.subject,
        text: input.email.text,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.log(
        JSON.stringify({
          level: 'error',
          type: 'ops_email_send_failed',
          status: res.status,
          statusText: res.statusText,
          body: errText.slice(0, 500),
          subject: input.email.subject,
          timestamp: new Date().toISOString(),
        })
      );
      return { ok: false, detail: `resend:${res.status}` };
    }

    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, detail: data.id ?? 'resend:ok' };
  } catch (err) {
    // ponytail: swallow — failure-tolerance contract. A provider outage or
    // network blip must not propagate to the switch state machine. Log + return.
    const message = err instanceof Error ? err.message : String(err);
    console.log(
      JSON.stringify({
        level: 'error',
        type: 'ops_email_exception',
        message,
        subject: input.email.subject,
        timestamp: new Date().toISOString(),
      })
    );
    return { ok: false, detail: `exception:${message}` };
  }
}
