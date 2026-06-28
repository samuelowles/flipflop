/**
 * Sent WhatsApp template registry + submission + status (Epic #2 #24-29).
 *
 * PRD 7.7 defines 6 templates for proactive outreach. Sent handles the
 * Meta approval lifecycle and tracks each template's status. SMS fallback
 * uses the same template body verbatim — no WhatsApp-specific markup.
 */

const SENT_API_BASE = 'https://api.sent.dm/v1';

export type TemplateStatus = 'pending' | 'approved' | 'rejected' | 'paused';

export interface SentTemplate {
  readonly name: string;
  readonly content: string;
  readonly variables: readonly string[];
}

export const SENT_TEMPLATES: readonly SentTemplate[] = [
  {
    name: 'bill_received',
    content: "Got your {{1}} bill. {{2}} kWh over {{3}} days, ${{4}}. I'll compare your plans now.",
    variables: ['retailer', 'usage_kwh', 'days', 'total_dollars'],
  },
  {
    name: 'saving_alert',
    content: 'You could save ~${{1}} over the next 3 months by switching to {{2}}. Want me to switch you?',
    variables: ['saving_amount', 'recommended_retailer'],
  },
  {
    name: 'stay_put',
    content: "Good news -- you're still on the best plan for your usage. I'll keep watching.",
    variables: [],
  },
  {
    name: 'switch_update',
    content: 'Your switch to {{1}} is {{2}}. Next: {{3}}.',
    variables: ['to_retailer', 'status', 'next_step'],
  },
  {
    name: 'fixed_term_expiry',
    content: "Your fixed term with {{1}} ends on {{2}}. I'll check what's available closer to then.",
    variables: ['retailer', 'expiry_date'],
  },
  {
    name: 'free_tier_checkin',
    content: 'Your monthly check-in: {{1}}. Upgrade to Always On for $30/yr to get automatic alerts.',
    variables: ['status_summary'],
  },
];

export function getTemplate(name: string): SentTemplate {
  const found = SENT_TEMPLATES.find((t) => t.name === name);
  if (!found) {
    throw new Error(`unknown template: ${name}`);
  }
  return found;
}

/**
 * Render a template body by substituting {{1}}..{{N}} with the matching
 * positional variables. Throws if a required variable is missing — better to
 * fail loud than send "Got your undefined bill." to a customer.
 */
export function renderTemplate(name: string, variables: Record<string, string>): string {
  const template = getTemplate(name);
  return template.content.replace(/\{\{(\d+)\}\}/g, (_, idx: string) => {
    const i = Number(idx) - 1;
    const varName = template.variables[i];
    if (!varName) throw new Error(`template ${name} has no variable at position ${idx}`);
    const value = variables[varName];
    if (value === undefined) {
      throw new Error(`template ${name} requires variable "${varName}" (position ${idx})`);
    }
    return value;
  });
}

export interface SentTemplateSubmission {
  readonly id: string;
  readonly status: TemplateStatus;
  readonly submittedAt: string;
}

export interface SentTemplateStatus {
  readonly name: string;
  readonly status: TemplateStatus;
  readonly lastCheckedAt: string;
  readonly rejectionReason?: string;
}

export async function submitTemplate(
  apiKey: string,
  template: SentTemplate
): Promise<SentTemplateSubmission> {
  const response = await fetch(`${SENT_API_BASE}/templates`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      name: template.name,
      content: template.content,
      variables: template.variables,
    }),
  });

  if (!response.ok) {
    throw new Error(`Sent template submit error (${response.status}): ${await response.text()}`);
  }

  return (await response.json()) as SentTemplateSubmission;
}

export async function getTemplateStatus(
  apiKey: string,
  name: string
): Promise<SentTemplateStatus> {
  const response = await fetch(`${SENT_API_BASE}/templates/${encodeURIComponent(name)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    throw new Error(`Sent template status error (${response.status}): ${await response.text()}`);
  }

  return (await response.json()) as SentTemplateStatus;
}