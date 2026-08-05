# Mirsal Phase 1 — CI Quality Backbone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a GitHub Actions gate (lint, format-check, typecheck, tests, build, docker build), secret scanning, and automated dependency updates so every change to Mirsal is automatically verified.

**Architecture:** Monorepo (npm workspaces: `server`, `web`). A single root ESLint flat config + Prettier provide static analysis and formatting; new root npm scripts are the CI entry points; `.github/workflows/ci.yml` runs the gates on every PR and push to `main`. This slice is **tooling + formatting only — no runtime/behavioral code changes.**

**Tech Stack:** Node 20, npm workspaces, ESLint 9 (flat config) + typescript-eslint + eslint-plugin-react-hooks, Prettier + eslint-config-prettier, GitHub Actions, gitleaks, Dependabot.

## Global Constraints

- **Node 20** (already pinned in every `package.json` `engines`). Add `.nvmrc` = `20`.
- **No runtime behavior changes.** Lint fixes must be mechanical/safe; if a rule is noisy on existing intentional code, down-tune it (to `warn` or `off`) with a one-line comment rather than editing logic.
- **Existing style, preserved:** single quotes, semicolons, trailing commas, ~120 print width, 2-space indent. Prettier config must match so the reformat diff is formatting-only.
- **Baseline definition:** "zero-violation baseline" = **zero ESLint errors**. Warnings (e.g. `react-hooks/exhaustive-deps`) are surfaced but NOT CI-blocking in this slice.
- **Gates stay green:** server **429** + web **238** tests, both `typecheck`s, both `build`s must pass unchanged throughout.
- **Commit trailer:** end every commit message with
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- **Branch:** all work on `chore/phase1-ci` (already created off `main`). Deferred (NOT in this plan): Playwright E2E, CodeQL, GHCR image publish + SBOM.

## File Structure

- Create `eslint.config.js` (root) — flat ESLint config for both workspaces.
- Create `.prettierrc`, `.prettierignore` (root) — formatting config.
- Create `.git-blame-ignore-revs` (root) — hides the bulk-reformat commit from blame.
- Create `.nvmrc` (root) — Node 20.
- Create `.gitleaks.toml` (root) — secret-scan config + test-fixture allowlist.
- Create `.github/workflows/ci.yml` — the CI gate.
- Create `.github/dependabot.yml` — dependency updates.
- Modify `package.json` (root) — add devDeps + `lint`, `lint:fix`, `format`, `format:check`, `typecheck`, `build` scripts.
- Modify source files ONLY as needed to reach zero ESLint errors + apply Prettier (formatting).

---

### Task 1: ESLint flat config + zero-error baseline

**Files:**
- Create: `eslint.config.js`
- Modify: `package.json` (root) — devDeps + `lint`/`lint:fix` scripts
- Modify: source files under `server/`, `web/` only as needed to clear ESLint errors

**Interfaces:**
- Produces: root scripts `npm run lint` (exits 0 = zero errors) and `npm run lint:fix`; a committed `eslint.config.js` that later tasks (Prettier, CI) build on.

- [ ] **Step 1: Install ESLint toolchain as root dev dependencies**

```bash
cd /var/www/projects/mirsal
npm install -D -w . eslint@^9 typescript-eslint@^8 @eslint/js@^9 eslint-plugin-react-hooks@^5 globals@^15
```
(`-w .` installs at the workspace root, not inside `server`/`web`.)

- [ ] **Step 2: Create `eslint.config.js` (flat config)**

```js
// Flat ESLint config for the Mirsal monorepo (server + web workspaces).
// Non-type-checked typescript-eslint recommended (fast CI, low churn) +
// react-hooks for the web workspace. See docs/superpowers/specs/2026-08-05-mirsal-phase1-ci-design.md
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'web/dev-dist/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node-side code (server + all config files).
    files: ['**/*.{js,ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node },
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
  }
);
```

