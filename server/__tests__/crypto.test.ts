import { describe, expect, test } from 'bun:test';
import { deriveKeys, encrypt, decrypt, sign, verify, KEY_LENGTH } from '../crypto';
import { randomBytes } from 'crypto';

describe('deriveKeys', () => {
  test('derives 32-byte encryption key and 48-byte signing key', () => {
    const masterKey = randomBytes(KEY_LENGTH);
    const { encryptionKey, signingKey } = deriveKeys(masterKey);
    expect(encryptionKey.length).toBe(32);
    expect(signingKey.length).toBe(48);
  });

  test('same master key produces same derived keys', () => {
    const masterKey = randomBytes(KEY_LENGTH);
    const a = deriveKeys(masterKey);
    const b = deriveKeys(masterKey);
    expect(Buffer.compare(a.encryptionKey, b.encryptionKey)).toBe(0);
    expect(Buffer.compare(a.signingKey, b.signingKey)).toBe(0);
  });

  test('different master keys produce different derived keys', () => {
    const a = deriveKeys(randomBytes(KEY_LENGTH));
    const b = deriveKeys(randomBytes(KEY_LENGTH));
    expect(Buffer.compare(a.encryptionKey, b.encryptionKey)).not.toBe(0);
    expect(Buffer.compare(a.signingKey, b.signingKey)).not.toBe(0);
  });

  test('encryption and signing keys are not interchangeable', () => {
    const { signingKey } = deriveKeys(randomBytes(KEY_LENGTH));
    const plaintext = Buffer.from('test');
    // Signing key must not work for encryption (wrong size for AES-256)
    expect(() => encrypt(plaintext, signingKey)).toThrow();
  });

  test('rejects invalid master key length', () => {
    expect(() => deriveKeys(randomBytes(32))).toThrow('48 bytes');
  });
});

describe('encrypt/decrypt', () => {
  const { encryptionKey } = deriveKeys(randomBytes(KEY_LENGTH));

  test('round-trip returns original plaintext', () => {
    const plaintext = Buffer.from('hello world');
    const encrypted = encrypt(plaintext, encryptionKey);
    const decrypted = decrypt(encrypted, encryptionKey);
    expect(decrypted.toString()).toBe('hello world');
  });

  test('different encryptions of same plaintext produce different ciphertexts', () => {
    const plaintext = Buffer.from('deterministic?');
    const a = encrypt(plaintext, encryptionKey);
    const b = encrypt(plaintext, encryptionKey);
    expect(Buffer.compare(a, b)).not.toBe(0);
  });

  test('wrong key fails to decrypt', () => {
    const plaintext = Buffer.from('secret');
    const encrypted = encrypt(plaintext, encryptionKey);
    const { encryptionKey: wrongKey } = deriveKeys(randomBytes(KEY_LENGTH));
    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  test('tampered ciphertext fails to decrypt', () => {
    const plaintext = Buffer.from('secret');
    const encrypted = encrypt(plaintext, encryptionKey);
    encrypted[20] ^= 0xff; // flip a byte
    expect(() => decrypt(encrypted, encryptionKey)).toThrow();
  });

  test('rejects invalid key length', () => {
    expect(() => encrypt(Buffer.from('x'), Buffer.alloc(16))).toThrow('32 bytes');
    expect(() => decrypt(Buffer.alloc(30), Buffer.alloc(16))).toThrow('32 bytes');
  });

  test('rejects blob that is too short', () => {
    expect(() => decrypt(Buffer.alloc(20), encryptionKey)).toThrow('too short');
  });
});

describe('sign/verify', () => {
  const { signingKey } = deriveKeys(randomBytes(KEY_LENGTH));

  test('round-trip signature verification', () => {
    const data = Buffer.from('some data');
    const kid = 'key-123';
    const signature = sign(data, signingKey, kid);
    expect(verify(data, signature, signingKey, kid)).toBe(true);
  });

  test('wrong key fails verification', () => {
    const data = Buffer.from('some data');
    const kid = 'key-123';
    const signature = sign(data, signingKey, kid);
    const { signingKey: wrongKey } = deriveKeys(randomBytes(KEY_LENGTH));
    expect(verify(data, signature, wrongKey, kid)).toBe(false);
  });

  test('wrong kid fails verification', () => {
    const data = Buffer.from('some data');
    const signature = sign(data, signingKey, 'key-123');
    expect(verify(data, signature, signingKey, 'key-456')).toBe(false);
  });

  test('tampered data fails verification', () => {
    const data = Buffer.from('some data');
    const kid = 'key-123';
    const signature = sign(data, signingKey, kid);
    const tampered = Buffer.from('other data');
    expect(verify(tampered, signature, signingKey, kid)).toBe(false);
  });

  test('tampered signature fails verification', () => {
    const data = Buffer.from('some data');
    const kid = 'key-123';
    const signature = sign(data, signingKey, kid);
    signature[0] ^= 0xff;
    expect(verify(data, signature, signingKey, kid)).toBe(false);
  });
});
