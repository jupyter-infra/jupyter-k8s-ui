import { describe, test, expect, mock, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';

// MUI's Popover (opened by the Menu) calls console.error when it can't measure the anchor's
// layout — which happy-dom never computes. That's an environment artifact, not a component
// defect (it never fires in a real browser). Filter ONLY that message so genuine console
// errors still surface. Restored in afterAll.
const realConsoleError = console.error;
const realConsoleWarn = console.warn;
const isAnchorNoise = (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('anchorEl');
beforeAll(() => {
  console.error = (...args: unknown[]) => {
    if (isAnchorNoise(args)) return;
    realConsoleError(...args);
  };
  console.warn = (...args: unknown[]) => {
    if (isAnchorNoise(args)) return;
    realConsoleWarn(...args);
  };
});
afterAll(() => {
  console.error = realConsoleError;
  console.warn = realConsoleWarn;
});

// NamespaceSwitcher unit tests. We cover the component's LOGIC — not the MUI chrome:
//   a/ filtering: the typeahead narrows the allowed list (case-insensitive) and sorts;
//   b/ find-by-name success: a name not in the list → "Find X" → SSAR allows → select();
//   c/ find-by-name denied (and the fail-closed throw path) → denied message, no select;
//   d/ "Load more": rendered only when hasNextPage && no active filter, and it pages.
//
// Seams chosen to AVOID bun's process-global mock.module collisions:
//   - useNamespaces (../../api/hooks) and useNamespace (../../context/NamespaceContext) are
//     mocked — NO other test file mocks these, so there's no cross-file clobber.
//   - checkNamespaceAccess is stubbed by overriding the method on the real apiClient
//     SINGLETON (restored in afterEach), so we never mock.module('../../api/client') —
//     which three sibling files already mock with incompatible partial shapes.

import { apiClient } from '../../api/client';

// --- useNamespaces stub: a canned useInfiniteQuery-shaped result the test drives per-case ---
type Page = { items: Array<{ namespace: string }>; offset: number; limit: number; hasMore: boolean };
let pages: Page[] = [];
let hasNextPage = false;
let isFetchingNextPage = false;
const fetchNextPage = mock(() => {});
mock.module('../../api/hooks', () => ({
  useNamespaces: () => ({
    data: { pages },
    isFetching: false,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
  }),
}));

// --- useNamespace stub: capture setActiveNamespace without the real PATCH side-effects ---
const setActiveNamespace = mock((ns: string) => ns);
mock.module('../../context/NamespaceContext', () => ({
  useNamespace: () => ({ activeNamespace: 'team-a', setActiveNamespace, recoverFromForbidden: async () => false }),
  // The component also imports namespaceKeys (for the refresh fetchInfiniteQuery); keep it real-shaped.
  namespaceKeys: { active: ['namespace', 'active'], list: ['namespace', 'list'] },
}));

const { NamespaceSwitcher } = await import('./NamespaceSwitcher');

// Real singleton method we override per-test (restored in afterEach) — no module mock.
const realCheckAccess = apiClient.checkNamespaceAccess;
let checkAccessImpl: (ns: string) => Promise<{ namespace: string; allowed: boolean }>;

function renderSwitcher() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <NamespaceSwitcher />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Open the menu and return the search textbox. */
function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: /select namespace/i }));
}

function pageOf(names: string[], hasMore = false): Page {
  return { items: names.map((namespace) => ({ namespace })), offset: 0, limit: 5, hasMore };
}

beforeEach(() => {
  cleanup();
  pages = [];
  hasNextPage = false;
  isFetchingNextPage = false;
  fetchNextPage.mockClear();
  setActiveNamespace.mockClear();
  checkAccessImpl = async (ns) => ({ namespace: ns, allowed: true });
  // @ts-expect-error override the instance method for the test
  apiClient.checkNamespaceAccess = (ns: string) => checkAccessImpl(ns);
});

afterEach(() => {
  apiClient.checkNamespaceAccess = realCheckAccess;
});

describe('NamespaceSwitcher — filtering (a)', () => {
  test('typeahead narrows the list case-insensitively and drops non-matches', async () => {
    pages = [pageOf(['team-a', 'team-b', 'prod-x'])];
    renderSwitcher();
    openMenu();

    // All three visible before filtering.
    expect(screen.getByRole('menuitem', { name: /^prod-x$/ })).toBeDefined();

    // Type a case-insensitive fragment; only the two team-* entries remain.
    fireEvent.change(screen.getByRole('textbox', { name: /find a namespace/i }), { target: { value: 'TEAM' } });
    expect(screen.getByRole('menuitem', { name: /^team-a$/ })).toBeDefined();
    expect(screen.getByRole('menuitem', { name: /^team-b$/ })).toBeDefined();
    expect(screen.queryByRole('menuitem', { name: /^prod-x$/ })).toBeNull();
  });
});

