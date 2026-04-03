import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'crypto';

const AES_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const HMAC_ALGORITHM = 'sha256';
const KEY_LENGTH = 32;

/**
 * AES-256-GCM encrypt.
 * Returns: IV (12 bytes) || ciphertext || authTag (16 bytes)
 */
export function encrypt(plaintext: Buffer, key: Buffer): Buffer {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Encryption key must be ${KEY_LENGTH} bytes, got ${key.length}`);
  }

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(AES_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, encrypted, authTag]);
}

/**
 * AES-256-GCM decrypt.
 * Input: IV (12 bytes) || ciphertext || authTag (16 bytes)
 */
export function decrypt(blob: Buffer, key: Buffer): Buffer {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Decryption key must be ${KEY_LENGTH} bytes, got ${key.length}`);
  }

  if (blob.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Encrypted blob too short');
  }

  const iv = blob.subarray(0, IV_LENGTH);
  const authTag = blob.subarray(blob.length - AUTH_TAG_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH, blob.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(AES_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * HMAC-SHA256 sign.
 * Prepends the kid to the data before signing so the kid is authenticated.
 */
export function sign(data: Buffer, key: Buffer, kid: string): Buffer {
  const hmac = createHmac(HMAC_ALGORITHM, key);
  hmac.update(kid);
  hmac.update(data);
  return hmac.digest();
}

/**
 * HMAC-SHA256 verify (constant-time comparison).
 */
export function verify(data: Buffer, signature: Buffer, key: Buffer, kid: string): boolean {
  const expected = sign(data, key, kid);
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(expected, signature);
}

export { KEY_LENGTH };
