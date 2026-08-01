# Mirsal — Mobile UI/UX + PWA design spec

- **Date:** 2026-08-01 (overnight autonomous session, user asleep — decisions made by the agent and documented here for morning review).
- **App:** Mirsal (مِرسال), Arabic-first full-RTL secure file-sharing SPA. React 19 + Vite + TanStack Query + react-i18next + Tailwind v4 (CSS `@theme`, logical properties). Design identity "Ink & Brass".
- **Branch:** `feat/mobile-pwa` off `main` (`f88f74b`, Phase 2).
- **Source of truth for the current state:** `docs/superpowers/notes/2026-08-01-mobile-audit.md` (read it first).
- **Gates:** `npm test` + `npm run typecheck` per workspace. No eslint. Commit per task; merge to main when green. **Do NOT deploy** (user reviews the mobile look first).

The audit found essentially zero responsive design today: every data table is a fixed-width `<table>` with only `overflow-x-auto`; tap targets are undersized; there is no PWA scaffolding (viewport meta only). Public flow, modals, and form inputs are already mobile-sound.

---

## Design principles (decisions)

1. **Breakpoint = Tailwind `md` (768px).** `< md` = phone / small-tablet layout; `≥ md` = the existing desktop layout, **unchanged**. This keeps every current desktop screen and its tests byte-identical.
2. **Table → card via the two-layout pattern, never in-place mutation.** For each data table:
   - wrap the existing `<table>`'s scroll container in `hidden md:block` (desktop keeps the table verbatim),
   - add a sibling `md:hidden` **card list** rendering the same rows from the same data/query.
   Extract the per-row derived values (labels, guards, handlers) so both layouts call the same logic — no duplicated business logic, only two presentations. This preserves all existing table tests (they run in jsdom which has no viewport, so both layouts render in tests; assert card presence via a `data-testid`).
3. **Card anatomy** (reuse existing tokens — `rounded-[10px] border border-line bg-surface`):
   - **Header row:** the primary identity — file/folder name + kind icon, or username — with `min-w-0` + `truncate` so long names never blow out the width. A trailing status/role chip may sit inline-end.
   - **Meta line:** secondary fields (size · date, or role · state · usage) in `text-xs text-ink-2`, wrapping.
   - **Action row:** the row's actions as a `flex flex-wrap gap-2` of the (now larger) chips. For the action-heavy screens (Drive ≤6, Users ≤7) the chips wrap to 2–3 rows — acceptable for v1. (A kebab/overflow menu using the existing unused `Drawer` is a noted future enhancement, not built now, to keep risk low.)
4. **Touch targets.** Introduce a shared min tap size. Chip actions get **`min-h-10`** (40px) via flex centering while keeping compact horizontal padding; icon-only buttons (Toast/Upload/Modal close) get **`min-h-10 min-w-10`** hit area; the primary `Button` floor rises to **`min-h-11`** (44px). Visual density is preserved (padding unchanged) — only the minimum box grows. WCAG 2.5.5 target.
5. **Headers wrap.** `DashboardShell` and `AdminPanel` header rows get `flex-wrap` and the username span gets `min-w-0 truncate max-w-[45vw]` so a long username never overlaps the logout control.
6. **Mobile nav.** Below `md`, `DashboardShell`'s `<aside>` nav becomes a **horizontal, scrollable pill strip** (`flex md:flex-col overflow-x-auto`) pinned at the top of the content column, with the `StorageMeter` following it (compact). Above `md` it stays the vertical rail. `AdminPanel` gets the same pill strip (Files / Shared / Trash / Admin) so mobile admins aren't stranded with only a text link. Keep it simple — no fixed bottom bar (avoids safe-area/overlap complexity).
7. **RTL + a11y preserved.** Logical properties only (`ps/pe/ms/me/text-start`); every new interactive element keeps a real label; `aria-*` and focus styles match existing components. No colour-only signals.
8. **Nothing below the shell changes behaviour.** These are presentation-layer additions; no API, route, or data change.

---

## PWA decisions