describe('NamespaceSwitcher — find-by-name (b, c)', () => {
  test('b/ a name not in the list, allowed by SSAR → selects it', async () => {
    pages = [pageOf(['team-a'])];
    renderSwitcher();
    openMenu();

    // Type a name that matches nothing in the allowed list → the Find affordance appears.
    fireEvent.change(screen.getByRole('textbox', { name: /find a namespace/i }), { target: { value: 'team-z' } });
    fireEvent.click(screen.getByRole('menuitem', { name: /Find "team-z"/ }));

    await waitFor(() => expect(setActiveNamespace).toHaveBeenCalledWith('team-z'));
  });

  test('c/ denied by SSAR → shows the not-allowed message, never selects', async () => {
    checkAccessImpl = async (ns) => ({ namespace: ns, allowed: false });
    pages = [pageOf(['team-a'])];
    renderSwitcher();
    openMenu();

    fireEvent.change(screen.getByRole('textbox', { name: /find a namespace/i }), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('menuitem', { name: /Find "nope"/ }));

    await waitFor(() => expect(screen.getByText(/you don't have access to "nope"/i)).toBeDefined());
    expect(setActiveNamespace).not.toHaveBeenCalled();
  });

  // The SSAR call is a display hint, so a thrown error is retried ONCE before giving up. A
  // definitive allow/deny verdict on either attempt ends it; only a second throw is surfaced
  // — and as a generic "couldn't check", NOT a false "access denied".
  test('c-retry/ first attempt throws, retry ALLOWS → selects (no error shown)', async () => {
    let calls = 0;
    checkAccessImpl = async (ns) => {
      calls++;
      if (calls === 1) throw new Error('network blip');
      return { namespace: ns, allowed: true };
    };
    pages = [pageOf(['team-a'])];
    renderSwitcher();
    openMenu();

    fireEvent.change(screen.getByRole('textbox', { name: /find a namespace/i }), { target: { value: 'flaky' } });
    fireEvent.click(screen.getByRole('menuitem', { name: /Find "flaky"/ }));

    await waitFor(() => expect(setActiveNamespace).toHaveBeenCalledWith('flaky'));
    expect(calls).toBe(2); // retried once, then succeeded
  });

  test('c-retry/ first attempt throws, retry DENIES → not-allowed message, never selects', async () => {
    let calls = 0;
    checkAccessImpl = async (ns) => {
      calls++;
      if (calls === 1) throw new Error('network blip');
      return { namespace: ns, allowed: false };
    };
    pages = [pageOf(['team-a'])];
    renderSwitcher();
    openMenu();

    fireEvent.change(screen.getByRole('textbox', { name: /find a namespace/i }), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('menuitem', { name: /Find "nope"/ }));

    await waitFor(() => expect(screen.getByText(/you don't have access to "nope"/i)).toBeDefined());
    expect(calls).toBe(2);
    expect(setActiveNamespace).not.toHaveBeenCalled();
  });

  test('c-retry/ both attempts throw → generic "couldn\'t check" message, NOT a false denial', async () => {
    let calls = 0;
    checkAccessImpl = async () => {
      calls++;
      throw new Error('network down');
    };
    pages = [pageOf(['team-a'])];
    renderSwitcher();
    openMenu();

    fireEvent.change(screen.getByRole('textbox', { name: /find a namespace/i }), { target: { value: 'boom' } });
    fireEvent.click(screen.getByRole('menuitem', { name: /Find "boom"/ }));

    // The generic error — deliberately NOT "you don't have access" (access is unknown).
    await waitFor(() => expect(screen.getByText(/couldn't check access/i)).toBeDefined());
    expect(screen.queryByText(/you don't have access/i)).toBeNull();
    expect(calls).toBe(2); // one retry, then gave up
    expect(setActiveNamespace).not.toHaveBeenCalled();
  });
});

describe('NamespaceSwitcher — load more (d)', () => {
  test('renders "Load more" when hasNextPage and clicking pages', () => {
    pages = [pageOf(['team-a', 'team-b'], true)];
    hasNextPage = true;
    renderSwitcher();
    openMenu();

    const loadMore = screen.getByRole('menuitem', { name: /load more/i });
    fireEvent.click(loadMore);
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  test('hides "Load more" when a filter is active (paging is for the full list, not a search)', () => {
    pages = [pageOf(['team-a', 'team-b'], true)];
    hasNextPage = true;
    renderSwitcher();
    openMenu();

    fireEvent.change(screen.getByRole('textbox', { name: /find a namespace/i }), { target: { value: 'team' } });
    expect(screen.queryByRole('menuitem', { name: /load more/i })).toBeNull();
  });

  test('hides "Load more" when there is no next page', () => {
    pages = [pageOf(['team-a'])];
    hasNextPage = false;
    renderSwitcher();
    openMenu();

    expect(screen.queryByRole('menuitem', { name: /load more/i })).toBeNull();
  });

  test('while the next page is loading, the item is disabled and shows the loading label (no double-page)', () => {
    pages = [pageOf(['team-a', 'team-b'], true)];
    hasNextPage = true;
    isFetchingNextPage = true; // a page fetch is already in flight
    renderSwitcher();
    openMenu();

    // Swaps to the "Loading…" label and goes aria-disabled — MUI won't fire an aria-disabled
    // MenuItem in a browser, which is what guards against re-triggering fetchNextPage. (We
    // assert the disabled STATE, not a no-op click: happy-dom doesn't enforce pointer-events,
    // so a synthetic click would fire regardless and testing that would test the DOM, not us.)
    const item = screen.getByRole('menuitem', { name: /loading…/i });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByRole('menuitem', { name: /^load more$/i })).toBeNull();
  });
});
