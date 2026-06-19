/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';

interface User {
  username: string;
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
    queryFn: async (): Promise<User | null> => {
      const res = await fetch('/api/v1/me', { credentials: 'include' });
      if (!res.ok) return null;
      const data: MeResponse = await res.json();
      return data.authenticated && data.user ? data.user : null;
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const user = data ?? null;

  return <AuthContext.Provider value={{ user, isLoading }}>{children}</AuthContext.Provider>;
}
