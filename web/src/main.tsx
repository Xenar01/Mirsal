import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/fonts';
import './styles/index.css';
import App from './App';

// Defensive: index.html already sets dir="rtl" lang="ar" on <html>, but set
// them here too so the RTL invariant holds even if this entry ever runs
// without that HTML file (App itself also sets these — see App.tsx — this
// is the redundant, entry-point-level layer the task brief asks for).
document.documentElement.dir = 'rtl';
document.documentElement.lang = 'ar';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('#root element not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
