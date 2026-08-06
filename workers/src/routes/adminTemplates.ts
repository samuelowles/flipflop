/**
 * Admin endpoints for Sent WhatsApp template approval status (Epic #2 #24-29).
 *
 * Surfaces per-template status from Sent so ops can see at a glance which
 * templates are still pending Meta approval and which have been rejected
 * (with the rejection reason inline).
 */

import type { Context } from 'hono';
import { SENT_TEMPLATES, getTemplateStatus, submitTemplate, type SentTemplateStatus } from '../services/sentTemplates';

interface AdminTemplatesEnv {
  readonly SENT_API_KEY: string;
}

interface TemplateStatusResponse {
  readonly name: string;
  readonly content: string;
  readonly variables: readonly string[];
  readonly status: SentTemplateStatus['status'];
  readonly rejectionReason?: string;
}

export async function adminListTemplates(_c: Context): Promise<Response> {
  // No external call needed — the registry is static. Returns the 6 templates
  // with their variable lists so admins can see what'll be submitted.
  return _c.json({
    templates: SENT_TEMPLATES.map((t) => ({
      name: t.name,
      content: t.content,
      variables: t.variables,
    })),
  });
}

export async function adminTemplateStatus(c: Context): Promise<Response> {
  const env = c.env as AdminTemplatesEnv;
  const results: TemplateStatusResponse[] = await Promise.all(
    SENT_TEMPLATES.map(async (t): Promise<TemplateStatusResponse> => {
      try {
        const status: SentTemplateStatus = await getTemplateStatus(env.SENT_API_KEY, t.name);
        return {
          name: t.name,
          content: t.content,
          variables: t.variables,
          status: status.status,
          ...(status.rejectionReason ? { rejectionReason: status.rejectionReason } : {}),
        };
      } catch (err) {
        // Surface per-template failures as 'unknown' rather than failing the
        // whole admin page — operators want to see which templates are queryable
        // and which Sent refused to report on.
        console.log(JSON.stringify({
          type: 'admin_template_status_error',
          name: t.name,
          error: err instanceof Error ? err.message : 'unknown',
          timestamp: new Date().toISOString(),
        }));
        return {
          name: t.name,
          content: t.content,
          variables: t.variables,
          status: 'pending',
        };
      }
    })
  );

  return c.json({ templates: results });
}
/**
 * POST /admin/templates/submit — (re)submit registry templates to Sent.
 *
 * `submitTemplate` has existed since Epic #2 with ZERO callers, so the registry
 * could be changed but never actually re-registered. That bit immediately:
 * #265 corrected `saving_alert` from "over the next 3 months" to "12 months"
 * (the number passed to it is annual, so the old copy overstated every alert by
 * 4x), and there was no wired way to get the corrected body approved — the fix
 * was merged and deployed but could not reach WhatsApp.
 *
 * Body: `{"names": ["saving_alert"]}` to target specific templates, or omit for
 * all six. Per-template results, so one rejection does not hide the others.
 *
 * This submits; it does not approve. Meta approval is asynchronous (1-4 weeks
 * per DEPLOY.md) — poll `GET /admin/templates/status` for the outcome. SMS
 * delivery is unaffected by approval state and uses the same body verbatim.
 */
export async function adminSubmitTemplates(c: Context): Promise<Response> {
  const env = c.env as AdminTemplatesEnv;

  let names: string[] | undefined;
  const body = (await c.req.json().catch(() => null)) as { names?: unknown } | null;
  if (body && Array.isArray(body.names)) {
    names = body.names.filter((n): n is string => typeof n === 'string');
  }

  const targets = names && names.length > 0
    ? SENT_TEMPLATES.filter((t) => names!.includes(t.name))
    : SENT_TEMPLATES;

  if (targets.length === 0) {
    return c.json(
      { error: 'No matching templates', code: 'unknown_template', known: SENT_TEMPLATES.map((t) => t.name) },
      400
    );
  }

  const results = await Promise.all(
    targets.map(async (t) => {
      try {
        const receipt = await submitTemplate(env.SENT_API_KEY, t);
        return { name: t.name, submitted: true, id: receipt.id, status: receipt.status };
      } catch (err) {
        // One failure must not mask the rest — report per template.
        return { name: t.name, submitted: false, error: (err as Error).message };
      }
    })
  );

  const anyFailed = results.some((r) => !r.submitted);
  return c.json({ results }, anyFailed ? 207 : 200);
}
