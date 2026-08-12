import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { AuthProvider, useAuth } from './AuthContext';
import { isAuthFailed, clearAuthReloadFlag } from '../api/auth-interceptor';

const originalFetch = globalThis.fetch;

function mockFetch(response: { ok: boolean; status?: number; json?: () => Promise<unknown> }) {
  const fetchMock = mock(async () => response as unknown as Response);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function createWrapper() {
  // retryDelay: 0 so the bounded retries AuthProvider configures resolve instantly under test.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { gcTime: 0, retryDelay: 0 } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
  };
}

describe('AuthContext', () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
    clearAuthReloadFlag();
  });

  test('starts in loading state', () => {
    mockFetch({ ok: false, status: 500 });
    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper() });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.user).toBeNull();
  });

  test('sets user when /me returns authenticated response', async () => {
    mockFetch({
      ok: true,
      status: 200,
      json: async () => ({ authenticated: true, user: { displayUser: 'alice', k8sUser: 'github:alice', email: 'a@x.com' } }),
    });

    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.user).toEqual({ displayUser: 'alice', k8sUser: 'github:alice', email: 'a@x.com' });
    expect(isAuthFailed()).toBe(false);
  });

  test('genuine unauthenticated flag routes through the re-login path (no user, auth-failed set)', async () => {
    mockFetch({ ok: true, status: 200, json: async () => ({ authenticated: false }) });

    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.user).toBeNull();
    expect(isAuthFailed()).toBe(true);
  });

  test('a 401 routes through the re-login path (no user, auth-failed set)', async () => {
    mockFetch({ ok: false, status: 401 });

    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.user).toBeNull();
    expect(isAuthFailed()).toBe(true);
  });

  test('a transient server error does not flag auth failure and yields no user after retries', async () => {
    const fetchMock = mockFetch({ ok: false, status: 500 });

    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.user).toBeNull();
    // A 5xx is not a genuine unauthenticated result — it must not trip the re-login flow.
    expect(isAuthFailed()).toBe(false);
    // Bounded retries: initial attempt + retries (failureCount < 2 → 3 total).
    expect(fetchMock.mock.calls.length).toBe(3);
  });

  test('sets user to null when fetch throws', async () => {
    const errorFetch = mock(async () => {
      throw new Error('network');
    });
    globalThis.fetch = errorFetch as unknown as typeof fetch;

    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.user).toBeNull();
    expect(isAuthFailed()).toBe(false);
  });

  test('useAuth throws when used outside AuthProvider', () => {
    expect(() => renderHook(() => useAuth())).toThrow('useAuth must be used within AuthProvider');
  });
});