- **Icons (already generated, committed with this spec):** `web/public/icons/icon-192.png`, `icon-512.png` (transparent brass seal, `purpose: any`), `icon-maskable-512.png` (ink field + centered brass disc, safe-zone compliant, `purpose: maskable`), and `web/public/apple-touch-icon.png` (180, opaque). Derived from the in-app brass-seal `favicon.svg` via headless-Chrome rasterization.
- **Manifest** (`display: standalone`, `dir: rtl`, `lang: ar`): `name` "مِرسال", `short_name` "مِرسال", `description` (Arabic, one line), `start_url: "/"`, `scope: "/"`, `background_color: "#F4F5F3"` (paper light), `theme_color: "#12212F"` (surface dark — reads well behind the RTL header), `orientation: "portrait-primary"`, the four icons above (192 any, 512 any, 512 maskable, + apple-touch referenced from HTML).
- **theme-color meta** in `index.html`: a light/dark pair — `<meta name="theme-color" media="(prefers-color-scheme: light)" content="#F4F5F3">` and `…(prefers-color-scheme: dark) content="#0C1622">` — matching the `--paper` token so the mobile browser chrome blends with the app.
- **Service worker via `vite-plugin-pwa`** (`generateSW`/workbox, self-hosted — **no CDN**, CSP `script-src 'self'` stays intact):
  - `registerType: 'autoUpdate'`.
  - **`injectRegister: null`** — register manually in `main.tsx` via `import { registerSW } from 'virtual:pwa-register'` so the registration code is bundled (self-origin) and no inline script is injected (CSP has no `unsafe-inline` for scripts).
  - **Precache** only the app's own build output (JS/CSS/fonts/icons/`index.html`) via the default glob.
  - **`navigateFallback: '/index.html'`** for offline SPA route loads, **but** `navigateFallbackDenylist: [/^\/api\//, /^\/s\//]` so a `/api/*` or `/s/<token>` request is **never** served a cached shell — they always hit the network. This honors the standing rule: never cache anything under `/api/*` (auth cookies, file content, share metadata) or `/s/<token>` (secret-token pages).
  - **No `runtimeCaching`** for `/api` or `/s` — absence means default network passthrough (workbox only handles precache + navigation), so authenticated/secret responses are never stored.
  - The plugin injects the `<link rel="manifest">` and can inject the theme-color; keep the manifest link but author the theme-color pair by hand in `index.html` for the media-query pair.
- **CSP note:** the server (`server/src/app.ts`) sets `connectSrc: 'self'` and `script-src 'self'` — the SW file and its workbox runtime are same-origin, and `registerSW` is bundled, so no CSP directive needs to change. `manifest-src` is not restricted (falls back to `default-src 'self'`), so the same-origin manifest loads. Verify the built `dist/` emits `manifest.webmanifest` + `sw.js` + `workbox-*.js` and that `index.html` references them.

---

## Task breakdown (each: implement → quick review → commit on `feat/mobile-pwa`)

- **M0 (this commit):** design spec + mobile audit + generated icon set.
- **M1 — Mobile foundations:** the shared touch-target raise (chips + icon buttons + Button floor), header `flex-wrap`/username truncate on both shells, and the `SharedView` token `break-all` bug fix. Small, global, low-risk. Add/adjust smoke tests only where an existing test asserts a class.
- **M2 — Dashboard screens → responsive cards:** `DriveView` (primary; file/folder register), `TrashView`, `SharedView`. Two-layout pattern per §Design-principles-2/3. Card testids: `drive-card-<id>`, `trash-card-<id>`, `shared-card-<id>`. Keep existing table tests green; add one card-presence smoke test per screen.
- **M3 — Admin screens → responsive cards:** `UsersTable`, `SharesTable`, `AuditLog`. Same pattern. Testids `user-card-<id>` etc. The Users card must expose all row actions (wrapped) and the usage bar full-width. Keep the existing `admin.test.tsx` green (it targets `user-row-<id>` on the desktop table — both layouts render in jsdom, so scope any ambiguous queries).
- **M4 — Mobile nav:** `DashboardShell` aside → horizontal pill strip `< md`; `AdminPanel` gains the same strip. Keep `shell.test.tsx` green.
- **P1 — PWA:** `vite-plugin-pwa` dep + config (per §PWA), `manifest.webmanifest` content, `index.html` theme-color pair + apple-touch link, manual `registerSW` in `main.tsx`, TS types for the virtual module (`vite-plugin-pwa/client` in a `d.ts` or the vite env). Verify `npm run build` emits the SW + manifest and the denylist is present in the generated `sw.js`.
- **V — Verification:** full `npm test` + `npm run typecheck` both workspaces green; `npm run build` (web) succeeds and emits manifest+sw; headless-render `/login`, `/` (dashboard), and the admin users screen at a 390×844 viewport to visually confirm the mobile layouts; then merge to main.

## Acceptance
- Every existing test still passes; new smoke tests assert the responsive card lists exist and the touch-target/nav changes are present.
- `npm run build` (web) produces `dist/manifest.webmanifest`, `dist/sw.js` (with `/api/` + `/s/` in the navigateFallback denylist), and the icon set; `index.html` links the manifest + theme-color pair.
- No change to server, routes, API, or the CSP directives.
- Desktop (`≥ md`) layout and behaviour are unchanged (the table blocks are untouched, only wrapped).

## Out of scope (noted, not built)
- Kebab/overflow action menus (wrapped chips used instead for v1).
- Fixed bottom tab bar (horizontal pill strip used instead).
- Offline-first data caching (the SW is app-shell + static only; all data stays network-live by design).
- Push notifications / background sync.
