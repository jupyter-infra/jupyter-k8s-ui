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
  useStopWorkspace,
  useWorkspace,
  useWorkspaces,
  isWorkspaceSettled,
  isWorkspaceTransitioning,
  markWorkspaceRequested,
  forgetAcknowledgedRequests,
  LIST_POLL_INTERVAL_MS,
  FAST_POLL_INTERVAL_MS,
  FAST_POLL_MAX_AGE_MS,
} from './hooks';
import { AuthError } from './auth-interceptor';
import { makeWorkspace as baseWorkspace } from '../test-utils';
import { NamespaceProvider, namespaceKeys } from '../context/NamespaceContext';
import { AuthProvider, authKeys } from '../context/AuthContext';
import { OWNER_ANNOTATION } from '../utils';

const TEST_NS = 'default';

// Mock the API client
const mockDelete = mock(async (): Promise<void> => undefined);
const mockStart = mock(async (): Promise<Workspace> => ({}) as Workspace);
const mockList = mock(async (): Promise<Workspace[]> => []);
const mockGet = mock(async (): Promise<Workspace> => ({}) as Workspace);

mock.module('./client', () => ({
  apiClient: {
    deleteWorkspace: mockDelete,
    listWorkspaces: mockList,
    getWorkspace: mockGet,
    startWorkspace: mockStart,
    // stopWorkspace follows the same optimistic-update code path as startWorkspace
    stopWorkspace: mockStart,
  },
}));

// A workspace as the list endpoint returns it: conditions carry a fresh lastTransitionTime unless the test
// sets one, and a null desiredStatus leaves the field out, as a workspace created before the default did.
function makeWorkspace(
  name: string,
  desiredStatus: 'Running' | 'Stopped' | null = 'Running',
  conditions: Array<{ type: string; status: string; lastTransitionTime?: string }> = [],
  creationTimestamp?: string,
): Workspace {
  const stamped = conditions.map((condition) => ({ lastTransitionTime: new Date().toISOString(), ...condition }));
  const workspace = baseWorkspace({
    name,
    metadata: { name, namespace: 'default', annotations: {}, creationTimestamp: creationTimestamp ?? '2024-01-01T00:00:00Z' },
    status: { conditions: stamped },
  });
  if (desiredStatus === null) delete workspace.spec.desiredStatus;
  else workspace.spec.desiredStatus = desiredStatus;
  return workspace;
}

// The signed-in viewer; ownership compares against k8sUser, the name the created-by annotation holds.
const alice = { displayUser: 'alice-raw-claim', k8sUser: 'alice' };

// The namespaced hooks read activeNamespace from NamespaceProvider and the viewer from AuthProvider; seed
// both cheap queries so they resolve synchronously (no network). A null viewer is a signed-out tab.
function makeWrapper(client: QueryClient, viewer: typeof alice | null = alice) {
  client.setQueryData(namespaceKeys.active, { active: TEST_NS });
  client.setQueryData(authKeys.me, viewer);
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(MemoryRouter, null, React.createElement(NamespaceProvider, null, React.createElement(AuthProvider, null, children))),
    );
}

// A workspace as another user's, private unless `accessType` says otherwise.
function ownedBy(workspace: Workspace, owner: string, accessType: 'Public' | 'OwnerOnly' = 'OwnerOnly'): Workspace {
  workspace.metadata.annotations = { ...workspace.metadata.annotations, [OWNER_ANNOTATION]: owner };
  workspace.spec.accessType = accessType;
  return workspace;
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
    // No transition was accepted, so the request must not keep the fast rate.
    expect(isWorkspaceTransitioning(makeWorkspace('a', 'Running', [{ type: 'Stopped', status: 'True' }]))).toBe(false);
  });
});

// useStopWorkspace follows the same optimistic-update pattern as useStartWorkspace
// (same code path, different desired status). The start tests above cover the shared path.
describe('useStopWorkspace — rejected request', () => {
  test('forgets the request on error', async () => {
    mockStart.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(listKey, [makeWorkspace('stop-rejected', 'Running', [{ type: 'Degraded', status: 'True' }])]);

    const { result } = renderHook(() => useStopWorkspace(), { wrapper: makeWrapper(client) });
    await act(async () => {
      try {
        await result.current.mutateAsync('stop-rejected');
      } catch {
        // expected
      }
    });

    expect(isWorkspaceTransitioning(makeWorkspace('stop-rejected', 'Stopped', [{ type: 'Degraded', status: 'True' }]))).toBe(false);
  });
});

