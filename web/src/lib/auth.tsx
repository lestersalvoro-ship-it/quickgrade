import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, get } from './api';
import type { User } from './types';

interface AuthState {
  user: User | null;
  loading: boolean;
  refresh: () => Promise<unknown>;
  setUser: (u: User | null) => void;
}

const Ctx = createContext<AuthState>({ user: null, loading: true, refresh: async () => {}, setUser: () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return (await get<{ user: User }>('/auth/me')).user;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 5 * 60_000,
    retry: 1,
  });
  useEffect(() => {
    const onUnauthorized = () => {
      qc.setQueryData(['me'], null);
    };
    window.addEventListener('qg:unauthorized', onUnauthorized);
    return () => window.removeEventListener('qg:unauthorized', onUnauthorized);
  }, [qc]);
  return (
    <Ctx.Provider
      value={{
        user: q.data ?? null,
        loading: q.isLoading,
        refresh: () => q.refetch(),
        setUser: (u) => {
          if (!u) qc.clear();
          qc.setQueryData(['me'], u);
        },
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);
