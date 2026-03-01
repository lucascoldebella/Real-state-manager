'use client';

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { clearStoredSession, fetchMe, getStoredToken, getStoredUser, loginRequest, logoutRequest, setStoredSession } from './api';
import type { AuthUser } from './types';

export type AccessModule = 'dashboard' | 'properties' | 'tenants' | 'finance' | 'documents' | 'settings';

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  hasAccess: (module: AccessModule) => boolean;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      const token = getStoredToken();
      const cachedUser = getStoredUser();
      if (!token || !cachedUser) {
        if (!cancelled) {
          clearStoredSession();
          setUser(null);
          setLoading(false);
        }
        return;
      }

      if (!cancelled) {
        setUser(cachedUser);
      }

      try {
        const me = await fetchMe();
        if (!cancelled) {
          setStoredSession(token, me.user);
          setUser(me.user);
        }
      } catch {
        if (!cancelled) {
          clearStoredSession();
          setUser(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = async (email: string, password: string) => {
    const response = await loginRequest(email, password);
    setStoredSession(response.token, response.user);
    setUser(response.user);
  };

  const logout = async () => {
    await logoutRequest();
    setUser(null);
  };

  const refreshUser = async () => {
    const token = getStoredToken();
    if (!token) {
      setUser(null);
      return;
    }
    const me = await fetchMe();
    setStoredSession(token, me.user);
    setUser(me.user);
  };

  const hasAccess = React.useCallback(
    (module: AccessModule): boolean => {
      if (!user) return false;
      if (user.is_root) return true;
      return Boolean(user.permissions?.[module]);
    },
    [user],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      isAuthenticated: Boolean(user),
      login,
      logout,
      refreshUser,
      hasAccess,
    }),
    [hasAccess, loading, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
