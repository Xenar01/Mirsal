import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './styles/fonts';
import './styles/index.css';
import i18n, { dirForLang } from './i18n';
import { AuthProvider } from './features/auth/auth-context';
import { ToastProvider } from './components/Toast';
import AppRoutes from './app/router';

// Single app-wide TanStack Query client (resolves the Phase-I carry
// "TanStack Query provider deferred to J"). One retry is plenty for a LAN-local
// same-origin API; refetch-on-focus is off (this is not a live dashboard).
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

// Keep I1's RTL invariant on <html>. index.html already sets dir="rtl"
// lang="ar"; restate it here from the active i18n language so this entry
// holds even if it ever runs without that HTML shell. The app stays on `ar`
// (no switcher yet), so this resolves to rtl/ar exactly as before.
document.documentElement.lang = i18n.language;
document.documentElement.dir = dirForLang(i18n.language);

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('#root element not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <AuthProvider>
          <ToastProvider>
            <BrowserRouter>
              <AppRoutes />
            </BrowserRouter>
          </ToastProvider>
        </AuthProvider>
      </I18nextProvider>
    </QueryClientProvider>
  </StrictMode>
);
