import type { ConversationState, Intent, StateTransition } from '../types/conversation';

// Map each state to the valid intents (commands) for that state
const VALID_COMMANDS: Record<ConversationState, Intent[]> = {
  NEW: ['help', 'bill'],
  ONBOARDING: ['help', 'bill', 'usage', 'compare', 'status'],
  ACTIVE: ['help', 'usage', 'bill', 'compare', 'switch', 'status', 'stop'],
  AWAITING_BILL: ['help', 'bill', 'status'],
  AWAITING_SWITCH_CONFIRM: ['confirm_switch', 'decline', 'help', 'status'],
  SWITCHING: ['help', 'status', 'stop'],
  INACTIVE: ['help', 'bill'],
  UNSUBSCRIBED: ['help'],
};

// State transition map
const TRANSITIONS: Record<ConversationState, Partial<Record<Intent, ConversationState>>> = {
  NEW: { bill: 'ONBOARDING', help: 'NEW' },
  ONBOARDING: {
    bill: 'ACTIVE',
    help: 'AWAITING_BILL',
    usage: 'AWAITING_BILL',
    compare: 'AWAITING_BILL',
    status: 'AWAITING_BILL',
  },
  ACTIVE: {
    help: 'ACTIVE',
    usage: 'ACTIVE',
    bill: 'ACTIVE',
    compare: 'AWAITING_SWITCH_CONFIRM',
    switch: 'AWAITING_SWITCH_CONFIRM',
    status: 'ACTIVE',
    stop: 'UNSUBSCRIBED',
  },
  AWAITING_BILL: { bill: 'ACTIVE', help: 'AWAITING_BILL', status: 'AWAITING_BILL' },
  AWAITING_SWITCH_CONFIRM: {
    confirm_switch: 'SWITCHING',
    decline: 'ACTIVE',
    help: 'AWAITING_SWITCH_CONFIRM',
    status: 'AWAITING_SWITCH_CONFIRM',
  },
  SWITCHING: { help: 'SWITCHING', status: 'SWITCHING', stop: 'UNSUBSCRIBED' },
  INACTIVE: { bill: 'ACTIVE', help: 'INACTIVE' },
  UNSUBSCRIBED: { help: 'NEW' },
};

// User-facing messages for transitions
const RESPONSE_MESSAGES: Record<string, string> = {
  welcome: "Hey! I'm Flip. I monitor your power bills and let you know if you could save money by switching plans. No apps, no websites — just send me a power bill to get started.",

  new_bill_received: "Got it! I'll analyse your bill and get back to you shortly. This usually takes less than a minute.",

  help_default: "I can help you with:\n• Send a bill — just forward a PDF or photo\n• \"usage\" — see your power usage summary\n• \"compare\" — check if you could save by switching\n• \"status\" — see what's happening with your account\n• \"stop\" — unsubscribe anytime\n\nWhat would you like to do?",

  help_onboarding: "I'm ready when you are! Just send me a photo or PDF of your latest power bill and I'll start monitoring for you.",

  help_awaiting_bill: "I'm waiting for that bill you mentioned. Just send it through whenever you're ready!",

  usage_no_data: "I don't have any bills for you yet. Send me your first bill and I'll start tracking your usage.",

  compare_prompt: "Let me check the best plans for you. Give me a moment...",

  switch_confirm_prompt: "Would you like me to switch you? Reply 'yes' to confirm or 'no' to stay where you are.",

  switch_confirmed: "Great! I'm processing your switch now. I'll keep you updated on progress.",

  switch_declined: "No worries — staying where you are is often the smart choice. I'll keep watching your bills and let you know if anything changes.",

  stop_goodbye: "You're all unsubscribed. If you ever want to come back, just send me a message. Take care!",

  invalid_transition: "Sorry, I can't do that right now. Type \"help\" to see what's available.",

  status_default: "I'm keeping an eye on your bills. I'll let you know if there's a chance to save.",
};

interface TransitionContext {
  readonly comparisonAvailable?: boolean;
}

const KV_KEY_PREFIX = 'state:';
const KV_TTL_SECONDS = 180 * 24 * 60 * 60; // 180 days

// Pure function: validate a transition, return next state or Error
export function validateTransition(
  state: ConversationState,
  intent: Intent
): ConversationState | Error {
  const nextState = TRANSITIONS[state]?.[intent];
  if (!nextState) {
    return new Error(`Invalid transition: ${state} + ${intent}`);
  }
  return nextState;
}

// Check if intent is valid for current state
export function isValidIntent(state: ConversationState, intent: Intent): boolean {
  return VALID_COMMANDS[state]?.includes(intent) ?? false;
}

// Get current state from KV
export async function getState(
  kv: KVNamespace,
  userId: string
): Promise<ConversationState> {
  const key = `${KV_KEY_PREFIX}${userId}`;
  const raw = await kv.get(key);
  if (!raw) return 'NEW';
  return raw as ConversationState;
}

// Set state in KV
export async function setState(
  kv: KVNamespace,
  userId: string,
  state: ConversationState
): Promise<void> {
  const key = `${KV_KEY_PREFIX}${userId}`;
  await kv.put(key, state, { expirationTtl: KV_TTL_SECONDS });
}

// Perform a full transition: validate, persist, return response
export async function transition(
  kv: KVNamespace,
  userId: string,
  intent: Intent,
  ctx?: TransitionContext
): Promise<StateTransition> {
  const from = await getState(kv, userId);
  const nextState = validateTransition(from, intent);

  if (nextState instanceof Error) {
    return {
      from,
      to: from, // stay in current state
      message: RESPONSE_MESSAGES.invalid_transition!,
    };
  }

  // Persist new state
  await setState(kv, userId, nextState);

  // Determine response message
  let message: string;
  switch (nextState) {
    case 'ONBOARDING':
      message = RESPONSE_MESSAGES.welcome!;
      break;
    case 'ACTIVE':
      if (intent === 'bill') message = RESPONSE_MESSAGES.new_bill_received!;
      else if (intent === 'help') message = RESPONSE_MESSAGES.help_default!;
      else if (intent === 'usage') message = RESPONSE_MESSAGES.usage_no_data!;
      else message = RESPONSE_MESSAGES.status_default!;
      break;
    case 'AWAITING_SWITCH_CONFIRM':
      message = RESPONSE_MESSAGES.switch_confirm_prompt!;
      break;
    case 'SWITCHING':
      message = RESPONSE_MESSAGES.switch_confirmed!;
      break;
    case 'AWAITING_BILL':
      message = RESPONSE_MESSAGES.help_awaiting_bill!;
      break;
    case 'UNSUBSCRIBED':
      message = RESPONSE_MESSAGES.stop_goodbye!;
      break;
    default:
      message = RESPONSE_MESSAGES.status_default!;
  }

  return { from, to: nextState, message };
}

// New user onboarding
export async function handleNewUser(
  kv: KVNamespace,
  userId: string,
  _phone: string
): Promise<ConversationState> {
  await setState(kv, userId, 'ONBOARDING');
  return 'ONBOARDING';
}

// Get welcome message
export function getWelcomeMessage(): string {
  return RESPONSE_MESSAGES.welcome!;
}
