import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, generatePhoneHash } from './encryption';

/**
 * `encryption.ts` protects every piece of PII the product holds — phone numbers,
 * names, email addresses, ICP numbers, installation addresses, message bodies
 * and OAuth tokens — and had no test file at all.
 */

/** Exactly what DEPLOY.md tells the operator to run: `openssl rand -hex 32`. */
const HEX_KEY = 'a3f1c8d92b74e05f6a1d3c8e9b204f7a5d6e8c1b0a2f4d6e8c0b2a4f6d8e0c2b';
/** The format the code previously accepted, and what production is provisioned with. */
const BASE64_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7 % 256)));

describe('ENCRYPTION_KEY format', () => {
  /**
   * THE regression test. Both setup docs say hex, the code only ran `atob`, and
   * all 64 characters of a hex key are legal base64 — so it decoded silently to
   * 48 bytes and importKey threw `Invalid key length` on EVERY encrypt and
   * decrypt. A deployment provisioned exactly as documented could not create a
   * single user.
   */
  it('accepts a hex key — the format both DEPLOY.md and TESTING_RUN.md document', async () => {
    const ciphertext = await encrypt('+64211234567', HEX_KEY);
    expect(await decrypt(ciphertext, HEX_KEY)).toBe('+64211234567');
  });

  it('still accepts a base64 key — what production is already provisioned with', async () => {
    const ciphertext = await encrypt('+64211234567', BASE64_KEY);
    expect(await decrypt(ciphertext, BASE64_KEY)).toBe('+64211234567');
  });

  it('rejects a wrong-length key with an actionable message', async () => {
    // The native error is "Invalid key length" — it names neither the secret
    // nor the fix, which is why the original mis-provisioning was hard to spot.
    await expect(encrypt('x', 'abcdef')).rejects.toThrow(/ENCRYPTION_KEY decodes to/);
    await expect(encrypt('x', 'abcdef')).rejects.toThrow(/openssl rand -hex 32/);
  });
});

describe('encrypt / decrypt', () => {
  it('round-trips unicode and empty strings', async () => {
    for (const value of ['', 'Ngā mihi', '14 Bishopgate St, Birkdale', '0000217356UN03B']) {
      expect(await decrypt(await encrypt(value, HEX_KEY), HEX_KEY)).toBe(value);
    }
  });

  it('produces a different ciphertext each time for the same plaintext', async () => {
    // A fresh random IV per encryption. Identical ciphertexts would let anyone
    // with read access to D1 tell which users share a phone number or address.
    const a = await encrypt('+64211234567', HEX_KEY);
    const b = await encrypt('+64211234567', HEX_KEY);
    expect(a).not.toBe(b);
    expect(await decrypt(a, HEX_KEY)).toBe(await decrypt(b, HEX_KEY));
  });

  it('rejects a tampered ciphertext rather than returning garbage', async () => {
    // GCM is authenticated: a flipped byte must fail, not silently decrypt.
    const ciphertext = await encrypt('+64211234567', HEX_KEY);
    const raw = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 0xff;
    const tampered = btoa(String.fromCharCode(...raw));
    await expect(decrypt(tampered, HEX_KEY)).rejects.toThrow();
  });

  it('cannot be decrypted with a different key', async () => {
    const ciphertext = await encrypt('+64211234567', HEX_KEY);
    await expect(decrypt(ciphertext, BASE64_KEY)).rejects.toThrow();
  });
});

describe('generatePhoneHash (blind index)', () => {
  it('is deterministic, so lookup by phone works across requests', async () => {
    expect(await generatePhoneHash('+64211234567')).toBe(await generatePhoneHash('+64211234567'));
  });

  it('normalises case and surrounding whitespace', async () => {
    const canonical = await generatePhoneHash('+64211234567');
    expect(await generatePhoneHash('  +64211234567  ')).toBe(canonical);
  });

  it('separates different numbers', async () => {
    expect(await generatePhoneHash('+64211234567')).not.toBe(await generatePhoneHash('+64211234568'));
  });

  it('returns a 64-char lowercase hex SHA-256 digest', async () => {
    expect(await generatePhoneHash('+64211234567')).toMatch(/^[0-9a-f]{64}$/);
  });
});