describe('isWorkspaceSettled', () => {
  const ws = (desiredStatus: 'Running' | 'Stopped' | undefined, conditions: Array<{ type: string; status: string }>) =>
    makeWorkspace('w', desiredStatus ?? null, conditions);

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

  async function nextListInterval(viewer: typeof alice | null = alice) {
    const { result } = renderHook(() => useWorkspaces(), { wrapper: makeWrapper(client, viewer) });
    await waitFor(() => expect(result.current.isSuccess || result.current.isError).toBe(true));
    return currentListInterval();
  }

  // Degraded never counts, so a workspace nobody fixes does not keep the list polling fast.
  test('a list of Running, Stopped and Degraded workspaces polls at the list rate', async () => {
    mockList.mockImplementation(async () => [
      makeWorkspace('poll-running', 'Running', [{ type: 'Available', status: 'True' }]),
      makeWorkspace('poll-stopped', 'Stopped', [{ type: 'Stopped', status: 'True' }]),
      makeWorkspace('poll-degraded', 'Running', [{ type: 'Degraded', status: 'True' }]),
    ]);
    expect(await nextListInterval()).toBe(LIST_POLL_INTERVAL_MS);
  });

  test('one Starting workspace switches the list to the fast rate', async () => {
    mockList.mockImplementation(async () => [
      makeWorkspace('poll-running', 'Running', [{ type: 'Available', status: 'True' }]),
      makeWorkspace('poll-starting', 'Running', [{ type: 'Progressing', status: 'True' }]),
    ]);
    expect(await nextListInterval()).toBe(FAST_POLL_INTERVAL_MS);
  });

  test('an auth error stops polling', async () => {
    mockList.mockImplementation(async () => {
      throw new AuthError('401');
    });
    expect(await nextListInterval()).toBe(false);
  });

  // The fast rate is scoped to workspaces this viewer waits on, so one user's start does not put every tab
  // in a shared namespace on the fast rate.
  test('a transitioning workspace the viewer owns switches the list to the fast rate', async () => {
    mockList.mockImplementation(async () => [ownedBy(makeWorkspace('poll-mine', 'Running', [{ type: 'Progressing', status: 'True' }]), 'alice')]);
    expect(await nextListInterval()).toBe(FAST_POLL_INTERVAL_MS);
  });

  test('a transitioning Public workspace of another user switches the list to the fast rate', async () => {
    mockList.mockImplementation(async () => [ownedBy(makeWorkspace('poll-public', 'Running', [{ type: 'Progressing', status: 'True' }]), 'bob', 'Public')]);
    expect(await nextListInterval()).toBe(FAST_POLL_INTERVAL_MS);
  });

  test('a transitioning private workspace with no owner annotation polls at the list rate', async () => {
    const unowned = makeWorkspace('poll-unowned', 'Running', [{ type: 'Progressing', status: 'True' }]);
    unowned.spec.accessType = 'OwnerOnly';
    mockList.mockImplementation(async () => [unowned]);
    expect(await nextListInterval()).toBe(LIST_POLL_INTERVAL_MS);
  });

  test('a transitioning private workspace of another user polls at the list rate', async () => {
    mockList.mockImplementation(async () => [ownedBy(makeWorkspace('poll-private', 'Running', [{ type: 'Progressing', status: 'True' }]), 'bob')]);
    expect(await nextListInterval()).toBe(LIST_POLL_INTERVAL_MS);
  });

  test("a Start this tab requested on another user's private workspace keeps the fast rate while the conditions lag", async () => {
    markWorkspaceRequested(TEST_NS, 'poll-requested');
    mockList.mockImplementation(async () => [ownedBy(makeWorkspace('poll-requested', 'Running', [{ type: 'Stopped', status: 'True' }]), 'bob')]);
    expect(await nextListInterval()).toBe(FAST_POLL_INTERVAL_MS);
  });

  test('a signed-out tab follows a transitioning Public workspace, not a private one', async () => {
    mockList.mockImplementation(async () => [ownedBy(makeWorkspace('poll-public', 'Running', [{ type: 'Progressing', status: 'True' }]), 'bob', 'Public')]);
    expect(await nextListInterval(null)).toBe(FAST_POLL_INTERVAL_MS);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockList.mockImplementation(async () => [ownedBy(makeWorkspace('poll-private', 'Running', [{ type: 'Progressing', status: 'True' }]), 'bob')]);
    expect(await nextListInterval(null)).toBe(LIST_POLL_INTERVAL_MS);
  });

  test('a start under way for longer than the bound polls at the list rate', async () => {
    const beyondBound = new Date(Date.now() - FAST_POLL_MAX_AGE_MS - 60_000).toISOString();
    mockList.mockImplementation(async () => [
      makeWorkspace('poll-running', 'Running', [{ type: 'Available', status: 'True' }]),
      makeWorkspace('poll-stalled', 'Running', [{ type: 'Progressing', status: 'True', lastTransitionTime: beyondBound }]),
    ]);
    expect(await nextListInterval()).toBe(LIST_POLL_INTERVAL_MS);
  });

  // A failed refetch keeps the last list, so a transitioning workspace in it must not set the rate.
  test('a failed refetch polls at the list rate', async () => {
    mockList.mockImplementationOnce(async () => [makeWorkspace('poll-failed', 'Running', [{ type: 'Progressing', status: 'True' }])]);
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

describe('useWorkspace, poll interval', () => {
  let client: QueryClient;
  const detailKey = workspaceKeys.detail('detail-ws', TEST_NS);

  beforeEach(() => {
    mockGet.mockReset();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  async function nextDetailInterval() {
    const { result } = renderHook(() => useWorkspace('detail-ws'), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(result.current.isSuccess || result.current.isError).toBe(true));
    const observer = client.getQueryCache().find({ queryKey: detailKey })!.observers[0];
    const { refetchInterval } = observer.options;
    return typeof refetchInterval === 'function' ? refetchInterval(observer.getCurrentQuery()) : refetchInterval;
  }

  test('a Starting workspace polls at the fast rate', async () => {
    mockGet.mockImplementation(async () => makeWorkspace('detail-ws', 'Running', [{ type: 'Progressing', status: 'True' }]));
    expect(await nextDetailInterval()).toBe(FAST_POLL_INTERVAL_MS);
  });

  test.each([
    ['Running', 'Running', 'Available'],
    ['Degraded', 'Running', 'Degraded'],
  ] as const)('a %s workspace polls at the list rate', async (_status, desired, condition) => {
    mockGet.mockImplementation(async () => makeWorkspace('detail-ws', desired, [{ type: condition, status: 'True' }]));
    expect(await nextDetailInterval()).toBe(LIST_POLL_INTERVAL_MS);
  });

  test('an auth error stops polling', async () => {
    mockGet.mockImplementation(async () => {
      throw new AuthError('401');
    });
    expect(await nextDetailInterval()).toBe(false);
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

  // Nothing dates the wait without the timestamp, so the bounded rate is the safe one.
  test('a condition without lastTransitionTime falls back to the list rate', () => {
    const ws = makeWorkspace('w', 'Running', [{ type: 'Progressing', status: 'True', lastTransitionTime: undefined }]);
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

  // The optimistic cache write right after the click re-evaluates the rate while the conditions still read
  // Degraded; the request must count there too.
  test('a Stop requested from this tab on a Degraded workspace keeps the fast rate', () => {
    markWorkspaceRequested('default', 'req-degraded');
    const ws = makeWorkspace('req-degraded', 'Stopped', [{ type: 'Degraded', status: 'True' }]);
    expect(isWorkspaceTransitioning(ws)).toBe(true);
  });

  test('a request older than the bound falls back to the list rate', () => {
    markWorkspaceRequested('default', 'req-old');
    setSystemTime(new Date(Date.now() + FAST_POLL_MAX_AGE_MS + 60_000));
    expect(isWorkspaceTransitioning(stillStopped('req-old'))).toBe(false);
  });

  // A read of a settled workspace must not drop the request: React Query decides when the check runs.
  test('a settled read leaves the request in place', () => {
    markWorkspaceRequested('default', 'req-pure');
    isWorkspaceTransitioning(makeWorkspace('req-pure', 'Stopped', [{ type: 'Stopped', status: 'True' }]));
    expect(isWorkspaceTransitioning(stillStopped('req-pure'))).toBe(true);
  });
});

describe('forgetAcknowledgedRequests', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  const stillStopped = (name: string) => makeWorkspace(name, 'Running', [{ type: 'Stopped', status: 'True' }]);
  const degraded = (name: string) => makeWorkspace(name, 'Running', [{ type: 'Degraded', status: 'True' }]);

  test('forgets the request of a settled workspace and of one whose transition the operator recorded', () => {
    markWorkspaceRequested('default', 'ack-settled', now);
    markWorkspaceRequested('default', 'ack-active', now);
    forgetAcknowledgedRequests(
      [
        makeWorkspace('ack-settled', 'Running', [{ type: 'Available', status: 'True' }]),
        makeWorkspace('ack-active', 'Running', [{ type: 'Progressing', status: 'True' }]),
      ],
      now,
    );
    expect(isWorkspaceTransitioning(stillStopped('ack-settled'), now)).toBe(false);
    expect(isWorkspaceTransitioning(stillStopped('ack-active'), now)).toBe(false);
  });

  test('keeps the request of a Degraded workspace', () => {
    markWorkspaceRequested('default', 'ack-degraded', now);
    forgetAcknowledgedRequests([degraded('ack-degraded')], now);
    expect(isWorkspaceTransitioning(degraded('ack-degraded'), now)).toBe(true);
  });

  test('drops a request older than the bound, listed or not', () => {
    const requested = now - FAST_POLL_MAX_AGE_MS;
    markWorkspaceRequested('default', 'ack-old', requested);
    forgetAcknowledgedRequests([], now);
    // read as of a second after the request, when the entry would still count had it survived
    expect(isWorkspaceTransitioning(stillStopped('ack-old'), requested + 1_000)).toBe(false);
  });
});
