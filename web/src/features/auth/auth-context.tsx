import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { apiGet, apiPost, ApiError } from '../../lib/api';

/** The user shape the server returns from `/api/auth/login` and `/api/auth/me`. */
export interface PublicUser {
  id: number;
  username: string;
  role: string;
  mustChangePassword: boolean;
}

export interface AuthContextValue {
  user: PublicUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<PublicUser>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Holds the current session's user. On mount it probes `GET /api/auth/me`:
 * a 200 populates `user`, a 401 (no/invalid session) leaves it `null`. Plain
 * fetch here — TanStack Query is deferred to Phase J.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const me = await apiGet<PublicUser>('/auth/me');
      setUser(me);
    } catch (err) {
      // 401 → not signed in. Any other error (network, 5xx) also can't
      // establish a session, so fail closed to "logged out" rather than crash.
      if (!(err instanceof ApiError)) {
        // Surface unexpected non-API failures in dev without breaking the app.
        console.error('auth: /me probe failed', err);
      }
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    const res = await apiPost<{ user: PublicUser }>('/auth/login', { username, password });
    setUser(res.user);
    return res.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiPost('/auth/logout');
    } finally {
      setUser(null);
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an <AuthProvider>');
  }
  return ctx;
}