- [ ] **Step 3: Add `lint` + `lint:fix` scripts to root `package.json`**

In root `package.json` `"scripts"`, add:
```json
"lint": "eslint .",
"lint:fix": "eslint . --fix"
```

- [ ] **Step 4: Run lint to see the initial violations (the "failing" state)**

Run: `npm run lint`
Expected: a non-zero exit with a list of errors/warnings (this is the RED state — the codebase has never been linted).

- [ ] **Step 5: Auto-fix the safe ones**

Run: `npm run lint:fix`
Then re-run `npm run lint` and read the REMAINING errors.

- [ ] **Step 6: Resolve remaining ERRORS to zero (decision procedure)**

For each remaining **error**, apply exactly one of:
1. **Genuine dead/incorrect code** (unused var, unreachable, shadow) → remove/fix minimally. No behavior change.
2. **Intentional pattern the rule dislikes** (e.g. a deliberate `any`, an empty catch) → prefer a targeted fix; if the rule is pervasive and low-value on existing code, set it to `'warn'` or `'off'` in `eslint.config.js` with a `// Phase 1: <reason>` comment. NEVER rewrite runtime logic to satisfy a stylistic rule.
Re-run `npm run lint` until it exits **0 errors** (warnings allowed).

- [ ] **Step 7: Prove nothing broke**

Run: `npm run typecheck --workspace=server && npm run typecheck --workspace=web && npm test`
Expected: typecheck clean; **429 server + 238 web tests pass**. If any lint fix changed behavior, revert it and down-tune the rule instead.

- [ ] **Step 8: Commit**

```bash
git add eslint.config.js package.json package-lock.json server web
git commit -m "chore(ci): add ESLint flat config + zero-error baseline

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Prettier + isolated bulk reformat

**Files:**
- Create: `.prettierrc`, `.prettierignore`, `.git-blame-ignore-revs`
- Modify: `eslint.config.js` (append `eslint-config-prettier`), `package.json` (root — `format`/`format:check` scripts + devDeps)
- Modify: all formatted source files (one mechanical commit)

**Interfaces:**
- Consumes: `eslint.config.js` from Task 1.
- Produces: root scripts `npm run format` and `npm run format:check`; a formatting-clean tree; a `.git-blame-ignore-revs` listing the reformat commit SHA.

- [ ] **Step 1: Install Prettier + eslint-config-prettier**

```bash
cd /var/www/projects/mirsal
npm install -D -w . prettier@^3 eslint-config-prettier@^9
```

- [ ] **Step 2: Create `.prettierrc`**

```json
{
  "singleQuote": true,
  "semi": true,
  "trailingComma": "all",
  "printWidth": 120,
  "tabWidth": 2,
  "arrowParens": "always"
}
```

- [ ] **Step 3: Create `.prettierignore`**

```
**/dist
**/node_modules
**/coverage
web/dev-dist
package-lock.json
*.min.*
```

- [ ] **Step 4: Wire `eslint-config-prettier` in as the LAST config entry**

In `eslint.config.js`, add the import and append it last so it disables any stylistic ESLint rules that conflict with Prettier:
```js
import prettier from 'eslint-config-prettier';
// ...at the very end of the tseslint.config(...) argument list:
  prettier
);
```

- [ ] **Step 5: Add `format` + `format:check` scripts to root `package.json`**

```json
"format": "prettier --write .",
"format:check": "prettier --check ."
```

- [ ] **Step 6: Confirm ESLint is still clean after adding prettier-config**

Run: `npm run lint`
Expected: still **0 errors** (eslint-config-prettier only turns rules off).

- [ ] **Step 7: Run the bulk reformat**

Run: `npm run format`
This rewrites files to Prettier style (a large, mechanical diff).

- [ ] **Step 8: Prove the reformat is safe (formatting-only)**

Run: `npm run lint && npm run format:check && npm run typecheck --workspace=server && npm run typecheck --workspace=web && npm test`
Expected: lint 0 errors; `format:check` clean; typecheck clean; **429 + 238 tests pass**.

- [ ] **Step 9: Commit the reformat as ONE isolated commit**

```bash
git add -A
git commit -m "style(ci): adopt Prettier (bulk reformat, no logic changes)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 10: Record the reformat commit in `.git-blame-ignore-revs`, then commit that**

