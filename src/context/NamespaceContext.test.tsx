import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import { AuthError } from '../api/auth-interceptor';

const setMyNamespace = mock(async (ns: string) => ({ active: ns }));
// listNamespaces reads a mutable response so recovery tests can script the recomputed
// visible set + default per-test (recoverFromForbidden calls it with { refresh: true }).
type ListResponse = { items: Array<{ namespace: string }>; default: string | null };
let listResponse: ListResponse = { items: [], default: null };
const listNamespaces = mock(async () => listResponse);
// getMyNamespace reads a mutable impl so the bootstrap-resilience tests can script a
// transient/persistent failure and a recovery per test.
let getMyNamespaceImpl: () => Promise<{ active: string }> = async () => ({ active: 'cookie-ns' });
const getMyNamespace = mock(() => getMyNamespaceImpl());
mock.module('../api/client', () => ({
  apiClient: {
    getMyNamespace,
    setMyNamespace,
    listNamespaces,
  },
}));

const { NamespaceProvider, useNamespace, namespaceKeys } = await import('./NamespaceContext');

function wrapper(initialEntries: string[], seedActive?: string) {
  // retryDelay: 0 so the bootstrap's bounded retries resolve instantly under test. The
  // per-query retry predicate in NamespaceProvider overrides the `retry: false` default.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  if (seedActive) client.setQueryData(namespaceKeys.active, { active: seedActive });
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(MemoryRouter, { initialEntries }, React.createElement(NamespaceProvider, null, children)),
    );
}

beforeEach(() => {
  listNamespaces.mockClear();
  setMyNamespace.mockClear();
  getMyNamespace.mockClear();
  getMyNamespaceImpl = async () => ({ active: 'cookie-ns' });
  listResponse = { items: [], default: null };
});
afterEach(() => cleanup());

describe('NamespaceContext precedence', () => {
  test('URL ?namespace= wins over the cookie-resolved active', async () => {
    const { result } = renderHook(() => useNamespace(), { wrapper: wrapper(['/?namespace=url-ns'], 'cookie-ns') });
    expect(result.current.activeNamespace).toBe('url-ns');
  });

  test('falls back to the cookie-resolved active when no URL param', async () => {
    const { result } = renderHook(() => useNamespace(), { wrapper: wrapper(['/'], 'cookie-ns') });
    expect(result.current.activeNamespace).toBe('cookie-ns');
  });

  test('setActiveNamespace persists via PATCH /my-namespace and updates active', async () => {
    const { result } = renderHook(() => useNamespace(), { wrapper: wrapper(['/'], 'cookie-ns') });
    await act(async () => {
      result.current.setActiveNamespace('team-b');
    });
    expect(result.current.activeNamespace).toBe('team-b');
    // The switch is persisted through the dedicated write route, not the discovery GET.
    expect(setMyNamespace).toHaveBeenCalledWith('team-b');
    expect(listNamespaces).not.toHaveBeenCalled();
  });
});

