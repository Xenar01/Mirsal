// Flat ESLint config for the Mirsal monorepo (server + web workspaces).
// Non-type-checked typescript-eslint recommended (fast CI, low churn) +
// react-hooks for the web workspace. See
// docs/superpowers/specs/2026-08-05-mirsal-phase1-ci-design.md
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'web/dev-dist/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node-side code (server + all config files).
    files: ['**/*.{js,ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Allow intentionally-unused identifiers when prefixed with `_`.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Browser code + React hooks rules for the web workspace.
    files: ['web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Tests legitimately cast DB rows / responses to `any` for brevity; keep
    // no-explicit-any enforced for source (zero violations there today).
    files: ['**/*.test.{ts,tsx}', '**/test/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  // Must be LAST: turns off any ESLint stylistic rules that would conflict with
  // Prettier, so Prettier is the single source of truth for formatting.
  prettier,
);
