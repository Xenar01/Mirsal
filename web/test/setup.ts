import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

/**
 * jsdom does not implement `window.matchMedia`, so any component that reads a
 * media query (e.g. the Seal checking `prefers-reduced-motion`) would throw
 * "matchMedia is not a function". Install a default, NON-reduced mock here so
 * the common case just works. Individual tests that need the reduced-motion
 * branch override `window.matchMedia` to return `{ matches: true }` and
 * restore the original afterwards (see seal.test.tsx).
 */
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}
