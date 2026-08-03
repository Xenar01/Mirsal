import { Routes, Route, Navigate } from 'react-router-dom';
import LoginPage from '../features/auth/LoginPage';
import ChangePasswordPage from '../features/auth/ChangePasswordPage';
import RequireAuth from '../features/auth/RequireAuth';
import DriveView from '../features/dashboard/DriveView';
import TrashView from '../features/dashboard/TrashView';
import SharedView from '../features/dashboard/share/SharedView';
import AdminPanel from '../features/admin/AdminPanel';
import SealedDispatch from '../features/public/SealedDispatch';
import CollectionsView from '../features/collections/CollectionsView';
import CollectionDetail from '../features/collections/CollectionDetail';
import CollectPage from '../features/collect/CollectPage';

/**
 * App route table. Uses `<Routes>` (not a data router) so it can be mounted
 * under either `<BrowserRouter>` (main.tsx) or `<MemoryRouter>` (tests). The
 * server does history fallback for non-`/api/`, non-`/s/*` GETs.
 */
export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      {/* Public sealed-dispatch page (no auth). Bilingual (AR default, EN toggle
          flips to LTR); the server delivers Referrer-Policy: no-referrer. */}
      <Route path="/s/:token" element={<SealedDispatch />} />
      {/* Public Collections intake page (no auth), beside /s/:token. */}
      <Route path="/c/:token" element={<CollectPage />} />

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
            <AdminPanel />
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
            <SharedView />
          </RequireAuth>
        }
      />
      <Route
        path="/collections"
        element={
          <RequireAuth>
            <CollectionsView />
          </RequireAuth>
        }
      />
      <Route
        path="/collections/:id"
        element={
          <RequireAuth>
            <CollectionDetail />
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
