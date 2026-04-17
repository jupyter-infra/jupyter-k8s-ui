import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { renderHook, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from './AuthContext';

const originalFetch = globalThis.fetch;

function mockFetchOnce(response: { ok: boolean; json?: () => Promise<unknown> }) {
  const fetchMock = mock(async () => response as unknown as Response);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('AuthContext', () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('starts in loading state', () => {
    mockFetchOnce({ ok: false });
    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.user).toBeNull();
  });

  test('sets user when /me returns authenticated response', async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({ authenticated: true, user: { username: 'alice', email: 'a@x.com' } }),
    });

    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.user).toEqual({ username: 'alice', email: 'a@x.com' });
  });

  test('sets user to null when /me returns unauthenticated flag', async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({ authenticated: false }),
    });

    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.user).toBeNull();
  });

  test('sets user to null when /me returns non-ok', async () => {
    mockFetchOnce({ ok: false });

    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.user).toBeNull();
  });

  test('sets user to null when fetch throws', async () => {
    const errorFetch = mock(async () => {
      throw new Error('network');
    });
    globalThis.fetch = errorFetch as unknown as typeof fetch;

    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.user).toBeNull();
  });

  test('useAuth throws when used outside AuthProvider', () => {
    expect(() => renderHook(() => useAuth())).toThrow('useAuth must be used within AuthProvider');
  });
});
