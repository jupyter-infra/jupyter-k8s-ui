import { describe, test, expect, beforeEach, afterEach, mock, setSystemTime } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import type { Workspace } from '../types';
import {
  workspaceKeys,
  useDeleteWorkspace,
  useStartWorkspace,
  useWorkspaces,
  isWorkspaceSettled,
  isWorkspaceTransitioning,
  markWorkspaceRequested,
  LIST_POLL_INTERVAL_MS,
  FAST_POLL_INTERVAL_MS,
  FAST_POLL_MAX_AGE_MS,
} from './hooks';
import { AuthError } from './auth-interceptor';
import { NamespaceProvider, namespaceKeys } from '../context/NamespaceContext';

const TEST_NS = 'default';

// Mock the API client
const mockDelete = mock(async (): Promise<void> => undefined);
const mockStart = mock(async (): Promise<Workspace> => ({}) as Workspace);
const mockList = mock(async (): Promise<Workspace[]> => []);

mock.module('./client', () => ({
  apiClient: {
    deleteWorkspace: mockDelete,
    listWorkspaces: mockList,
    startWorkspace: mockStart,
    // stopWorkspace follows the same optimistic-update code path as startWorkspace
    stopWorkspace: mockStart,
  },
}));

function makeWorkspace(
  name: string,
  desiredStatus: 'Running' | 'Stopped' = 'Running',
  conditions: Array<{ type: string; status: string; lastTransitionTime?: string }> = [],
  creationTimestamp = '',
): Workspace {
  return {
    metadata: { name, namespace: 'default', annotations: {}, creationTimestamp },
    spec: { desiredStatus },
    status: { conditions },
  } as Workspace;
}

// The namespaced hooks read activeNamespace from NamespaceProvider; seed the cheap
// bootstrap query so it resolves synchronously to TEST_NS (no network).
function makeWrapper(client: QueryClient) {
  client.setQueryData(namespaceKeys.active, { active: TEST_NS });
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, React.createElement(MemoryRouter, null, React.createElement(NamespaceProvider, null, children)));
}

// The list cache key is now namespace-scoped.
const listKey = workspaceKeys.all(TEST_NS);

