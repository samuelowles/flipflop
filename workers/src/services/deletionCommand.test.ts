import { describe, it, expect } from 'vitest';
import {
  DELETE_CONFIRM_TOKEN,
  isDeletionConfirmation,
  isDeletionRequest,
} from './deletionCommand';

/**
 * This is the only irreversible command in the product. Both directions of
 * error matter and they are not symmetric: a false NEGATIVE means someone has
 * to ask twice, a false POSITIVE destroys an account. The tests below are
 * weighted accordingly.
 */

describe('isDeletionRequest', () => {
  it.each([
    'delete my data',
    'Delete My Data',
    'DELETE MY ACCOUNT',
    'delete my data.',
    'delete   my   data',
    'please delete my account',
    'erase my data',
    'forget me',
    'remove my account',
    'delete everything',
  ])('recognises %p', (text) => {
    expect(isDeletionRequest(text)).toBe(true);
  });

  it.each([
    'delete',                       // bare verb — too easy to say by accident
    'delete that last bill',        // scoped to a bill, not the account
    'can you delete the duplicate', // ditto
    'stop',                         // unsubscribe, NOT erasure
    'help',
    'compare',
    'my data',
    '',
  ])('does not arm deletion for %p', (text) => {
    expect(isDeletionRequest(text)).toBe(false);
  });
});

describe('isDeletionConfirmation', () => {
  it('accepts the exact token', () => {
    expect(isDeletionConfirmation(DELETE_CONFIRM_TOKEN)).toBe(true);
  });

  it('forgives surrounding whitespace only', () => {
    expect(isDeletionConfirmation('  DELETE  ')).toBe(true);
  });

  it.each([
    'delete',            // lowercase — the prompt asks for capitals
    'Delete',
    'yes',
    'yes, delete it',
    'DELETE MY DATA',    // the request phrase is not the confirmation
    'DELETE!',
    'confirm',
  ])('rejects %p', (text) => {
    expect(isDeletionConfirmation(text)).toBe(false);
  });

  it('cannot be satisfied by the request phrase alone', () => {
    // Guards the two-step design: one message must never both arm and fire.
    const phrases = ['delete my data', 'delete my account', 'forget me'];
    for (const p of phrases) {
      expect(isDeletionRequest(p) && isDeletionConfirmation(p)).toBe(false);
    }
  });
});
