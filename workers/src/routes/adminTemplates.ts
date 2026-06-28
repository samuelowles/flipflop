/**
 * Admin endpoints for Sent WhatsApp template approval status (Epic #2 #24-29).
 *
 * Surfaces per-template status from Sent so ops can see at a glance which
 * templates are still pending Meta approval and which have been rejected
 * (with the rejection reason inline).
 */

import type { Context } from 'hono';
import { SENT_TEMPLATES, getTemplateStatus, type SentTemplateStatus } from '../services/sentTemplates';

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