import { Routes, Route, Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import LoginPage from '../features/auth/LoginPage';
import ChangePasswordPage from '../features/auth/ChangePasswordPage';
import RequireAuth from '../features/auth/RequireAuth';
import { useAuth } from '../features/auth/auth-context';
import DriveView from '../features/dashboard/DriveView';
import TrashView from '../features/dashboard/TrashView';

/**
 * Minimal i18n heading placeholder. The real dashboard/admin/trash/shared/
 * public UIs are Phase J — these exist only so the routes resolve and the
 * guard can be exercised.
 */
function PagePlaceholder({ titleKey }: { titleKey: string }) {
  const { t } = useTranslation();
  return (
    <main className="min-h-dvh bg-paper text-ink">
      <h1 className="font-display">{t(titleKey)}</h1>
    </main>
  );
}

function AdminPlaceholder() {
  const { t } = useTranslation();
  const { user } = useAuth();
  if (user?.role !== 'admin') {
    return (
      <main className="min-h-dvh bg-paper text-ink">
        <p role="alert">{t('admin.adminsOnly')}</p>
      </main>
    );
  }
  return <PagePlaceholder titleKey="admin.title" />;
}

/**
 * App route table. Uses `<Routes>` (not a data router) so it can be mounted
 * under either `<BrowserRouter>` (main.tsx) or `<MemoryRouter>` (tests). The
 * server does history fallback for non-`/api/`, non-`/s/*` GETs.
 */
export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      {/* Public share page (no auth); its server-side Referrer-Policy delivery
          is a later task. Placeholder heading only for now. */}
      <Route path="/s/:token" element={<PagePlaceholder titleKey="public.title" />} />

      <Route
        path="/"
        element={
          <RequireAuth>
            <DriveView />
          </RequireAuth>
        }
      />
      <Route
        path="/admin"
        element={
          <RequireAuth>
            <AdminPlaceholder />
          </RequireAuth>
        }
      />
      <Route
        path="/trash"
        element={
          <RequireAuth>
            <TrashView />
          </RequireAuth>
        }
      />
      <Route
        path="/shared"
        element={
          <RequireAuth>
            <PagePlaceholder titleKey="shared.title" />
          </RequireAuth>
        }
      />
      <Route
        path="/change-password"
        element={
          <RequireAuth>
            <ChangePasswordPage />
          </RequireAuth>
        }
      />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
