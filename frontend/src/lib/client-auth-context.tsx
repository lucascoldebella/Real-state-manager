'use client';

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { clearClientSession, clientFetchMe, clientLoginRequest, clientLogout, getClientToken, getClientUser, setClientSession } from './clientApi';
import type { ClientUser } from './types';

interface ClientAuthContextValue {
  user: ClientUser | null;
  loading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const ClientAuthContext = createContext<ClientAuthContextValue | undefined>(undefined);

export function ClientAuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<ClientUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      const token = getClientToken();
      const cached = getClientUser();
      if (!token || !cached) {
        if (!cancelled) { clearClientSession(); setUser(null); setLoading(false); }
        return;
      }
      if (!cancelled) setUser(cached);
      try {
        const me = await clientFetchMe();
        if (!cancelled) { setClientSession(token, me); setUser(me); }
      } catch {
        if (!cancelled) { clearClientSession(); setUser(null); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void bootstrap();
    return () => { cancelled = true; };
  }, []);

  const login = async (email: string, password: string) => {
    const resp = await clientLoginRequest(email, password);
    setClientSession(resp.token, resp.user);
    setUser(resp.user);
  };

  const logout = async () => {
    await clientLogout();
    setUser(null);
  };

  const value = useMemo<ClientAuthContextValue>(
    () => ({ user, loading, isAuthenticated: Boolean(user), login, logout }),
    [user, loading],
  );

  return <ClientAuthContext.Provider value={value}>{children}</ClientAuthContext.Provider>;
}

export function useClientAuth(): ClientAuthContextValue {
  const ctx = useContext(ClientAuthContext);
  if (!ctx) throw new Error('useClientAuth must be used within ClientAuthProvider');
  return ctx;
}
