import { useLayoutEffect } from 'react';

/**
 * Minimal smoke shell for Task I1 — no features yet (those land in I2/J).
 * Renders the brand mark on the token surface. Also defensively (re-)sets
 * the RTL invariant on `<html>` itself: `index.html` already sets
 * `dir="rtl" lang="ar"`, but a component test that renders `<App />`
 * directly (skipping index.html, e.g. under jsdom) would otherwise never
 * see those attributes on `document.documentElement`.
 */
export default function App() {
  useLayoutEffect(() => {
    document.documentElement.dir = 'rtl';
    document.documentElement.lang = 'ar';
  }, []);

  return (
    <div className="min-h-dvh bg-paper text-ink">
      <span className="font-display text-3xl">مِرسال</span>
    </div>
  );
}