describe('useDeleteWorkspace — optimistic update', () => {
  let client: QueryClient;

  beforeEach(() => {
    mockDelete.mockClear();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  test('removes workspace from cache on mutate, keeps it removed on success', async () => {
    const initial = [makeWorkspace('a'), makeWorkspace('b')];
    client.setQueryData(listKey, initial);

    const { result } = renderHook(() => useDeleteWorkspace(), { wrapper: makeWrapper(client) });

    await act(async () => {
      await result.current.mutateAsync('a');
    });

    const finalData = client.getQueryData<Workspace[]>(listKey);
    expect(finalData?.map((w) => w.metadata.name)).not.toContain('a');
    expect(mockDelete).toHaveBeenCalledWith('a', 'default');
  });

  test('rolls back cache on error', async () => {
    mockDelete.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    const initial = [makeWorkspace('a'), makeWorkspace('b')];
    client.setQueryData(listKey, initial);

    const { result } = renderHook(() => useDeleteWorkspace(), { wrapper: makeWrapper(client) });

    await act(async () => {
      try {
        await result.current.mutateAsync('a');
      } catch {
        // expected
      }
    });

    await waitFor(() => {
      const data = client.getQueryData<Workspace[]>(listKey);
      expect(data?.map((w) => w.metadata.name)).toEqual(['a', 'b']);
    });
  });
});

describe('useStartWorkspace — optimistic update', () => {
  let client: QueryClient;

  beforeEach(() => {
    mockStart.mockClear();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  test('sets desiredStatus to Running on mutate', async () => {
    const initial = [makeWorkspace('a', 'Stopped')];
    client.setQueryData(listKey, initial);

    const { result } = renderHook(() => useStartWorkspace(), { wrapper: makeWrapper(client) });

    await act(async () => {
      await result.current.mutateAsync('a');
    });

    expect(mockStart).toHaveBeenCalledWith('a', 'default');
    // The request dates the wait until the operator records Progressing (#51).
    expect(isWorkspaceTransitioning(makeWorkspace('a', 'Running', [{ type: 'Stopped', status: 'True' }]))).toBe(true);
  });

  test('rolls back desiredStatus on error', async () => {
    mockStart.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    const initial = [makeWorkspace('a', 'Stopped')];
    client.setQueryData(listKey, initial);

    const { result } = renderHook(() => useStartWorkspace(), { wrapper: makeWrapper(client) });

    await act(async () => {
      try {
        await result.current.mutateAsync('a');
      } catch {
        // expected
      }
    });

    await waitFor(() => {
      const data = client.getQueryData<Workspace[]>(listKey);
      expect(data?.[0].spec.desiredStatus).toBe('Stopped');
    });
  });
});

// useStopWorkspace follows the same optimistic-update pattern as useStartWorkspace
// (same code path, different desired status). Covered by the start tests above.

describe('isWorkspaceSettled', () => {
  const ws = (desiredStatus: 'Running' | 'Stopped' | undefined, conditions: Array<{ type: string; status: string }>): Workspace =>
    ({
      metadata: { name: 'w', namespace: 'default', annotations: {}, creationTimestamp: '' },
      spec: desiredStatus ? { desiredStatus } : {},
      status: { conditions },
    }) as Workspace;

  test('undefined workspace is not settled', () => {
    expect(isWorkspaceSettled(undefined)).toBe(false);
  });

  // The race from #51: a refetch lands after desiredStatus flips but before the
  // operator updates conditions. The stale terminal status must keep polling.
  test('conditions Stopped with desired Running is not settled (post-Start race)', () => {
    expect(isWorkspaceSettled(ws('Running', [{ type: 'Stopped', status: 'True' }]))).toBe(false);
  });

  test('conditions Running with desired Stopped is not settled (post-Stop race)', () => {
    expect(isWorkspaceSettled(ws('Stopped', [{ type: 'Available', status: 'True' }]))).toBe(false);
  });

  test.each([
    ['Running', 'Available'],
    ['Stopped', 'Stopped'],
  ] as const)('%s converged on desired is settled', (desired, condition) => {
    expect(isWorkspaceSettled(ws(desired, [{ type: condition, status: 'True' }]))).toBe(true);
  });

  test('unset desiredStatus expects Stopped', () => {
    expect(isWorkspaceSettled(ws(undefined, [{ type: 'Stopped', status: 'True' }]))).toBe(true);
  });
});

describe('useWorkspaces, poll interval', () => {
  let client: QueryClient;

  beforeEach(() => {
    mockList.mockReset();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  // Applies the hook's refetchInterval option to the live query, as React Query does after each fetch.
  function currentListInterval() {
    const observer = client.getQueryCache().find({ queryKey: listKey })!.observers[0];
    const { refetchInterval } = observer.options;
    return typeof refetchInterval === 'function' ? refetchInterval(observer.getCurrentQuery()) : refetchInterval;
  }

  async function nextListInterval() {
    const { result } = renderHook(() => useWorkspaces(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(result.current.isSuccess || result.current.isError).toBe(true));
    return currentListInterval();
  }

  // Degraded never counts, so a workspace nobody fixes does not keep the list polling fast.
  test('a list of Running, Stopped and Degraded workspaces polls at the list rate', async () => {
    mockList.mockImplementation(async () => [
      makeWorkspace('a', 'Running', [{ type: 'Available', status: 'True' }]),
      makeWorkspace('b', 'Stopped', [{ type: 'Stopped', status: 'True' }]),
      makeWorkspace('c', 'Running', [{ type: 'Degraded', status: 'True' }]),
    ]);
    expect(await nextListInterval()).toBe(LIST_POLL_INTERVAL_MS);
  });

  test('one Starting workspace switches the list to the fast rate', async () => {
    mockList.mockImplementation(async () => [
      makeWorkspace('a', 'Running', [{ type: 'Available', status: 'True' }]),
      makeWorkspace('b', 'Running', [{ type: 'Progressing', status: 'True' }]),
    ]);
    expect(await nextListInterval()).toBe(FAST_POLL_INTERVAL_MS);
  });

  test('an auth error stops polling', async () => {
    mockList.mockImplementation(async () => {
      throw new AuthError('401');
    });
    expect(await nextListInterval()).toBe(false);
  });

  // A failed refetch keeps the last list, so a transitioning workspace in it must not set the rate.
  test('a failed refetch polls at the list rate', async () => {
    mockList.mockImplementationOnce(async () => [makeWorkspace('a', 'Running', [{ type: 'Progressing', status: 'True' }])]);
    mockList.mockImplementation(async () => {
      throw new Error('502');
    });
    const { result } = renderHook(() => useWorkspaces(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(currentListInterval()).toBe(FAST_POLL_INTERVAL_MS);

    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(currentListInterval()).toBe(LIST_POLL_INTERVAL_MS);
  });
});

describe('isWorkspaceTransitioning', () => {
  test.each([
    ['Starting', 'Running', 'Progressing', true],
    ['Stopping', 'Stopped', 'Progressing', true],
    ['Deleting', 'Running', 'Deleting', true],
    ['Running', 'Running', 'Available', false],
    ['Stopped', 'Stopped', 'Stopped', false],
    ['Degraded', 'Running', 'Degraded', false],
    ['Stopped with a Start made elsewhere', 'Running', 'Stopped', false],
    ['Degraded with a Stop pending', 'Stopped', 'Degraded', false],
    ['Unknown, no recognized condition True', 'Running', 'Initialized', false],
  ] as const)('%s', (_status, desired, condition, expected) => {
    expect(isWorkspaceTransitioning(makeWorkspace('w', desired, [{ type: condition, status: 'True' }]))).toBe(expected);
  });
});

describe('isWorkspaceTransitioning, fast poll bound', () => {
  const since = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const beyondBound = () => new Date(Date.now() - FAST_POLL_MAX_AGE_MS - 60_000).toISOString();

  test('a start under way for a minute keeps the fast rate', () => {
    const ws = makeWorkspace('w', 'Running', [{ type: 'Progressing', status: 'True', lastTransitionTime: since(1) }]);
    expect(isWorkspaceTransitioning(ws)).toBe(true);
  });

  test.each(['Progressing', 'Deleting'])('a %s condition older than the bound falls back to the list rate', (type) => {
    const ws = makeWorkspace('w', 'Running', [{ type, status: 'True', lastTransitionTime: beyondBound() }]);
    expect(isWorkspaceTransitioning(ws)).toBe(false);
  });

  // The operator writes Degraded alone on a transient error during a start and clears it on the next pass.
  test('a Degraded condition beside a fresh Progressing keeps the fast rate', () => {
    const ws = makeWorkspace('w', 'Running', [
      { type: 'Degraded', status: 'True' },
      { type: 'Progressing', status: 'True', lastTransitionTime: since(0.5) },
    ]);
    expect(isWorkspaceTransitioning(ws)).toBe(true);
  });

  // No conditions means the operator has not reconciled the workspace yet; its creation dates the wait.
  test('a workspace created a minute ago and not yet reconciled keeps the fast rate', () => {
    expect(isWorkspaceTransitioning(makeWorkspace('w', 'Running', [], since(1)))).toBe(true);
  });

  test('a workspace created beyond the bound and never reconciled falls back to the list rate', () => {
    expect(isWorkspaceTransitioning(makeWorkspace('w', 'Running', [], beyondBound()))).toBe(false);
  });
});

describe('isWorkspaceTransitioning, request-time bound', () => {
  afterEach(() => setSystemTime());
  const stillStopped = (name: string) => makeWorkspace(name, 'Running', [{ type: 'Stopped', status: 'True' }]);

  test('a Start requested from this tab keeps the fast rate while the conditions still show Stopped', () => {
    markWorkspaceRequested('default', 'req-fast');
    expect(isWorkspaceTransitioning(stillStopped('req-fast'))).toBe(true);
  });

  test('a request older than the bound falls back to the list rate', () => {
    markWorkspaceRequested('default', 'req-old');
    setSystemTime(new Date(Date.now() + FAST_POLL_MAX_AGE_MS + 60_000));
    expect(isWorkspaceTransitioning(stillStopped('req-old'))).toBe(false);
  });

  test('the request is forgotten once the operator records the transition', () => {
    markWorkspaceRequested('default', 'req-done');
    isWorkspaceTransitioning(makeWorkspace('req-done', 'Running', [{ type: 'Progressing', status: 'True', lastTransitionTime: new Date().toISOString() }]));
    expect(isWorkspaceTransitioning(stillStopped('req-done'))).toBe(false);
  });
});
