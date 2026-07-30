/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { apiClient } from '../api/client';
import type { MyNamespaceResponse, NamespaceListResponse } from '../types';

interface NamespaceContextType {
  // The namespace all namespaced requests target. Undefined only during the initial
  // bootstrap fetch; every namespaced hook gates on it being defined.
  activeNamespace: string | undefined;
  setActiveNamespace: (ns: string) => void;
  // Called by a namespaced view on a 403: force-recompute the visible set and, if the
  // active namespace is no longer visible (revoked), drop to a usable one. Returns true if
  // it changed the active namespace (caller should stop treating the 403 as fatal).
  recoverFromForbidden: () => Promise<boolean>;
}

const NamespaceContext = createContext<NamespaceContextType | null>(null);

export function useNamespace() {
  const context = useContext(NamespaceContext);
  if (!context) {
    throw new Error('useNamespace must be used within NamespaceProvider');
  }
  return context;
}

export const namespaceKeys = {
  active: ['namespace', 'active'] as const,
  list: ['namespace', 'list'] as const,
};

interface NamespaceProviderProps {
  children: ReactNode;
}

export function NamespaceProvider({ children }: NamespaceProviderProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  // Read/write ?namespace= through the router (scoped to BrowserRouter in prod,
  // MemoryRouter in tests) rather than window.location — so nothing leaks across the
  // shared global URL between tests, and the write stays a router-native replace.
  const [searchParams, setSearchParams] = useSearchParams();
  const urlNamespace = searchParams.get('namespace') || undefined;

  // Cheap bootstrap: the server resolves cookie-remembered-else-configured (no SSAR).
  const { data: bootstrap } = useQuery({
    queryKey: namespaceKeys.active,
    queryFn: (): Promise<MyNamespaceResponse> => apiClient.getMyNamespace(),
    staleTime: Infinity,
    retry: false,
  });

  // Precedence: URL ?namespace= (per-tab, wins over cookie) > server-resolved active
  // (cookie) > undefined until the bootstrap resolves. "First allowed" is a switcher
  // concern — the resolved active is always a valid attempt target.
  const activeNamespace = urlNamespace ?? bootstrap?.active;

  // Canonicalize the URL once we have a concrete namespace (replace, no history entry), so
  // refresh resolves synchronously and the address bar is shareable.
  useEffect(() => {
    if (activeNamespace && urlNamespace !== activeNamespace) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('namespace', activeNamespace);
          return next;
        },
        { replace: true },
      );
    }
  }, [activeNamespace, urlNamespace, setSearchParams]);

  const setActiveNamespace = useCallback(
    (ns: string) => {
      if (ns === activeNamespace) return;

      // Persist the switch server-side via PATCH /my-namespace (writes the activeNs cookie).
      void apiClient.setMyNamespace(ns);
      // Bootstrap now reflects the new active for any later remount.
      queryClient.setQueryData<MyNamespaceResponse>(namespaceKeys.active, { active: ns });

      // Drop all namespaced caches so nothing leaks across namespaces. Query keys already
      // include the ns, but invalidating is belt-and-suspenders for any stale entry.
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      queryClient.invalidateQueries({ queryKey: ['access-strategies'] });

      // A resource-scoped route (/workspace/:name) points at an object in the OLD
      // namespace — a same-named object in the new one is a different thing. Return to the
      // list (carrying the new namespace). List/create pages are namespace-general.
      if (/^\/workspace\//.test(location.pathname)) {
        navigate(`/?namespace=${encodeURIComponent(ns)}`, { replace: true });
      } else {
        setSearchParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            next.set('namespace', ns);
            return next;
          },
          { replace: true },
        );
      }
    },
    [activeNamespace, queryClient, navigate, location.pathname, setSearchParams],
  );

  // 403 recovery: force the server to recompute the visible set (bypassing its cached
  // snapshot), then re-resolve active. If the active namespace fell out of the recomputed
  // set, it was revoked → switch to the default (or the first still-visible namespace).
  // Returns true when it changed active, so the caller stops treating the 403 as fatal.
  // The caller is responsible for the once-per-403 guard (don't loop on a non-revocation 403).
  const recoverFromForbidden = useCallback(async (): Promise<boolean> => {
    // Force page 0 with refresh=1 (recomputes the server snapshot). Called directly rather
    // than through the infinite-query cache to avoid clashing with useNamespaces' key; we
    // invalidate that key afterward so the switcher refetches fresh when next opened.
    const fresh: NamespaceListResponse = await apiClient.listNamespaces({ refresh: true });
    queryClient.invalidateQueries({ queryKey: namespaceKeys.list });
    const visible = fresh.items.map((i) => i.namespace);
    if (activeNamespace && visible.includes(activeNamespace)) {
      return false; // still visible → the 403 wasn't a revocation; let the caller surface it
    }
    const fallback = fresh.default ?? visible[0];
    if (!fallback || fallback === activeNamespace) return false;
    setActiveNamespace(fallback);
    return true;
  }, [queryClient, activeNamespace, setActiveNamespace]);

  const value = useMemo(() => ({ activeNamespace, setActiveNamespace, recoverFromForbidden }), [activeNamespace, setActiveNamespace, recoverFromForbidden]);

  return <NamespaceContext.Provider value={value}>{children}</NamespaceContext.Provider>;
}
