import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import type { NamespaceListResponse } from '../types';

// useNamespaces is an infinite query paging GET /namespaces by offset. We assert the
// paging wiring: getNextPageParam advances by limit while hasMore, pages accumulate, and
// it stops when hasMore is false.
const listNamespaces = mock(async (_opts: { offset?: number; refresh?: boolean } = {}): Promise<NamespaceListResponse> => {
  const offset = _opts.offset ?? 0;
  // Universe of 5, page size 2 → pages [0,2), [2,4), [4,5).
  const all = ['ns-0', 'ns-1', 'ns-2', 'ns-3', 'ns-4'];
  const limit = 2;
  const slice = all.slice(offset, offset + limit);
  return { items: slice.map((namespace) => ({ namespace })), default: 'ns-0', offset, limit, total: all.length, hasMore: offset + limit < all.length };
});

mock.module('./client', () => ({ apiClient: { listNamespaces, getMyNamespace: mock(async () => ({ active: 'ns-0' })) } }));

const { useNamespaces } = await import('./hooks');
const { namespaceKeys } = await import('../context/NamespaceContext');

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(namespaceKeys.active, { active: 'ns-0' });
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, React.createElement(MemoryRouter, null, children));
}

beforeEach(() => listNamespaces.mockClear());

describe('useNamespaces paging', () => {
  test('fetches page 0 with hasMore, then accumulates the next page on fetchNextPage', async () => {
    const { result } = renderHook(() => useNamespaces(true), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.data?.pages.length).toBe(1));
    expect(result.current.data?.pages[0].items.map((i) => i.namespace)).toEqual(['ns-0', 'ns-1']);
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => {
      await result.current.fetchNextPage();
    });

    // Second page fetched at offset = 0 + limit = 2, accumulated (not replacing page 0).
    await waitFor(() => expect(result.current.data?.pages.length).toBe(2));
    expect(listNamespaces).toHaveBeenLastCalledWith({ offset: 2 });
    const all = result.current.data?.pages.flatMap((p) => p.items.map((i) => i.namespace));
    expect(all).toEqual(['ns-0', 'ns-1', 'ns-2', 'ns-3']);
  });

  test('stops paging when hasMore is false (last page)', async () => {
    const { result } = renderHook(() => useNamespaces(true), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));

    // Page through to the end: [0,2) → [2,4) → [4,5) hasMore=false.
    await act(async () => {
      await result.current.fetchNextPage();
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
    const all = result.current.data?.pages.flatMap((p) => p.items.map((i) => i.namespace));
    expect(all).toEqual(['ns-0', 'ns-1', 'ns-2', 'ns-3', 'ns-4']);
  });

  test('disabled (switcher closed) → no fetch', () => {
    renderHook(() => useNamespaces(false), { wrapper: wrapper() });
    expect(listNamespaces).not.toHaveBeenCalled();
  });
});
