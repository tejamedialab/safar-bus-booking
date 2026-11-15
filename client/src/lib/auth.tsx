import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext } from 'react';
import { api, ApiError } from './api';

export interface User {
  id: string;
  email: string;
  fullName: string;
  role: 'ADMIN' | 'OPERATOR' | 'PASSENGER';
  operatorId: string | null;
}
interface AuthState {
  user: User | null;
  operator: { id: string; name: string; code: string } | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<User>;
  register: (body: Record<string, string>) => Promise<User>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return (await api('/auth/me')).data;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return { user: null, operator: null };
        throw e;
      }
    },
    staleTime: 60_000,
  });
  const value: AuthState = {
    user: me.data?.user ?? null,
    operator: me.data?.operator ?? null,
    loading: me.isLoading,
    async login(email, password) {
      const r = await api('/auth/login', { method: 'POST', body: { email, password } });
      // reset (not clear) keeps the AuthProvider's observer attached, so the header updates at once
      await qc.resetQueries();
      return r.data.user;
    },
    async register(body) {
      const r = await api('/auth/register', { method: 'POST', body });
      await qc.resetQueries();
      return r.data.user;
    },
    async logout() {
      await api('/auth/logout', { method: 'POST' });
      qc.setQueryData(['me'], { user: null, operator: null });
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside AuthProvider');
  return c;
}

export const isStaff = (u: User | null) => u?.role === 'ADMIN' || u?.role === 'OPERATOR';
