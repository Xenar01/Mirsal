import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './auth-context';

/** Route to which a user with `mustChangePassword` is forced. */
export const CHANGE_PASSWORD_PATH = '/change-password';

/**
 * Wraps a protected route element:
 * - while the initial `/me` probe is in flight → render nothing;
 * - no user → redirect to `/login`;
 * - user must change their password and isn't already on the change-password
 *   route → redirect there;
 * - otherwise render the protected children.
 */
export default function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return null;
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  if (user.mustChangePassword && location.pathname !== CHANGE_PASSWORD_PATH) {
    return <Navigate to={CHANGE_PASSWORD_PATH} replace />;
  }
  return <>{children}</>;
}