```bash
REFORMAT_SHA=$(git rev-parse HEAD)
printf '# Bulk Prettier reformat (Phase 1) — ignored by git blame\n%s\n' "$REFORMAT_SHA" > .git-blame-ignore-revs
git add .git-blame-ignore-revs .prettierrc .prettierignore eslint.config.js package.json package-lock.json
git commit -m "chore(ci): add Prettier config + blame-ignore the reformat commit

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```
(Note: `.prettierrc`/`.prettierignore`/config/deps are added here if not already staged in Step 9; run `git status` first and stage whatever is untracked.)

---

### Task 3: CI workflow + gitleaks + Dependabot + root scripts + .nvmrc

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/dependabot.yml`, `.gitleaks.toml`, `.nvmrc`
- Modify: `package.json` (root — add `typecheck` + `build` scripts)

**Interfaces:**
- Consumes: `npm run lint`, `format:check` (Tasks 1–2).
- Produces: root scripts `npm run typecheck` and `npm run build`; a CI workflow gating PRs and `main`.

- [ ] **Step 1: Add root `typecheck` + `build` scripts to `package.json`**

```json
"typecheck": "npm run typecheck --workspace=server && npm run typecheck --workspace=web",
"build": "npm run build --workspace=server && npm run build --workspace=web"
```

- [ ] **Step 2: Verify the root aggregate scripts work**

Run: `npm run typecheck && npm run build`
Expected: both workspaces typecheck clean and build successfully.

- [ ] **Step 3: Create `.nvmrc`**

```
20
```

- [ ] **Step 4: Create `.gitleaks.toml`**

```toml
title = "Mirsal gitleaks config"

[extend]
useDefault = true

# The test suite embeds obviously-fake secrets (e.g. 'a'.repeat(32) session/csrf
# secrets, seeded fake tokens). Allowlist the test trees so they don't trip the
# scan. A deep git-history scrub is a separate Phase-0 task.
[allowlist]
description = "Fake secrets in tests"
paths = [
  '''server/test/.*''',
  '''web/test/.*''',
  '''.*\.test\.ts$''',
  '''.*\.test\.tsx$''',
]
regexes = [
  '''['"][ab]['"]\.repeat\(32\)''',
]
```

- [ ] **Step 5: Create `.github/dependabot.yml`**

```yaml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    groups:
      minor-and-patch:
        update-types: ["minor", "patch"]
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
  - package-ecosystem: "docker"
    directory: "/"
    schedule:
      interval: "weekly"
```

- [ ] **Step 6: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: '.nvmrc'
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run format:check
      - run: npm run typecheck
      - run: npm test
      - run: npm run build

  docker:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - name: Build image (no push)
        uses: docker/build-push-action@v6
        with:
          context: .
          push: false

  secrets:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run gitleaks (current tree only; history scrub is Phase 0)
        run: |
          docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:latest \
            detect --no-git --source /repo --config /repo/.gitleaks.toml --redact -v
```

- [ ] **Step 7: Locally dry-run every gate the `quality` job runs**

Run: `npm ci && npm run lint && npm run format:check && npm run typecheck && npm test && npm run build`
Expected: all green.

- [ ] **Step 8: Locally dry-run the docker + secrets jobs**

Run:
```bash
docker compose build
docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:latest detect --no-git --source /repo --config /repo/.gitleaks.toml --redact -v
```
Expected: image builds; gitleaks exits 0 (no leaks). If gitleaks flags a real secret in the current tree, STOP and report it (do not commit a secret); if it flags a test fixture, widen the `.gitleaks.toml` allowlist and re-run.

