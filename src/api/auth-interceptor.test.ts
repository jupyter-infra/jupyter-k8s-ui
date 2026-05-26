import { describe, test, expect, beforeEach } from 'bun:test';
import { handleUnauthorized, clearAuthReloadFlag, isAuthFailed, AuthError, isAuthError } from './auth-interceptor';

describe('handleUnauthorized', () => {
  beforeEach(() => {
    clearAuthReloadFlag();
  });

  test('sets auth failed flag', () => {
    expect(isAuthFailed()).toBe(false);
    handleUnauthorized();
    expect(isAuthFailed()).toBe(true);
  });
});

describe('clearAuthReloadFlag', () => {
  test('resets the auth failed flag', () => {
    handleUnauthorized();
    expect(isAuthFailed()).toBe(true);
    clearAuthReloadFlag();
    expect(isAuthFailed()).toBe(false);
  });
});

describe('AuthError', () => {
  test('is an instance of Error', () => {
    const err = new AuthError('unauthorized');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AuthError');
    expect(err.message).toBe('unauthorized');
  });
});

describe('isAuthError', () => {
  test('returns true for AuthError instances', () => {
    expect(isAuthError(new AuthError('test'))).toBe(true);
  });

  test('returns false for regular errors', () => {
    expect(isAuthError(new Error('test'))).toBe(false);
  });

  test('returns false for non-errors', () => {
    expect(isAuthError(null)).toBe(false);
    expect(isAuthError('string')).toBe(false);
  });
});
