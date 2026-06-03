const SENT_API_BASE = 'https://api.sent.dm/v1';

interface SentMessageResponse {
  readonly id: string;
  readonly channel: 'whatsapp' | 'sms';
}

export async function sendMessage(
  apiKey: string,
  to: string,
  body: string,
  channel?: 'whatsapp' | 'sms'
): Promise<{ messageId: string; channel: string }> {
  const response = await fetch(`${SENT_API_BASE}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      to,
      body,
      ...(channel ? { channel } : {}),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Sent API error (${response.status}): ${errorText}`);
  }

  const data = await response.json() as SentMessageResponse;

  console.log(JSON.stringify({
    type: 'sent_message',
    message_id: data.id,
    channel: data.channel,
    timestamp: new Date().toISOString(),
    // Never log phone number or message body
  }));

  return { messageId: data.id, channel: data.channel };
}

export async function sendTemplate(
  apiKey: string,
  to: string,
  templateName: string,
  variables: Record<string, string>
): Promise<{ messageId: string }> {
  const response = await fetch(`${SENT_API_BASE}/messages/template`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      to,
      template_name: templateName,
      variables,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Sent template API error (${response.status}): ${errorText}`);
  }

  const data = await response.json() as SentMessageResponse;

  console.log(JSON.stringify({
    type: 'sent_template',
    message_id: data.id,
    template: templateName,
    timestamp: new Date().toISOString(),
  }));

  return { messageId: data.id };
}

export async function downloadMedia(
  apiKey: string,
  mediaUrl: string
): Promise<ArrayBuffer> {
  const response = await fetch(mediaUrl, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Sent media download error (${response.status})`);
  }

  return response.arrayBuffer();
}

// validateSentSignature is now in middleware/sentAuth.ts — import from there instead.

