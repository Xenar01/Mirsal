import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
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
  /**
   * The user's synthetic root node id — always concrete for an active user,
   * even a brand-new account whose root is still empty. Lets the drive create a
   * folder / move-to-root at an empty root without a child to derive it from.
   */
  rootNodeId: number;
  /** The admin-assigned quota in bytes, or null for unlimited. */
  quotaBytes: number | null;
  /** Bytes currently used (server-maintained; includes trashed-but-not-purged). */
  usedBytes: number;
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

  // Monotonic counter guarding every write to `user`. `refresh`, `login`, and
  // `logout` each capture the counter's value before making their network
  // call and only apply their result if it is still current when the call
  // resolves. Without this, the mount-time `/me` probe and a fast `login()`
  // race on the same `user` state: if the probe resolves after login (e.g. a
  // slow/queued request), its stale 401 would call `setUser(null)` and
  // silently log the just-authenticated user back out. Any newer operation
  // (a subsequent refresh/login/logout) bumps the counter, so a late
  // resolution is recognized as stale and its result is discarded.
  const requestSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    setLoading(true);
    try {
      const me = await apiGet<PublicUser>('/auth/me');
      if (requestSeqRef.current === seq) setUser(me);
    } catch (err) {
      // 401 → not signed in. Any other error (network, 5xx) also can't
      // establish a session, so fail closed to "logged out" rather than crash.
      if (!(err instanceof ApiError)) {
        // Surface unexpected non-API failures in dev without breaking the app.
        console.error('auth: /me probe failed', err);
      }
      if (requestSeqRef.current === seq) setUser(null);
    } finally {
      if (requestSeqRef.current === seq) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    const seq = ++requestSeqRef.current;
    // Bumping the counter supersedes any in-flight mount `/me` probe, whose
    // `finally` will then skip its `setLoading(false)`. So this operation owns
    // clearing `loading` — always, even on failure — or a probe raced by login
    // would leave `loading` stuck `true` and hang `RequireAuth` forever.
    try {
      const res = await apiPost<{ user: PublicUser }>('/auth/login', { username, password });
      if (requestSeqRef.current === seq) setUser(res.user);
      return res.user;
    } finally {
      if (requestSeqRef.current === seq) setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    try {
      // Only clear local state once the server confirms the session was
      // revoked. If this throws (network drop, blocked request, a 403 from a
      // stale/missing CSRF cookie, ...) the `user` state is left untouched —
      // the httpOnly `mirsal_session` cookie is still valid, so the UI must
      // keep showing the user as signed in rather than lie about a revocation
      // that didn't happen. The error propagates to the caller to surface.
      await apiPost('/auth/logout');
      if (requestSeqRef.current === seq) setUser(null);
    } finally {
      // Like `login`, this supersedes any in-flight probe, so it must clear
      // `loading` itself (regardless of success/failure) — leaving `user`
      // untouched on failure per the comment above.
      if (requestSeqRef.current === seq) setLoading(false);
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
