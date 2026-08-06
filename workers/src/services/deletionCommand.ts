/**
 * The "delete my data" conversation command (PRD 3.7).
 *
 * DELIBERATELY NOT AN LLM INTENT. Every other command routes through
 * `classifyIntent` (DeepSeek), which is the right tool for "that seems high" or
 * "what about Genesis". It is the wrong tool for an irreversible destruction of
 * someone's account: a misclassification of `stop` or `status` as `delete` is
 * unrecoverable, and the model does not need to be wrong often for that to be
 * unacceptable. Matching is exact-phrase, and destruction additionally requires
 * a second message containing a literal token the user has to type.
 */

/** KV key holding "this user asked to delete, awaiting confirmation". */
export const DELETE_PENDING_PREFIX = 'delete_pending:';

/**
 * How long the confirmation stays valid. Long enough to read the warning and
 * decide; short enough that a stray "DELETE" days later cannot destroy an
 * account whose owner has forgotten they ever asked.
 */
export const DELETE_PENDING_TTL_SECONDS = 15 * 60;

/** The token the user must send back. Uppercase so it cannot be typed by accident. */
export const DELETE_CONFIRM_TOKEN = 'DELETE';

/**
 * Phrases that START the deletion flow. Full phrases only — a bare "delete"
 * appears inside ordinary sentences ("delete that last bill") and must not arm
 * an account-destruction prompt.
 */
const REQUEST_PHRASES: readonly string[] = [
  'delete my data',
  'delete my account',
  'delete all my data',
  'delete everything',
  'erase my data',
  'erase my account',
  'forget me',
  'remove my data',
  'remove my account',
];

export function normalise(text: string): string {
  return text.trim().toLowerCase().replace(/[.!?]+$/, '').replace(/\s+/g, ' ');
}

/** Whether *text* asks to begin deletion. */
export function isDeletionRequest(text: string): boolean {
  const t = normalise(text);
  return REQUEST_PHRASES.some((p) => t === p || t.includes(p));
}

/**
 * Whether *text* is the confirmation token.
 *
 * Case-SENSITIVE on the token itself: the user is asked to reply with `DELETE`
 * in capitals, so a conversational "delete" or "yes, delete it" does not
 * qualify. Surrounding whitespace is forgiven; nothing else is.
 */
export function isDeletionConfirmation(text: string): boolean {
  return text.trim() === DELETE_CONFIRM_TOKEN;
}

/** Message asking for confirmation. States plainly what is destroyed. */
export const DELETION_PROMPT =
  "This deletes everything I hold about you — your bills, your usage history, " +
  "your plan comparisons and your Gmail connection. It can't be undone and I " +
  "won't be able to get it back.\n\n" +
  `If you're sure, reply with just: ${DELETE_CONFIRM_TOKEN}\n\n` +
  "Anything else (or nothing) and I'll leave everything as it is. If you only " +
  'want me to stop messaging, reply "stop" instead — that keeps your data so ' +
  'you can come back.';

/** Message after erasure. Last thing this phone number ever receives from us. */
export const DELETION_DONE =
  "All gone. I've deleted your bills, your usage history and your Gmail " +
  "connection — there's nothing left on my side. Thanks for giving Flip a go. " +
  'If you ever want to start again, just message me.';
