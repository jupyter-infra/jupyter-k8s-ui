import { describe, expect, test } from 'bun:test';
import { encrypt, decrypt, sign, verify, KEY_LENGTH } from '../crypto';
import { randomBytes } from 'crypto';

describe('encrypt/decrypt', () => {
  const key = randomBytes(KEY_LENGTH);

  test('round-trip returns original plaintext', () => {
    const plaintext = Buffer.from('hello world');
    const encrypted = encrypt(plaintext, key);
    const decrypted = decrypt(encrypted, key);
    expect(decrypted.toString()).toBe('hello world');
  });

  test('round-trip with empty plaintext', () => {
    const plaintext = Buffer.alloc(0);
    const encrypted = encrypt(plaintext, key);
    const decrypted = decrypt(encrypted, key);
    expect(decrypted.length).toBe(0);
  });

  test('round-trip with large payload', () => {
    const plaintext = randomBytes(4096);
    const encrypted = encrypt(plaintext, key);
    const decrypted = decrypt(encrypted, key);
    expect(Buffer.compare(decrypted, plaintext)).toBe(0);
  });

  test('different encryptions of same plaintext produce different ciphertexts', () => {
    const plaintext = Buffer.from('deterministic?');
    const a = encrypt(plaintext, key);
    const b = encrypt(plaintext, key);
    expect(Buffer.compare(a, b)).not.toBe(0);
  });

  test('wrong key fails to decrypt', () => {
    const plaintext = Buffer.from('secret');
    const encrypted = encrypt(plaintext, key);
    const wrongKey = randomBytes(KEY_LENGTH);
    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  test('tampered ciphertext fails to decrypt', () => {
    const plaintext = Buffer.from('secret');
    const encrypted = encrypt(plaintext, key);
    encrypted[20] ^= 0xff; // flip a byte
    expect(() => decrypt(encrypted, key)).toThrow();
  });

  test('rejects invalid key length', () => {
    expect(() => encrypt(Buffer.from('x'), Buffer.alloc(16))).toThrow('32 bytes');
    expect(() => decrypt(Buffer.alloc(30), Buffer.alloc(16))).toThrow('32 bytes');
  });

  test('rejects blob that is too short', () => {
    expect(() => decrypt(Buffer.alloc(20), key)).toThrow('too short');
  });

  test('plaintext is not visible in ciphertext', () => {
    const plaintext = Buffer.from('super_secret_token_value');
    const encrypted = encrypt(plaintext, key);
    expect(encrypted.toString().includes('super_secret_token_value')).toBe(false);
  });
});

describe('sign/verify', () => {
  const key = randomBytes(KEY_LENGTH);

  test('round-trip signature verification', () => {
    const data = Buffer.from('some data');
    const kid = 'key-123';
    const signature = sign(data, key, kid);
    expect(verify(data, signature, key, kid)).toBe(true);
  });

  test('wrong key fails verification', () => {
    const data = Buffer.from('some data');
    const kid = 'key-123';
    const signature = sign(data, key, kid);
    const wrongKey = randomBytes(KEY_LENGTH);
    expect(verify(data, signature, wrongKey, kid)).toBe(false);
  });

  test('wrong kid fails verification', () => {
    const data = Buffer.from('some data');
    const signature = sign(data, key, 'key-123');
    expect(verify(data, signature, key, 'key-456')).toBe(false);
  });

  test('tampered data fails verification', () => {
    const data = Buffer.from('some data');
    const kid = 'key-123';
    const signature = sign(data, key, kid);
    const tampered = Buffer.from('other data');
    expect(verify(tampered, signature, key, kid)).toBe(false);
  });

  test('tampered signature fails verification', () => {
    const data = Buffer.from('some data');
    const kid = 'key-123';
    const signature = sign(data, key, kid);
    signature[0] ^= 0xff;
    expect(verify(data, signature, key, kid)).toBe(false);
  });
});
