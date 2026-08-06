// AES-256-GCM encryption/decryption for PII fields
// Uses WebCrypto API available in Cloudflare Workers

const keyCache = new Map<string, CryptoKey>();

/** Byte lengths AES accepts. Anything else is a mis-provisioned secret. */
const VALID_AES_KEY_BYTES = new Set([16, 24, 32]);

/**
 * Decode the ENCRYPTION_KEY secret to raw bytes, accepting HEX or BASE64.
 *
 * This used to be `atob()` only, while BOTH setup docs said hex
 * (`openssl rand -hex 32`, DEPLOY.md; "32-byte hex", TESTING_RUN.md). A key
 * generated exactly as documented is 64 hex characters — every one of which is
 * also a legal base64 character, so `atob` did NOT reject it. It quietly decoded
 * to 48 bytes and `importKey` threw `Invalid key length` on every encrypt and
 * decrypt, surfacing as an opaque 500 from whatever route touched PII first. A
 * deployment provisioned by the book could not create a single user.
 *
 * Rather than pick a winner and leave the other format as a trap, accept both.
 * The two are unambiguous by length: a base64 AES-256 key is 43-44 characters,
 * a hex one is exactly 64.
 */
function decodeMasterKey(masterKey: string): Uint8Array<ArrayBuffer> {
  const trimmed = masterKey.trim();

  const isHex = trimmed.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(trimmed);
  const values = isHex
    ? (trimmed.match(/../g) ?? []).map((b) => parseInt(b, 16))
    : [...atob(trimmed)].map((c) => c.charCodeAt(0));
  const bytes = new Uint8Array(new ArrayBuffer(values.length));
  bytes.set(values);

  if (!VALID_AES_KEY_BYTES.has(bytes.length)) {
    // Fail with something actionable. The native error is "Invalid key length",
    // which says nothing about WHICH secret or what to do about it.
    throw new Error(
      `ENCRYPTION_KEY decodes to ${bytes.length} bytes; AES needs 16, 24 or 32. ` +
      `Generate one with: openssl rand -hex 32`
    );
  }
  return bytes;
}

/**
 * Derive a CryptoKey from the ENCRYPTION_KEY secret (hex or base64, 256-bit).
 * Results are cached at the module level to avoid re-derivation on every operation.
 */
async function deriveKey(masterKey: string): Promise<CryptoKey> {
  const cached = keyCache.get(masterKey);
  if (cached) return cached;

  const key = await crypto.subtle.importKey(
    'raw',
    decodeMasterKey(masterKey),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
  keyCache.set(masterKey, key);
  return key;
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns base64-encoded iv + ciphertext (iv is first 12 bytes).
 */
export async function encrypt(
  plaintext: string,
  encryptionKey: string
): Promise<string> {
  const key = await deriveKey(encryptionKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded
  );

  // Prepend iv to ciphertext, then base64 encode the combined buffer
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt a ciphertext string (base64-encoded iv + ciphertext) using AES-256-GCM.
 */
export async function decrypt(
  ciphertext: string,
  encryptionKey: string
): Promise<string> {
  const key = await deriveKey(encryptionKey);
  const combined = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );

  return new TextDecoder().decode(plaintext);
}

/**
 * Generate a deterministic SHA-256 hash of a phone number for use as a blind index.
 * No salt — deterministic so the same phone always produces the same hash for lookup.
 * Returns lowercase hex-encoded SHA-256 digest.
 */
export async function generatePhoneHash(phone: string): Promise<string> {
  const encoded = new TextEncoder().encode(phone.trim().toLowerCase());
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Environment shape expected by model functions.
 */
export interface EncryptionEnv {
  readonly ENCRYPTION_KEY: string;
}
