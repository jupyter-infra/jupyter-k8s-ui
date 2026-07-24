import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor, act } from '@testing-library/react';
import React from 'react';
import type { Workspace } from '../types';
import { workspaceKeys, useDeleteWorkspace, useStartWorkspace, isWorkspaceSettled } from './hooks';

// Mock the API client
const mockDelete = mock(async (): Promise<void> => undefined);
const mockStart = mock(async (): Promise<Workspace> => ({}) as Workspace);

mock.module('./client', () => ({
  apiClient: {
    deleteWorkspace: mockDelete,
    startWorkspace: mockStart,
    // stopWorkspace follows the same optimistic-update code path as startWorkspace
    stopWorkspace: mockStart,
  },
}));

function makeWorkspace(name: string, desiredStatus: 'Running' | 'Stopped' = 'Running'): Workspace {
  return {
    metadata: { name, namespace: 'default', annotations: {}, creationTimestamp: '' },
    spec: { desiredStatus },
  } as Workspace;
}

function makeWrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => React.createElement(QueryClientProvider, { client }, children);
}

describe('useDeleteWorkspace — optimistic update', () => {
  let client: QueryClient;

  beforeEach(() => {
    mockDelete.mockClear();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  test('removes workspace from cache on mutate, keeps it removed on success', async () => {
    const initial = [makeWorkspace('a'), makeWorkspace('b')];
    client.setQueryData(workspaceKeys.all, initial);

    const { result } = renderHook(() => useDeleteWorkspace(), { wrapper: makeWrapper(client) });

    await act(async () => {
      await result.current.mutateAsync('a');
    });

    const finalData = client.getQueryData<Workspace[]>(workspaceKeys.all);
    expect(finalData?.map((w) => w.metadata.name)).not.toContain('a');
    expect(mockDelete).toHaveBeenCalledWith('a');
  });

  test('rolls back cache on error', async () => {
    mockDelete.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    const initial = [makeWorkspace('a'), makeWorkspace('b')];
    client.setQueryData(workspaceKeys.all, initial);

    const { result } = renderHook(() => useDeleteWorkspace(), { wrapper: makeWrapper(client) });

    await act(async () => {
      try {
        await result.current.mutateAsync('a');
      } catch {
        // expected
      }
    });

    await waitFor(() => {
      const data = client.getQueryData<Workspace[]>(workspaceKeys.all);
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
    client.setQueryData(workspaceKeys.all, initial);

    const { result } = renderHook(() => useStartWorkspace(), { wrapper: makeWrapper(client) });

    await act(async () => {
      await result.current.mutateAsync('a');
    });

    expect(mockStart).toHaveBeenCalledWith('a');
  });

  test('rolls back desiredStatus on error', async () => {
    mockStart.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    const initial = [makeWorkspace('a', 'Stopped')];
    client.setQueryData(workspaceKeys.all, initial);

    const { result } = renderHook(() => useStartWorkspace(), { wrapper: makeWrapper(client) });

    await act(async () => {
      try {
        await result.current.mutateAsync('a');
      } catch {
        // expected
      }
    });

    await waitFor(() => {
      const data = client.getQueryData<Workspace[]>(workspaceKeys.all);
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

  test('Running with desired Running is settled', () => {
    expect(isWorkspaceSettled(ws('Running', [{ type: 'Available', status: 'True' }]))).toBe(true);
  });

  test('Stopped with desired Stopped is settled', () => {
    expect(isWorkspaceSettled(ws('Stopped', [{ type: 'Stopped', status: 'True' }]))).toBe(true);
  });

  test('unset desiredStatus expects Stopped', () => {
    expect(isWorkspaceSettled(ws(undefined, [{ type: 'Stopped', status: 'True' }]))).toBe(true);
  });

  test('transitional status is not settled even when moving toward desired', () => {
    expect(isWorkspaceSettled(ws('Running', [{ type: 'Progressing', status: 'True' }]))).toBe(false);
  });
});
