/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { handleUnauthorized, clearAuthReloadFlag, AuthError, isAuthError } from '../api/auth-interceptor';

interface User {
  /** Raw OIDC claim (preferred_username || sub) — for display only (avatar, default names). */
  displayUser: string;
  /**
   * Authoritative Kubernetes username the API server enforces against (<prefix>:<claim>) —
   * the string stamped into the `created-by` annotation. Compare ownership against THIS, not
   * `username`. null when the server couldn't resolve it (no-cluster dev, transient error).
   */
  k8sUser: string | null;
  email?: string;
  groups?: string[];
}

interface MeResponse {
  authenticated: boolean;
  user: User | null;
}

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}

export const authKeys = {
  me: ['auth', 'me'] as const,
};

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const { data, isLoading } = useQuery({
    queryKey: authKeys.me,
    queryFn: async (): Promise<User> => {
      const res = await fetch('/api/v1/me', { credentials: 'include' });

      // A genuine unauthenticated result — either a 401 or the 200
      // `{ authenticated: false }` shape a tokenless /me returns. Route it through the
      // shared re-login path (sets the auth-failed flag the UI reads) and surface it as
      // an AuthError so it is NOT retried and NOT cached as a valid `user = null` for the
      // whole page session. The server clears any stale session cookie on that response,
      // so the sign-in reload takes the unauthenticated path and self-heals.
      if (res.status === 401) {
        handleUnauthorized();
        throw new AuthError('Unauthorized');
      }
      if (!res.ok) {
        // Transient/server error — let React Query retry (bounded) before giving up,
        // rather than pinning `user = null` on a single blip.
        throw new Error(`Failed to load user (${res.status})`);
      }
      const data: MeResponse = await res.json();
      if (!data.authenticated || !data.user) {
        handleUnauthorized();
        throw new AuthError('Not authenticated');
      }
      clearAuthReloadFlag();
      return data.user;
    },
    staleTime: 5 * 60 * 1000,
    // Retry transient failures a bounded number of times, but never a genuine
    // unauthenticated result — that should surface to the re-login flow immediately.
    retry: (failureCount, error) => (isAuthError(error) ? false : failureCount < 2),
  });

  const user = data ?? null;

  return <AuthContext.Provider value={{ user, isLoading }}>{children}</AuthContext.Provider>;
}