- [ ] **Step 9: Commit**

```bash
git add .github .gitleaks.toml .nvmrc package.json
git commit -m "ci: GitHub Actions gate + gitleaks + Dependabot

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Push, open PR, and watch CI go green (verification)

**Files:** none (verification + integration).

**Interfaces:**
- Consumes: everything from Tasks 1–3 on `chore/phase1-ci`.
- Produces: a green CI run on a PR; a phase-pause checkpoint for user review before merge.

- [ ] **Step 1: Final full local gate**

Run: `npm run lint && npm run format:check && npm run typecheck && npm test && npm run build && docker compose build`
Expected: all green.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin chore/phase1-ci
```

- [ ] **Step 3: Open a PR**

```bash
gh pr create --base main --head chore/phase1-ci \
  --title "Phase 1: CI quality backbone" \
  --body "ESLint + Prettier + GitHub Actions gate (lint/format/typecheck/tests/build/docker) + gitleaks + Dependabot. Tooling only, no runtime changes. Spec: docs/superpowers/specs/2026-08-05-mirsal-phase1-ci-design.md"
```

- [ ] **Step 4: Watch CI run to completion**

Run: `gh pr checks --watch` (or `gh run watch`)
Expected: `quality`, `docker`, `secrets` all **pass**.

- [ ] **Step 5: If any job is red, fix → recommit → repush → re-watch**

Read the failing job log (`gh run view --log-failed`), fix on the branch, commit (with the trailer), `git push`, and re-watch until green. Common first-run fixes: a lint rule that behaves differently on the CI Node vs local (pin behavior in config), or a gitleaks false positive (widen allowlist).

- [ ] **Step 6: STOP — phase-pause checkpoint**

Do NOT merge. Report to the user: PR URL, the green CI run, the reformat-commit SHA, and the total lint churn. Wait for explicit approval to merge `chore/phase1-ci` → `main`. (Merging + optionally enabling branch protection is the post-approval step.)

---

## Self-Review

**1. Spec coverage:**
- §1 ESLint flat config + zero-error baseline → Task 1. ✅
- §2 Prettier isolated reformat + blame-ignore + eslint-config-prettier → Task 2. ✅
- §3 root scripts (lint/format/typecheck/build) → Tasks 1 (lint), 2 (format), 3 (typecheck/build). ✅
- §4 CI workflow (quality + docker + secrets jobs) → Task 3 Step 6. ✅
- §5 gitleaks + allowlist → Task 3 Steps 4, 6, 8. ✅
- §6 Dependabot → Task 3 Step 5. ✅
- §7 `.nvmrc` → Task 3 Step 3. ✅
- Build/verify approach (branch, 3 green commits, local gates, push+PR+watch, phase-pause) → Tasks 1–4. ✅
- Success criteria (green CI, zero lint errors, clean format:check, valid Dependabot, no behavior change) → Task 4 Step 4 + Global Constraints. ✅
- Deferred items (Playwright/CodeQL/GHCR) → excluded, noted in Global Constraints. ✅

**2. Placeholder scan:** Config file contents are concrete. The one inherently-discovery step (Task 1 Step 6, resolving unknown lint violations) is specified as an explicit decision procedure, not a vague "fix errors." Gitleaks image is `zricethezav/gitleaks:latest` (pinned by tag `latest` intentionally so it self-updates; if a job needs reproducibility later, pin a version). No TBD/TODO.

**3. Type consistency:** Script names are consistent across tasks (`lint`, `lint:fix`, `format`, `format:check`, `typecheck`, `build`); `eslint.config.js` is created in Task 1 and only appended to in Task 2; `.gitleaks.toml` path/flags match between Task 3 Step 6 (CI) and Step 8 (local dry-run).
