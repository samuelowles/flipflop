// AES-256-GCM encryption/decryption for PII fields
// Uses WebCrypto API available in Cloudflare Workers

const keyCache = new Map<string, CryptoKey>();

/**
 * Derive a CryptoKey from the ENCRYPTION_KEY secret (base64-encoded 256-bit key).
 * Results are cached at the module level to avoid re-derivation on every operation.
 */
async function deriveKey(masterKey: string): Promise<CryptoKey> {
  const cached = keyCache.get(masterKey);
  if (cached) return cached;

  const keyData = Uint8Array.from(atob(masterKey), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
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
