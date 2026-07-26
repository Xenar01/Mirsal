import { describe, test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import App from '../src/App';

const TOKENS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/styles/tokens.css'
);

describe('RTL shell (App)', () => {
  test('sets dir="rtl" and lang="ar" on the document root and renders the brand mark', () => {
    render(<App />);

    expect(document.documentElement.getAttribute('dir')).toBe('rtl');
    expect(document.documentElement.getAttribute('lang')).toBe('ar');
    expect(screen.getByText('مِرسال')).toBeInTheDocument();
  });
});

/**
 * jsdom does not run the full CSS cascade, so `getComputedStyle(...).
 * getPropertyValue('--paper')` would return `''` even when the token is
 * genuinely defined — a test built on that would silently pass on a missing
 * token. Instead we read `tokens.css` straight off disk and assert every
 * §4.1 token name is textually present, per selector, so a missing/renamed
 * token fails this test for the right reason.
 */
describe('design tokens (tokens.css, §4.1)', () => {
  const REQUIRED_TOKENS = [
    '--paper',
    '--surface',
    '--ink',
    '--ink-2',
    '--line',
    '--brass',
    '--brass-ink',
    '--brass-ring',
    '--teal',
    '--emerald',
    '--clay',
    '--focus',
  ] as const;

  /**
   * Returns the contents of the `{ ... }` block whose opening brace is the
   * first `{` at or after `selectorRegex`'s match in `text`, using
   * brace-depth counting (not a non-nested-brace regex) so it correctly
   * skips over nested blocks — e.g. the `:root { ... }` nested inside
   * `@media (prefers-color-scheme: dark) { ... }`.
   */
  function blockAfter(text: string, selectorRegex: RegExp): string {
    const match = selectorRegex.exec(text);
    if (!match) {
      throw new Error(`selector not found in tokens.css: ${selectorRegex}`);
    }
    const openIdx = text.indexOf('{', match.index);
    if (openIdx === -1) {
      throw new Error(`no "{" after selector match: ${selectorRegex}`);
    }
    let depth = 0;
    for (let i = openIdx; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) return text.slice(openIdx + 1, i);
      }
    }
    throw new Error(`unbalanced braces after selector: ${selectorRegex}`);
  }

  const css = fs.readFileSync(TOKENS_PATH, 'utf-8');

  // Light: the bare, top-level `:root { ... }` (must start at column 0, so
  // this doesn't also match the indented `:root` nested inside @media).
  const lightBlock = blockAfter(css, /^:root\s*\{/m);

  // Dark (OS preference): the `:root { ... }` nested inside the
  // prefers-color-scheme media query.
  const mediaDarkOuter = blockAfter(
    css,
    /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{/
  );
  const mediaDarkBlock = blockAfter(mediaDarkOuter, /:root\s*\{/);

  // Dark (explicit theme-toggle override).
  const dataThemeDarkBlock = blockAfter(
    css,
    /:root\[data-theme=["']dark["']\]\s*\{/
  );

  // Light (explicit theme-toggle override — must win over a dark OS
  // preference).
  const dataThemeLightBlock = blockAfter(
    css,
    /:root\[data-theme=["']light["']\]\s*\{/
  );

  test.each(REQUIRED_TOKENS)('%s is defined for light (:root)', (token) => {
    expect(lightBlock).toMatch(new RegExp(`${token}\\s*:\\s*#`));
  });

  test.each(REQUIRED_TOKENS)(
    '%s is defined for dark (@media prefers-color-scheme: dark)',
    (token) => {
      expect(mediaDarkBlock).toMatch(new RegExp(`${token}\\s*:\\s*#`));
    }
  );

  test.each(REQUIRED_TOKENS)(
    '%s is defined for dark (:root[data-theme="dark"])',
    (token) => {
      expect(dataThemeDarkBlock).toMatch(new RegExp(`${token}\\s*:\\s*#`));
    }
  );

  test.each(REQUIRED_TOKENS)(
    '%s is restated for light (:root[data-theme="light"])',
    (token) => {
      expect(dataThemeLightBlock).toMatch(new RegExp(`${token}\\s*:\\s*#`));
    }
  );
});
