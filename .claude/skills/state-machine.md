# State Machine Skill

## Purpose
Modify Flip's conversation state machine — adding states, transitions, or valid commands. The state machine is the backbone of Flip's conversational logic and must be modified carefully.

## State Machine Location
- Implementation: `workers/src/services/conversation.ts`
- Tests: `workers/src/services/conversation.test.ts`
- Documentation: `docs/ARCHITECTURE.md` § "Conversation State Machine"

## Current States (8)
```
NEW → ONBOARDING → ACTIVE (free_tier | paid)
ACTIVE → AWAITING_BILL (user said they'd send one)
ACTIVE → AWAITING_SWITCH_CONFIRM (plan recommended)
AWAITING_SWITCH_CONFIRM → SWITCHING (user confirms)
SWITCHING → ACTIVE (switch complete)
ACTIVE → INACTIVE (6+ months no bills)
ACTIVE → UNSUBSCRIBED (user texted "stop")
```

## Workflow for Adding a State

### 1. Define the State
- What is the new state called? (UPPER_SNAKE_CASE)
- What triggers entry into this state?
- What user commands are valid in this state?
- What happens when an invalid command is received?
- What triggers exit from this state, and into which state(s)?

### 2. Update the State Enum
In `workers/src/services/conversation.ts`:
```typescript
export const ConversationState = {
  NEW: "NEW",
  ONBOARDING: "ONBOARDING",
  ACTIVE: "ACTIVE",
  AWAITING_BILL: "AWAITING_BILL",
  AWAITING_SWITCH_CONFIRM: "AWAITING_SWITCH_CONFIRM",
  SWITCHING: "SWITCHING",
  INACTIVE: "INACTIVE",
  UNSUBSCRIBED: "UNSUBSCRIBED",
  // Add new state here
} as const;
```

### 3. Define Valid Commands
```typescript
const VALID_COMMANDS: Record<ConversationState, Intent[]> = {
  [ConversationState.NEW]: ["help"],
  [ConversationState.ONBOARDING]: ["help", "bill"],
  // Add new state's valid commands
};
```

### 4. Define Transitions
```typescript
const TRANSITIONS: Record<ConversationState, Partial<Record<Intent, ConversationState>>> = {
  // Add allowed transitions from the new state
  // Add allowed transitions INTO the new state from other states
};
```

### 5. Add Transition Validation
```typescript
export function validateTransition(
  currentState: ConversationState,
  intent: Intent
): ConversationState | Error {
  const nextState = TRANSITIONS[currentState]?.[intent];
  if (!nextState) {
    return new Error(`Invalid transition: ${currentState} + ${intent}`);
  }
  return nextState;
}
```

### 6. Update Tests
In `workers/src/services/conversation.test.ts`:

Add valid transitions:
```typescript
it('allows valid transition: {from} + {command} → {to}', () => {
  const result = validateTransition(ConversationState.FROM, "command");
  expect(result).toBe(ConversationState.TO);
});
```

Add invalid transitions:
```typescript
it('rejects invalid transition: {from} + {command}', () => {
  const result = validateTransition(ConversationState.FROM, "invalid_command");
  expect(result).toBeInstanceOf(Error);
});
```

### 7. Update Side Effects
If the new state requires side effects (sending a message, enqueuing a job, updating KV), implement them in the state transition handler:
```typescript
async function handleTransition(
  ctx: Context,
  user: User,
  from: ConversationState,
  to: ConversationState,
  intent: Intent
): Promise<void> {
  // Handle side effects for the new state
  switch (to) {
    case ConversationState.NEW_STATE:
      await ctx.env.KV.put(`state:${user.id}`, to);
      // Add state-specific logic
      break;
  }
}
```

### 8. Update Documentation
Update the state machine diagram and table in `docs/ARCHITECTURE.md`.

## Rules
- Every valid transition must have a corresponding test.
- At least one invalid transition per state must be tested.
- State is always stored in KV (not D1) for sub-millisecond access.
- State transitions must be atomic (KV put + any side effects).
- Invalid transitions must be logged (with state, intent, user_id) but never exposed to the user.
- The user should receive a helpful message for invalid commands ("Sorry, I can't do that right now. You can ask me to...")
- State changes that affect subscription tier or switching must log an audit event.

## Testing Checklist
Before merging a state machine change:
- [ ] All valid transitions tested (exhaustive: from the new state + into the new state)
- [ ] Invalid transitions rejected with Error
- [ ] Side effects verified (KV writes, queue messages, outbound messages)
- [ ] State machine diagram updated in ARCHITECTURE.md
- [ ] Full test suite passing
