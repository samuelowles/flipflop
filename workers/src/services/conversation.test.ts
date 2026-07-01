import { describe, it, expect, vi } from 'vitest';
import {
  validateTransition,
  isValidIntent,
  canTransition,
  allowedTargets,
  getWelcomeMessage,
  getState,
  setState,
  assertCanTransition,
  ConversationError,
  transition,
} from './conversation';
import type { ConversationState, Intent } from '../types/conversation';

describe('Conversation State Machine', () => {
  describe('validateTransition (pure function)', () => {
    // Test every valid transition
    const validTransitions: Array<[ConversationState, Intent, ConversationState]> = [
      ['NEW', 'bill', 'ONBOARDING'],
      ['NEW', 'help', 'NEW'],
      ['ONBOARDING', 'bill', 'ACTIVE'],
      ['ONBOARDING', 'help', 'AWAITING_BILL'],
      ['ONBOARDING', 'usage', 'AWAITING_BILL'],
      ['ONBOARDING', 'compare', 'AWAITING_BILL'],
      ['ONBOARDING', 'status', 'AWAITING_BILL'],
      ['ACTIVE', 'help', 'ACTIVE'],
      ['ACTIVE', 'usage', 'ACTIVE'],
      ['ACTIVE', 'bill', 'ACTIVE'],
      ['ACTIVE', 'compare', 'AWAITING_SWITCH_CONFIRM'],
      ['ACTIVE', 'switch', 'AWAITING_SWITCH_CONFIRM'],
      ['ACTIVE', 'status', 'ACTIVE'],
      ['ACTIVE', 'stop', 'UNSUBSCRIBED'],
      ['AWAITING_BILL', 'bill', 'ACTIVE'],
      ['AWAITING_BILL', 'help', 'AWAITING_BILL'],
      ['AWAITING_BILL', 'status', 'AWAITING_BILL'],
      ['AWAITING_SWITCH_CONFIRM', 'confirm_switch', 'SWITCHING'],
      ['AWAITING_SWITCH_CONFIRM', 'decline', 'ACTIVE'],
      ['AWAITING_SWITCH_CONFIRM', 'help', 'AWAITING_SWITCH_CONFIRM'],
      ['AWAITING_SWITCH_CONFIRM', 'status', 'AWAITING_SWITCH_CONFIRM'],
      ['SWITCHING', 'help', 'SWITCHING'],
      ['SWITCHING', 'status', 'SWITCHING'],
      ['SWITCHING', 'stop', 'UNSUBSCRIBED'],
      ['INACTIVE', 'bill', 'ACTIVE'],
      ['INACTIVE', 'help', 'INACTIVE'],
      ['UNSUBSCRIBED', 'help', 'NEW'],
    ];

    it.each(validTransitions)('%s + %s -> %s', (from, intent, expectedTo) => {
      const result = validateTransition(from, intent);
      expect(result).not.toBeInstanceOf(Error);
      expect(result).toBe(expectedTo);
    });

    // Test that every valid transition is unique (no duplicates in the map)
    it('has no duplicate transitions', () => {
      const seen = new Set<string>();
      for (const [from, intent] of validTransitions) {
        const key = `${from}:${intent}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    });

    // Test invalid transitions
    const invalidTransitions: Array<[ConversationState, Intent]> = [
      ['NEW', 'usage'],
      ['NEW', 'switch'],
      ['NEW', 'stop'],
      ['NEW', 'confirm_switch'],
      ['NEW', 'decline'],
      ['NEW', 'compare'],
      ['NEW', 'status'],
      ['ONBOARDING', 'switch'],
      ['ONBOARDING', 'stop'],
      ['ONBOARDING', 'confirm_switch'],
      ['ACTIVE', 'unknown'],
      ['ACTIVE', 'confirm_switch'],
      ['ACTIVE', 'decline'],
      ['AWAITING_BILL', 'switch'],
      ['AWAITING_BILL', 'stop'],
      ['AWAITING_BILL', 'compare'],
      ['AWAITING_BILL', 'usage'],
      ['AWAITING_SWITCH_CONFIRM', 'bill'],
      ['AWAITING_SWITCH_CONFIRM', 'stop'],
      ['AWAITING_SWITCH_CONFIRM', 'switch'],
      ['AWAITING_SWITCH_CONFIRM', 'usage'],
      ['SWITCHING', 'bill'],
      ['SWITCHING', 'compare'],
      ['SWITCHING', 'switch'],
      ['SWITCHING', 'usage'],
      ['INACTIVE', 'switch'],
      ['INACTIVE', 'stop'],
      ['INACTIVE', 'compare'],
      ['UNSUBSCRIBED', 'bill'],
      ['UNSUBSCRIBED', 'stop'],
      ['UNSUBSCRIBED', 'compare'],
      ['UNSUBSCRIBED', 'usage'],
    ];

    it.each(invalidTransitions)('%s + %s -> Error', (from, intent) => {
      const result = validateTransition(from, intent);
      expect(result).toBeInstanceOf(Error);
    });

    it('returns an Error with descriptive message for invalid transitions', async () => {
      const result = validateTransition('NEW', 'switch');
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain('Invalid transition');
      expect((result as Error).message).toContain('NEW');
      expect((result as Error).message).toContain('switch');
    });
  });

  describe('isValidIntent', () => {
    it('returns true for valid intents in each state', () => {
      expect(isValidIntent('ACTIVE', 'help')).toBe(true);
      expect(isValidIntent('ACTIVE', 'compare')).toBe(true);
      expect(isValidIntent('ACTIVE', 'usage')).toBe(true);
      expect(isValidIntent('ACTIVE', 'bill')).toBe(true);
      expect(isValidIntent('ACTIVE', 'switch')).toBe(true);
      expect(isValidIntent('ACTIVE', 'status')).toBe(true);
      expect(isValidIntent('ACTIVE', 'stop')).toBe(true);
      expect(isValidIntent('ONBOARDING', 'bill')).toBe(true);
      expect(isValidIntent('ONBOARDING', 'help')).toBe(true);
      expect(isValidIntent('ONBOARDING', 'usage')).toBe(true);
      expect(isValidIntent('ONBOARDING', 'compare')).toBe(true);
      expect(isValidIntent('ONBOARDING', 'status')).toBe(true);
      expect(isValidIntent('NEW', 'help')).toBe(true);
      expect(isValidIntent('NEW', 'bill')).toBe(true);
      expect(isValidIntent('AWAITING_SWITCH_CONFIRM', 'confirm_switch')).toBe(true);
      expect(isValidIntent('AWAITING_SWITCH_CONFIRM', 'decline')).toBe(true);
      expect(isValidIntent('UNSUBSCRIBED', 'help')).toBe(true);
    });

    it('returns false for invalid intents in each state', () => {
      expect(isValidIntent('ACTIVE', 'unknown')).toBe(false);
      expect(isValidIntent('ACTIVE', 'decline')).toBe(false);
      expect(isValidIntent('ACTIVE', 'confirm_switch')).toBe(false);
      expect(isValidIntent('ONBOARDING', 'switch')).toBe(false);
      expect(isValidIntent('ONBOARDING', 'unknown')).toBe(false);
      expect(isValidIntent('NEW', 'switch')).toBe(false);
      expect(isValidIntent('UNSUBSCRIBED', 'bill')).toBe(false);
      expect(isValidIntent('UNSUBSCRIBED', 'stop')).toBe(false);
      expect(isValidIntent('SWITCHING', 'bill')).toBe(false);
      expect(isValidIntent('INACTIVE', 'switch')).toBe(false);
      expect(isValidIntent('AWAITING_BILL', 'switch')).toBe(false);
    });
  });

  const ALL_STATES: ConversationState[] = [
    'NEW',
    'ONBOARDING',
    'ACTIVE',
    'AWAITING_BILL',
    'AWAITING_SWITCH_CONFIRM',
    'SWITCHING',
    'INACTIVE',
    'UNSUBSCRIBED',
  ];

  describe('canTransition / allowedTargets', () => {
    const ALL_INTENTS: Intent[] = [
      'help', 'usage', 'bill', 'compare', 'switch',
      'confirm_switch', 'decline', 'status', 'stop', 'unknown',
    ];

    // Allowed target states per source state, derived from TRANSITIONS
    const expectedAdjacency: Record<ConversationState, ConversationState[]> = {
      NEW: ['ONBOARDING', 'NEW'],
      ONBOARDING: ['ACTIVE', 'AWAITING_BILL'],
      ACTIVE: ['ACTIVE', 'AWAITING_SWITCH_CONFIRM', 'UNSUBSCRIBED'],
      AWAITING_BILL: ['ACTIVE', 'AWAITING_BILL'],
      AWAITING_SWITCH_CONFIRM: ['SWITCHING', 'ACTIVE', 'AWAITING_SWITCH_CONFIRM'],
      SWITCHING: ['SWITCHING', 'UNSUBSCRIBED'],
      INACTIVE: ['ACTIVE', 'INACTIVE'],
      UNSUBSCRIBED: ['NEW'],
    };

    it('allowedTargets returns the correct adjacency list for every state', () => {
      for (const state of ALL_STATES) {
        const targets = allowedTargets(state).sort();
        const expected = [...expectedAdjacency[state]].sort();
        expect(targets).toEqual(expected);
      }
    });

    // Exhaustive 8x8 (64-pair) coverage of canTransition
    it.each(ALL_STATES.flatMap((from) => ALL_STATES.map((to) => [from, to] as const)))(
      'canTransition(%s, %s)',
      (from, to) => {
        const allowed = expectedAdjacency[from].includes(to);
        expect(canTransition(from, to)).toBe(allowed);
      }
    );

    it('canTransition is reflexive where a state has a self-loop, false otherwise', () => {
      for (const state of ALL_STATES) {
        const selfLoop = expectedAdjacency[state].includes(state);
        expect(canTransition(state, state)).toBe(selfLoop);
      }
    });

    // Mirror test: canTransition parity with TRANSITIONS via validateTransition
    it('mirrors TRANSITIONS — every reachable (from,intent,to) is canTransition-true', () => {
      for (const from of ALL_STATES) {
        for (const intent of ALL_INTENTS) {
          const result = validateTransition(from, intent);
          if (!(result instanceof Error)) {
            expect(canTransition(from, result)).toBe(true);
          }
        }
      }
    });

    // Mirror test: parity with VALID_COMMANDS — allowedTargets is a subset of
    // states reachable through any command the state accepts
    it('mirrors VALID_COMMANDS — every command-accepted transition target is allowed', () => {
      for (const from of ALL_STATES) {
        for (const intent of ALL_INTENTS) {
          if (isValidIntent(from, intent)) {
            const result = validateTransition(from, intent);
            if (!(result instanceof Error)) {
              expect(canTransition(from, result)).toBe(true);
            }
          }
        }
      }
    });
  });

  describe('getWelcomeMessage', () => {
    it('returns a welcome message in NZ English', () => {
      const msg = getWelcomeMessage();
      expect(msg).toContain("Hey!");
      expect(msg).toContain("Flip");
    });

    it('is at least 50 characters long', () => {
      const msg = getWelcomeMessage();
      expect(msg.length).toBeGreaterThan(50);
    });

    it('mentions power bills', () => {
      const msg = getWelcomeMessage();
      expect(msg).toMatch(/power bill/i);
    });

    it('does not contain emojis (SMS compatibility)', () => {
      const msg = getWelcomeMessage();
      expect(msg).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
    });

    it('is a non-empty string', () => {
      const msg = getWelcomeMessage();
      expect(msg).toBeTruthy();
      expect(typeof msg).toBe('string');
    });
  });

  describe('getState (KV-backed)', () => {
    it('returns NEW when no state exists in KV', async () => {
      // Minimal mock KV that returns null for get
      const kv = {
        get: async (_key: string) => null,
      } as unknown as KVNamespace;

      const state = await getState(kv, 'user-001');
      expect(state).toBe('NEW');
    });

    it('returns stored state from KV', async () => {
      const kv = {
        get: async (_key: string) => 'ACTIVE',
      } as unknown as KVNamespace;

      const state = await getState(kv, 'user-002');
      expect(state).toBe('ACTIVE');
    });

    it('uses the correct KV key prefix', async () => {
      const getSpy = vi.fn().mockResolvedValue(null);
      const kv = {
        get: getSpy,
      } as unknown as KVNamespace;

      await getState(kv, 'user-003');
      expect(getSpy).toHaveBeenCalledWith('state:user-003');
    });
  });

  describe('setState (KV-backed)', () => {
    it('writes state to KV with TTL', async () => {
      const putSpy = vi.fn().mockResolvedValue(undefined);
      const kv = {
        put: putSpy,
      } as unknown as KVNamespace;

      await setState(kv, 'user-001', 'ACTIVE');

      expect(putSpy).toHaveBeenCalledTimes(1);
      const [key, value, options] = putSpy.mock.calls[0] as [string, string, { expirationTtl: number }];
      expect(key).toBe('state:user-001');
      expect(value).toBe('ACTIVE');
      expect(options.expirationTtl).toBeGreaterThan(0);
    });

    it('uses 180-day TTL', async () => {
      const putSpy = vi.fn().mockResolvedValue(undefined);
      const kv = {
        put: putSpy,
      } as unknown as KVNamespace;

      await setState(kv, 'user-002', 'INACTIVE');

      const [, , options] = putSpy.mock.calls[0] as [string, string, { expirationTtl: number }];
      // 180 days in seconds
      expect(options.expirationTtl).toBe(180 * 24 * 60 * 60);
    });
  });

  // Issue #122: typed ConversationError + WARN audit log on invalid transition.
  // The invalid transition matrix used here mirrors the validateTransition
  // invalid pairs above; this block covers the guard's own behaviour.
  const INVALID_PAIRS: Array<[ConversationState, ConversationState]> = [
    ['NEW', 'ACTIVE'],
    ['NEW', 'UNSUBSCRIBED'],
    ['NEW', 'AWAITING_BILL'],
    ['ONBOARDING', 'SWITCHING'],
    ['ONBOARDING', 'UNSUBSCRIBED'],
    ['ONBOARDING', 'AWAITING_SWITCH_CONFIRM'],
    ['ACTIVE', 'NEW'],
    ['ACTIVE', 'ONBOARDING'],
    ['ACTIVE', 'AWAITING_BILL'],
    ['AWAITING_BILL', 'UNSUBSCRIBED'],
    ['AWAITING_BILL', 'AWAITING_SWITCH_CONFIRM'],
    ['AWAITING_BILL', 'SWITCHING'],
    ['AWAITING_SWITCH_CONFIRM', 'ONBOARDING'],
    ['AWAITING_SWITCH_CONFIRM', 'UNSUBSCRIBED'],
    ['AWAITING_SWITCH_CONFIRM', 'AWAITING_BILL'],
    ['SWITCHING', 'ACTIVE'],
    ['SWITCHING', 'AWAITING_SWITCH_CONFIRM'],
    ['SWITCHING', 'ONBOARDING'],
    ['INACTIVE', 'UNSUBSCRIBED'],
    ['INACTIVE', 'AWAITING_SWITCH_CONFIRM'],
    ['INACTIVE', 'SWITCHING'],
    ['UNSUBSCRIBED', 'ACTIVE'],
    ['UNSUBSCRIBED', 'UNSUBSCRIBED'],
    ['UNSUBSCRIBED', 'AWAITING_BILL'],
  ];

  describe('assertCanTransition / ConversationError (#122)', () => {
    it.each(INVALID_PAIRS)('throws ConversationError on invalid %s -> %s', (from, to) => {
      expect(() => assertCanTransition(from, to, 'req-123')).toThrow(ConversationError);
    });

    it.each(INVALID_PAIRS)('ConversationError carries from/to/request_id for %s -> %s', (from, to) => {
      try {
        assertCanTransition(from, to, 'req-456');
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ConversationError);
        const ce = err as ConversationError;
        expect(ce.from).toBe(from);
        expect(ce.to).toBe(to);
        expect(ce.request_id).toBe('req-456');
      }
    });

    it('does not throw for a valid transition', () => {
      expect(() => assertCanTransition('NEW', 'ONBOARDING', 'req-789')).not.toThrow();
    });

    it('ConversationError message includes from, to and request_id', () => {
      try {
        assertCanTransition('NEW', 'ACTIVE', 'req-msg');
        throw new Error('expected throw');
      } catch (err) {
        expect((err as Error).message).toContain('NEW');
        expect((err as Error).message).toContain('ACTIVE');
        expect((err as Error).message).toContain('req-msg');
      }
    });
  });

  describe('transition — invalid transition audit log (#122)', () => {
    function mockKv(state: ConversationState): KVNamespace {
      return {
        get: async () => state,
        put: async () => undefined,
      } as unknown as KVNamespace;
    }

    it('emits a structured WARN log with from/to/request_id on invalid transition', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      // 'switch' is invalid from NEW
      const result = await transition(mockKv('NEW'), 'user-1', 'switch', undefined, 'req-log-1');
      expect(logSpy).toHaveBeenCalled();
      const warnCall = logSpy.mock.calls
        .map((c) => c[0] as string)
        .map((s) => JSON.parse(s))
        .find((o) => o.level === 'warn' && o.event === 'invalid_transition');
      expect(warnCall).toBeDefined();
      expect(warnCall!.from).toBe('NEW');
      expect(warnCall!.to).toBe('NEW');
      expect(warnCall!.request_id).toBe('req-log-1');
      // Soft-return contract preserved
      expect(result.from).toBe('NEW');
      expect(result.to).toBe('NEW');
      logSpy.mockRestore();
    });

    it('does not log a warn on a valid transition', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      await transition(mockKv('NEW'), 'user-2', 'bill', undefined, 'req-log-2');
      const hasWarn = logSpy.mock.calls
        .some((c) => {
          try {
            return (JSON.parse(c[0] as string) as { level?: string }).level === 'warn';
          } catch {
            return false;
          }
        });
      expect(hasWarn).toBe(false);
      logSpy.mockRestore();
    });

    it('generates a request_id when none is provided', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      await transition(mockKv('NEW'), 'user-3', 'switch');
      const warnCall = logSpy.mock.calls
        .map((c) => c[0] as string)
        .map((s) => JSON.parse(s))
        .find((o) => o.level === 'warn' && o.event === 'invalid_transition');
      expect(warnCall).toBeDefined();
      expect(typeof warnCall!.request_id).toBe('string');
      expect(warnCall!.request_id.length).toBeGreaterThan(0);
      logSpy.mockRestore();
    });
  });
});
