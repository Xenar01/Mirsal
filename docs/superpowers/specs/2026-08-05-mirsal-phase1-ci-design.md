# Mirsal Phase 1 — CI Quality Backbone (design)

- **Date:** 2026-08-05
- **Status:** Approved (design); pending spec review → implementation plan
- **Part of:** the "make Mirsal a widely-publishable open-source self-hosted project" roadmap (Phase 1 of 6). Target model = open-source, self-hosted.

## Context & goal

Mirsal is a well-built single-container app (Fastify + better-sqlite3 + React/Vite),
with strong hand-run test discipline (**429 server + 238 web** tests, TDD) but **no
automation**: no CI, no lint, no formatter, no dependency/secret scanning. Before the
project can accept contributions from anyone or be published widely, every change must
be **automatically gated**.

**Goal:** a GitHub Actions gate that runs on every PR and push to `main` — lint,
format-check, typecheck, tests, and a build — plus secret scanning and automated
dependency updates. This is the foundation the rest of the roadmap rides on.

## Scope

**In (this slice — "core gate first"):**

1. ESLint (new) — flat config, zero-violation baseline.
2. Prettier (new) — one isolated reformat commit.
3. Root npm scripts as single CI entry points.
4. GitHub Actions CI workflow (lint/format/typecheck/test/build + docker build).
5. Secret scanning via gitleaks (current tree + PR diffs).
6. Dependabot config (npm workspaces + github-actions + docker).
7. Contributor niceties (`.nvmrc`).

**Explicitly deferred to a follow-on slice (Phase 1b):**

- Playwright browser E2E in CI.
- CodeQL SAST.
- Signed GHCR image publish + SBOM (premature while the repo is private; belongs with
  the release/public-flip work).

**Out of scope (other phases):** deep git-history secret scrub (Phase 0), durability/
encryption (Phase 2), portable deploy (Phase 3), email/i18n (Phase 4), external audit/
docs site (Phase 5).

## Design

### 1. ESLint — `eslint.config.js` (flat, repo root)

- One root flat config covering both workspaces, file-scoped:
  - Base: `typescript-eslint` **recommended** (non-type-checked — faster CI, lower churn
    than `recommended-type-checked`).
  - `web`: add `eslint-plugin-react-hooks` (rules-of-hooks + exhaustive-deps).
  - Stay close to the recommended preset. Do **not** add type-aware rules (e.g.
    `no-floating-promises`) in this slice — they require the slower typed lint and can
    land with a later hardening pass.
  - Ignores: `**/dist/`, `**/node_modules/`, `**/coverage/`, `web/dev-dist/`, generated
    PWA artifacts.
- Adoption: install → `eslint --fix` (auto-fix safe issues) → resolve the remainder by
  hand → **zero violations** so CI can gate. Test files included (they are real code).

### 2. Prettier

- `.prettierrc` (project defaults: single quotes, semicolons, trailing commas, print
  width matching current style ~120) + `.prettierignore` (dist, node_modules, coverage,
  lockfiles, generated assets).
- **One isolated commit** that reformats the whole tree; its SHA is recorded in
  `.git-blame-ignore-revs` so `git blame` skips it.
- `eslint-config-prettier` added last in the ESLint config to disable any stylistic
  rules that would conflict with Prettier (single source of truth for formatting).
- CI runs `prettier --check .`.

### 3. Root npm scripts

Currently root `package.json` has only `test`. Add:

- `lint` → `eslint .`
- `lint:fix` → `eslint . --fix`
- `format` → `prettier --write .`
- `format:check` → `prettier --check .`
- `typecheck` → `npm run typecheck --workspace=server && npm run typecheck --workspace=web`
- `build` → `npm run build --workspace=server && npm run build --workspace=web`
- (`test` already fans out to both workspaces.)

### 4. GitHub Actions — `.github/workflows/ci.yml`

- **Triggers:** `pull_request` and `push` to `main`.
- **Runtime:** `ubuntu-latest`, Node 20 (`actions/setup-node` with `cache: npm`),
  `npm ci` at root (installs both workspaces).
- **Jobs:**
  - `quality`: `lint` → `format:check` → `typecheck` → `test` → `build`.
  - `docker`: `docker build` against the repo Dockerfile — verifies the image builds.
    **No push** (publishing deferred).
  - `secrets`: gitleaks (see §5).
- Jobs run in parallel where independent; `quality` and `docker` share the `npm ci` only
  logically (each job installs its own deps — simplest, no artifact passing for this size).

### 5. Secret scanning — gitleaks

- gitleaks GitHub Action scanning the current tree + PR commits.
- `.gitleaks.toml` allowlist for **obvious test fixtures** (e.g. `'a'.repeat(32)`,
  `'b'.repeat(32)`, argon test params, seeded fake tokens) to avoid false positives.
- Phase-1 gitleaks gates **new** changes; a **deep full-history scrub** (git-filter-repo/
  BFG) is a separate Phase-0 task and MUST precede any public flip. If the initial
  gitleaks run surfaces real historical secrets, that is logged as a Phase-0 finding, not
  fixed here.

### 6. Dependabot — `.github/dependabot.yml`

- Config-only (no CI cost). Ecosystems: `npm` (root, workspaces-aware), `github-actions`,
  `docker` (base image). Weekly schedule, grouped minor/patch PRs to limit noise.
- Chosen over Renovate: native to GitHub, zero extra service, simpler for a self-host repo.

### 7. Contributor niceties

- `.nvmrc` pinning Node 20 for consistent local toolchains.

## Build & verification approach

- Branch: `chore/phase1-ci` (off `main` @ current HEAD).
- Commit sequence, each independently green:
  1. `chore: add ESLint flat config + zero-violation baseline` (+ root lint scripts).
  2. `style: adopt Prettier (bulk reformat)` (isolated; SHA → `.git-blame-ignore-revs`)
     - `eslint-config-prettier` + format scripts.
  3. `ci: GitHub Actions gate + gitleaks + Dependabot` (+ `.nvmrc`).
- **Local gates before pushing:** `npm run lint`, `npm run format:check`, `npm run
typecheck`, `npm test`, `npm run build`, and `docker compose build` all green.
- **Push branch + open a PR** so Actions actually runs; the real proof is watching the CI
  run go **green** on GitHub (`gh pr checks` / Actions UI).
- **Phase-pause:** stop at the green PR for user review before merging to `main`
  (per the save-often / phase-pause working agreement).

## Success criteria

- CI runs on the PR and is green: lint, format:check, typecheck, tests (429 + 238),
  build, docker build, and gitleaks all pass.
- `npm run lint` reports **zero** violations on the tree.
- Prettier `--check` is clean; the reformat is isolated and blame-ignored.
- Dependabot config is valid (GitHub accepts it).
- No production/runtime code behavior changes (this slice is tooling + formatting only).

## Risks / open items

- **Lint churn size is unknown until the ruleset runs.** Pragmatic (non-type-checked)
  keeps it moderate, but if a rule proves noisy on existing code we down-tune it to a
  warning (documented) rather than mass-editing logic. No behavioral code changes.
- **gitleaks history findings** → Phase 0, not fixed here (flagged if found).
- **Branch protection** (require CI green to merge) is a repo-admin setting, not a file;
  recommended but applied via repo settings / `gh api`, noted for the user to enable.
- **Prettier reformat is a large mechanical diff** — mitigated by isolating it in its own
  commit + `.git-blame-ignore-revs`.