describe('NamespaceContext recoverFromForbidden', () => {
  test('recomputes with refresh=1; still-visible active → returns false, no switch', async () => {
    // A 403 that ISN'T a revocation: the active ns is still in the recomputed visible set.
    listResponse = { items: [{ namespace: 'cookie-ns' }, { namespace: 'team-b' }], default: 'cookie-ns' };
    const { result } = renderHook(() => useNamespace(), { wrapper: wrapper(['/'], 'cookie-ns') });

    let changed: boolean | undefined;
    await act(async () => {
      changed = await result.current.recoverFromForbidden();
    });

    expect(changed).toBe(false); // caller should surface the 403, not swallow it
    expect(listNamespaces).toHaveBeenCalledWith({ refresh: true }); // forced recompute
    expect(setMyNamespace).not.toHaveBeenCalled(); // no switch
    expect(result.current.activeNamespace).toBe('cookie-ns');
  });

  test('revoked active → switches to the server default and returns true', async () => {
    // active is NO LONGER in the recomputed set (RBAC revoked) → drop to default.
    listResponse = { items: [{ namespace: 'team-b' }, { namespace: 'team-c' }], default: 'team-b' };
    const { result } = renderHook(() => useNamespace(), { wrapper: wrapper(['/'], 'cookie-ns') });

    let changed: boolean | undefined;
    await act(async () => {
      changed = await result.current.recoverFromForbidden();
    });

    expect(changed).toBe(true);
    expect(setMyNamespace).toHaveBeenCalledWith('team-b'); // switched to default
    expect(result.current.activeNamespace).toBe('team-b');
  });

  test('revoked active, no default → falls back to the first visible namespace', async () => {
    // No server default in the recompute → use visible[0].
    listResponse = { items: [{ namespace: 'team-x' }, { namespace: 'team-y' }], default: null };
    const { result } = renderHook(() => useNamespace(), { wrapper: wrapper(['/'], 'cookie-ns') });

    let changed: boolean | undefined;
    await act(async () => {
      changed = await result.current.recoverFromForbidden();
    });

    expect(changed).toBe(true);
    expect(setMyNamespace).toHaveBeenCalledWith('team-x'); // visible[0]
  });

  test('revoked active, nothing visible → returns false, no switch (nowhere to go)', async () => {
    // Empty recompute: no default, no visible entries → cannot recover.
    listResponse = { items: [], default: null };
    const { result } = renderHook(() => useNamespace(), { wrapper: wrapper(['/'], 'cookie-ns') });

    let changed: boolean | undefined;
    await act(async () => {
      changed = await result.current.recoverFromForbidden();
    });

    expect(changed).toBe(false);
    expect(setMyNamespace).not.toHaveBeenCalled();
  });
});

describe('NamespaceContext bootstrap resilience', () => {
  test('a transient bootstrap failure retries, then resolves without wedging', async () => {
    let attempts = 0;
    getMyNamespaceImpl = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient');
      return { active: 'cookie-ns' };
    };
    const { result } = renderHook(() => useNamespace(), { wrapper: wrapper(['/']) });

    await waitFor(() => expect(result.current.activeNamespace).toBe('cookie-ns'));
    expect(result.current.bootstrapError).toBeNull();
    expect(attempts).toBeGreaterThanOrEqual(2);
  });

  test('a persistent failure surfaces bootstrapError with no active namespace; retryBootstrap shows progress, then recovers', async () => {
    let healthy = false;
    let release: (() => void) | undefined;
    getMyNamespaceImpl = () => {
      if (!healthy) return Promise.reject(new Error('down'));
      // Held open until the test releases it, so the in-flight retry state is observable.
      return new Promise((resolve) => {
        release = () => resolve({ active: 'cookie-ns' });
      });
    };
    const { result } = renderHook(() => useNamespace(), { wrapper: wrapper(['/']) });

    await waitFor(() => expect(result.current.bootstrapError).not.toBeNull());
    expect(result.current.activeNamespace).toBeUndefined();
    expect(result.current.isBootstrapLoading).toBe(false);

    healthy = true;
    await act(async () => {
      result.current.retryBootstrap();
    });
    await waitFor(() => expect(result.current.isBootstrapLoading).toBe(true));

    await act(async () => {
      release?.();
    });
    await waitFor(() => expect(result.current.activeNamespace).toBe('cookie-ns'));
    expect(result.current.bootstrapError).toBeNull();
    expect(result.current.isBootstrapLoading).toBe(false);
  });

  test('an auth failure is not retried (it routes to re-login instead)', async () => {
    let attempts = 0;
    getMyNamespaceImpl = async () => {
      attempts += 1;
      throw new AuthError('unauthorized');
    };
    const { result } = renderHook(() => useNamespace(), { wrapper: wrapper(['/']) });

    await waitFor(() => expect(result.current.bootstrapError).not.toBeNull());
    expect(attempts).toBe(1);
  });
});
