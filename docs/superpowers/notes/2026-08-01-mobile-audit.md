# Mirsal Web — Mobile-Readiness Audit

> Read-only analysis. No code changed. Target viewport for the assessment: ~360–414px wide (common Android/iPhone widths). Root: `/var/www/projects/mirsal/web`.

---

## A. Route / screen inventory

Router: `src/app/router.tsx` (React Router v7, `<Routes>`, mounted under `<BrowserRouter>` in `src/main.tsx`).

| Path | Auth | Element | File | Chrome/shell |
|---|---|---|---|---|
| `/login` | public | `LoginPage` | `src/features/auth/LoginPage.tsx` | `AuthCard` (`src/features/auth/AuthCard.tsx`) |
| `/change-password` | required (forced when `mustChangePassword`) | `ChangePasswordPage` | `src/features/auth/ChangePasswordPage.tsx` | `AuthCard` |
| `/` | required | `DriveView` | `src/features/dashboard/DriveView.tsx` | `DashboardShell` (`src/features/dashboard/DashboardShell.tsx`) |
| `/shared` | required | `SharedView` | `src/features/dashboard/share/SharedView.tsx` | `DashboardShell` |
| `/trash` | required | `TrashView` | `src/features/dashboard/TrashView.tsx` | `DashboardShell` |
| `/admin` | required, `role==='admin'` gate inside | `AdminPanel` | `src/features/admin/AdminPanel.tsx` | own header (NOT `DashboardShell`) + internal tab bar (Users/Shares/Audit) |
| `/s/:token` | public, bilingual AR/EN | `SealedDispatch` | `src/features/public/SealedDispatch.tsx` | `DispatchFrame` (`src/features/public/DispatchFrame.tsx`) |
| `*` | — | redirect to `/` | `router.tsx:65` | — |

Auth gate: `RequireAuth` — `src/features/auth/RequireAuth.tsx`.

**Shell/layout components:**
- `DashboardShell` (`src/features/dashboard/DashboardShell.tsx`) — header (brand + username + logout) + a flex row of `<aside>` nav rail (My Files / Shared / Trash [/ Admin if role=admin] + `StorageMeter`) and `<main>`. Used by `DriveView`, `TrashView`, `SharedView`. **This is the only place in the whole app with a responsive breakpoint** (`md:flex-row`, `md:w-60`, line 57–58) — below `md` the aside stacks above `<main>` as a full-width block.
- `AdminPanel` — its own header (duplicate of `DashboardShell`'s markup, not reused) + a `role="tablist"` tab bar + tab body. Does **not** get the nav rail back to Drive/Shared/Trash (only a text link "back to files").
- `AuthCard` (`src/features/auth/AuthCard.tsx`) — centered single card, used by `LoginPage` and `ChangePasswordPage`.
- `DispatchFrame` (`src/features/public/DispatchFrame.tsx`) — centered single card + AR/EN toggle, used only by `SealedDispatch` and its sub-screens (`PublicFile`, `PublicFolder`, `PasswordGate`, `EndScreen`, all under `src/features/public/`).

**Admin tabs** (`src/features/admin/AdminPanel.tsx:23-27`, state-driven, no sub-routes): `UsersTable` (`UsersTable.tsx`), `SharesTable` (`SharesTable.tsx`), `AuditLog` (`AuditLog.tsx`).

**Shared primitives:** `Modal` (`src/components/Modal.tsx`), `Drawer` (`src/components/Drawer.tsx` — **built but not wired into any route**, verified by grep: no import outside its own file/test/Modal-comment), `Button` (`src/components/Button.tsx`), `StatusChip` (`src/components/StatusChip.tsx`), `Toast`/`ToastProvider` (`src/components/Toast.tsx`), `Seal` (`src/components/Seal.tsx`), icon set (`src/components/icons/index.tsx`, 24×24 stroke icons, 13 exported glyphs).

---

## B. Design-system tokens

Tailwind v4 with **no `tailwind.config.*` file** — theme is defined entirely in CSS (`@theme inline` in `src/styles/index.css:9-33`, importing raw custom properties from `src/styles/tokens.css`). No PostCSS config file either (uses `@tailwindcss/vite` plugin, `vite.config.ts:7`).

**Colors** (`src/styles/tokens.css`) — "Ink & Brass", light values on bare `:root`, dark applied both via `@media (prefers-color-scheme: dark)` and `:root[data-theme="dark"]`, explicit light override via `:root[data-theme="light"]`:

| Token | Light hex | Dark hex | Tailwind utility |
|---|---|---|---|
| `--paper` | `#F4F5F3` | `#0C1622` | `bg-paper` / `text-paper` |
| `--surface` | `#FFFFFF` | `#12212F` | `bg-surface` |
| `--ink` | `#0F1C2E` | `#EAF0F2` | `text-ink` |
| `--ink-2` | `#45566A` | `#93A4B5` | `text-ink-2` |
| `--line` | `#E2E5E1` | `#23384B` | `border-line` |
| `--brass` | `#C0913C` | `#D2A24C` | `bg-brass` |
| `--brass-ink` | `#0F1C2E` | `#0C1622` | `text-brass-ink` |
| `--brass-ring` | `#7A5A20` | `#E3B667` | `border-brass-ring` (via `border-2`) |
| `--teal` | `#0E5A63` | `#6FC5CE` | `text-teal` |
| `--emerald` | `#24694B` | `#5FBF92` | `text-emerald` / `bg-emerald` (accent) |
| `--clay` | `#A13D28` | `#E08A74` | `text-clay` / `border-clay` |
| `--focus` | `#0E5A63` | `#6FC5CE` | `:focus-visible` outline only |

**Fonts** (`tokens.css:57-62`, self-hosted via `@fontsource`, imported in `src/styles/fonts.ts`):
- `--font-display` = `--font-body` = `"Cairo", system-ui, sans-serif` (weights 400/500/600/700 actually imported — `fonts.ts:12-15`). Cairo is Arabic-first — yes, this is an Arabic web font.
- `--font-mono` = `"IBM Plex Mono", ui-monospace, monospace` (weights 400/500 — `fonts.ts:18-19`).
- Note: `package.json` also lists `@fontsource/ibm-plex-sans-arabic` and `@fontsource/reem-kufi` as dependencies but **neither is imported in `fonts.ts`** — dead weight, not used anywhere (not a mobile concern, just a bundle-hygiene footnote).

**Type scale** (`tokens.css:48-55`): `--type-xs .75rem` … `--type-3xl 3rem`. Only `--type-3xl` is actually surfaced to Tailwind, as `--text-display` (`index.css:32`), and it's used in exactly one place app-wide: `App.tsx:19` (the smoke-shell brand mark, effectively dead in the real routed app). Every real screen uses Tailwind's **stock** `text-xs/sm/base/lg/xl` scale directly (grep confirms — e.g. `font-body text-sm`, `font-display text-lg` throughout). So in practice there is no custom fluid/responsive type scale in play; it's Tailwind's fixed rem sizes at every viewport.

**Spacing/radius conventions:** control radius `rounded-lg` (8px, per `Button.tsx` comment), card/panel radius `rounded-[10px]` (Modal, tables' wrapping `<div>`, AuthCard, DispatchFrame card, StorageMeter, toasts), `rounded-md` for small chip buttons, `rounded-full` for pills/progress bars. Padding is consistently logical (`ps-*`/`pe-*`, never `pl-*`/`pr-*`) — good RTL hygiene throughout.

**Responsive utilities already in use — grepped across all of `src/`:**
```
sm:   0 matches anywhere
md:   2 matches, BOTH in src/features/dashboard/DashboardShell.tsx (lines 57–58)
lg:   0 matches anywhere
xl:   0 matches anywhere
max-* (max-w/max-h): used only as fixed caps (max-w-md, max-w-sm, max-w-xl, max-w-xs, max-w-5xl) — none of these are breakpoint-conditional, they're just width ceilings on cards/modals
```
**Conclusion: there is essentially zero responsive design in this codebase today.** The single exception (`DashboardShell`'s `md:flex-row` nav-rail-to-sidebar switch) is the only viewport-conditional layout in the entire app. Every table, every modal, every action-button row is one fixed layout for all screen sizes and relies on `overflow-x-auto` (present on every data table) as the only mobile fallback.

---

## C. Per-screen mobile gaps (most severe first)

### C1. Admin → Users tab: table is unusable on a phone (CRITICAL)
**File:** `src/features/admin/UsersTable.tsx:91-122` (table), row actions `UsersTable.tsx:343-421`.
7 columns (username, display name, role, state, usage bar, created, actions) and **up to 7 row actions** (activate/deactivate, promote/demote, reset password, quota, label, delete, clear-space — `UsersTable.tsx:346-409`), each a bordered chip button (`ADMIN_ACTION`/`ADMIN_ACTION_DANGER`, `UsersTable.tsx:29-32`). The usage-bar cell alone forces `min-w-32` (128px, `UsersTable.tsx:173`). Total intrinsic row width is far beyond 360–414px; the wrapping `overflow-x-auto` div (`UsersTable.tsx:91`) means the admin must scroll horizontally to even see, let alone reach, most actions — on a touch device this is a real usability failure, not just a cosmetic one.
**Fix approach:** below a breakpoint (e.g. `md`), replace the `<table>` with a stacked card list — one card per user with username/role/state up top, the usage bar as a full-width row, and actions collapsed into an overflow/kebab menu (or a `Drawer`, which already exists and is unused) instead of 7 inline chips.

### C2. Drive register (file/folder listing): table overflow + dense action row (CRITICAL)
**File:** `src/features/dashboard/DriveView.tsx:260-292` (table), row `NodeRow` `DriveView.tsx:316-465`, actions `DriveView.tsx:439-462`.
5 columns; the actions cell can hold up to 6 chip buttons (download, share, auto-delete, rename, move, trash). This is the app's primary, highest-traffic screen and has the same `overflow-x-auto`-only mobile story as C1. The status column (`DriveView.tsx:395-437`) additionally stacks a `StatusChip` + copy button + up to 3 `SharePill`s per shared row, adding vertical bulk once the row is forced narrow.
**Fix approach:** same card/stacked pattern as C1 — folder/file name + icon as the card header, size/date as a small meta line, share status as a chip row, and the 6 actions collapsed into a kebab/overflow menu (primary action — Share, or Download for files — could stay as one visible button, rest behind "more").

### C3. Admin → Shares tab and Trash/Shared views: same table pattern, secondary severity (HIGH)
**Files:** `src/features/admin/SharesTable.tsx:41-104` (7 columns, 1 action), `src/features/dashboard/TrashView.tsx:54-104` (4 columns, 2 text-link actions), `src/features/dashboard/share/SharedView.tsx:50-68` (4 columns, 3 actions). Fewer actions than C1/C2 so less catastrophic, but still fixed-layout tables with no mobile alternative — will require horizontal scroll on a phone.
**Fix approach:** same stacked-card treatment; lower priority than C1/C2 since these have fewer columns/actions.

### C4. `SharedView` share token has no line-break/truncation safeguard (MEDIUM — concrete bug, not just density)
**File:** `src/features/dashboard/share/SharedView.tsx:118-120`:
```tsx
<bdi dir="ltr" className="font-mono text-ink">
  {share.token}
</bdi>
```
Unlike `AuditLog.tsx:91,95` (which defensively adds `break-all` to similar mono/bdi cells), this token cell has **no `break-all`/`truncate`**. A long opaque token will force that single table cell (and thus the whole row) wider than the viewport even before considering the other columns — an easy, isolated fix.
**Fix approach:** add `break-all` (matches the `AuditLog` precedent) or `truncate` + a tap-to-copy affordance.

### C5. Admin tables' `overflow-x-auto` wrapper conflicts with sticky/kebab-menu approach — plan before building (MEDIUM, process note)
All the data tables above wrap in `<div className="overflow-x-auto ...">`. If C1–C3 are fixed by adding a `md:hidden`/`hidden md:block` pair (table for ≥md, cards for <md) rather than trying to make the table itself responsive, this wrapper becomes irrelevant below `md` and can be left alone above `md`. Flagging so an implementer doesn't try to patch the existing table markup in place.

### C6. Touch targets: two clearly-undersized tiers (HIGH)
- **Chip action buttons** — `ROW_ACTION`/`ROW_ACTION_DANGER` in `DriveView.tsx:300-303`, `ADMIN_ACTION`/`ADMIN_ACTION_DANGER` in `UsersTable.tsx:29-32` — `px-2.5 py-1` with `text-xs` and **no explicit `min-h-*`**. Effective height ≈ 24px (4px+4px padding + ~16px line-height). Well under the ~40–44px commonly recommended minimum tap target (and under WCAG 2.5.5's 24px CSS-px floor too, once the icon-only ones below are counted).
- **Icon-only dismiss/close buttons** — `Modal.tsx:56-63` close button has `p-1` around a 20px icon (~28px total, borderline), but `Toast.tsx:95-102` dismiss (`Close size={18}`, no padding class beyond `inline-flex`) and `UploadDrop.tsx:176-183` dismiss (`Close size={16}`, no padding) are effectively icon-sized only (~16–18px) — clearly under any touch-target guideline.
- **Primary `Button` component itself is borderline:** `min-h-9` = 36px (`Button.tsx:41`) — below the ~40–44px convention, though acceptable-ish since it's the least-bad tier.
**Fix approach:** raise the chip/icon buttons to a shared `min-h-10`/`min-w-10` (40px) utility (or `min-h-11` for 44px), keeping the same visual (compact) padding via a larger invisible hit-area if the compact look must be preserved (e.g. `p-1` visual + `min-h-10 min-w-10` via flex centering).

### C7. Headers (`DashboardShell` + `AdminPanel`) don't wrap (MEDIUM)
**Files:** `DashboardShell.tsx:47`, `AdminPanel.tsx:56` — both `flex items-center justify-between gap-4` with **no `flex-wrap`**. Content is brand name + (link, on Admin) + username + logout button, all in one row. At 360px with a longer username this row has no fallback other than squeezing/overlapping since flex items won't wrap without `flex-wrap`; the username `<span>` also has no `truncate`/`max-w-*` safeguard.
**Fix approach:** add `flex-wrap` (or `truncate` + `min-w-0` on the username span) as a defensive minimum; ideally collapse to a simpler mobile header (hide username, keep only logout + a menu) below `sm`.

### C8. Admin panel has no way back into Drive/Shared/Trash nav rail on mobile (LOW/MEDIUM — IA gap, not a rendering bug)
`AdminPanel` does not use `DashboardShell`, so on mobile there's no nav rail at all inside `/admin` — only a single "back to files" text link (`AdminPanel.tsx:59-61`). Not broken, but inconsistent with the rest of the app and worth reconciling if the nav rail becomes a proper mobile nav (bottom tab bar / hamburger) in C-fixes above — `AdminPanel` should probably adopt whatever mobile nav pattern `DashboardShell` gets.

### C9. `DashboardShell` nav rail already adapts, but stacks *above* content (LOW — mostly OK, minor UX nit)
**File:** `DashboardShell.tsx:57-58,79`. Below `md` the `<aside>` (nav list + `StorageMeter`) stacks in normal document flow **above** `<main>`, full width. This is the one place mobile responsiveness already exists and it does prevent breakage, but it means every mobile page load shows nav links + a storage-meter card before the actual file list — extra scroll-past content on the screen users care about most (Drive). Consider a bottom tab bar or a collapsed/horizontal-scroll nav strip instead, once C1/C2 are addressed (higher priority).

### C10. Modals are close to mobile-ready already (LOW — mostly a positive finding)
**File:** `src/components/Modal.tsx:36-74`. `fixed inset-0 flex items-center justify-center p-4` + panel `max-h-[calc(100dvh-2rem)] w-full max-w-md` with a `shrink-0` header, scrollable body (`min-h-0 flex-1 overflow-y-auto`), and `shrink-0` footer. On a 360–414px screen this renders as a near-full-width, height-capped dialog with proper internal scrolling — already sound. `ShareModal`'s `ConfigureStep` additionally uses a `sticky bottom-0` publish bar inside the scroll body (`ShareModal.tsx:269`) so the primary action stays reachable on a long form — a good existing pattern. No urgent fix needed; only the *content* inside some modals (long forms with `datetime-local` + radio fieldsets) should be visually re-checked at 360px width once real device testing is possible, but nothing in the markup itself is fixed-width or liable to overflow.

### C11. `Drawer` component exists but is unused (LOW — opportunity, not a bug)
**File:** `src/components/Drawer.tsx`. Anchored to the inline-end edge, `w-full max-w-sm` (effectively full-bleed on a 360–414px screen already — no fix needed for the component itself), focus-trapped via the same `useDialog` hook as `Modal`. It is fully built and tested (`test/drawer.test.tsx`) but not wired into any route or feature. It's a ready-made building block for the kebab/overflow-menu or row-detail pattern suggested in C1/C2/C3.

### C12. Public download page (`/s/:token`) and share wizard: best-covered screens already (LOW — positive finding)
**Files:** `DispatchFrame.tsx:26-27` (`max-w-xl` cap, `px-4 py-6` outer padding — actual width on a 360px phone ≈ 328px, fits comfortably), `PublicFile.tsx`, `PublicFolder.tsx`, `PasswordGate.tsx`, `EndScreen.tsx` — all single-column, centered, `text-center` flows with one primary CTA and no tables. `UploadDrop.tsx` explicitly designs for mobile already — the code comment at `UploadDrop.tsx:14` states "the picker is the mobile path" (native file `<input type="file">` triggered by a button, drag-and-drop is a bonus for desktop only). These screens need the least work.

### C13. Forms/inputs: width and `dir` handling already correct (LOW — positive finding)
Every text/number/password/datetime-local input across `LoginPage`, `ChangePasswordPage`, `CreateUserModal`, `ShareModal`, `AutoDeleteMenu`, `PasswordGate` uses `w-full` and explicit `dir="ltr"` on ASCII/numeric fields (username, quota MB, password reveal, `datetime-local`) with `inputMode="numeric"` set where appropriate (e.g. `UsersTable.tsx:534`, `CreateUserModal.tsx:171`) — this already surfaces the correct mobile keyboard and there's no fixed-width input anywhere found in the grep. `datetime-local` inputs get the OS's native picker UI on mobile automatically, so no gap there either.

---

## D. PWA / meta readiness — current state (verbatim)

**`web/index.html`** (full file, 14 lines):
```html
<!doctype html>
<html dir="rtl" lang="ar">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <title>مِرسال</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```
- **Viewport meta:** present and correct (`width=device-width, initial-scale=1`).
- **theme-color meta:** **absent** — no `<meta name="theme-color">` anywhere.
- **manifest link:** **absent** — no `<link rel="manifest">`.
- **apple-touch-icon / other icon sizes:** **absent** — only the one SVG favicon link.
- **Service worker:** **absent** — no registration anywhere in `src/main.tsx` or elsewhere; grepped the whole `src/` tree for "pwa/manifest/service.?worker/workbox" — zero matches.

**`web/public/`** contents: only `favicon.svg` (a 32×32 SVG brass-seal icon, self-contained colors, no external refs). No `manifest.json`, no PNG icon set (192/512 etc.), no `apple-touch-icon.png`, no `sw.js`/`service-worker.js`.

**`web/vite.config.ts`** plugins: `react()` and `tailwindcss()` only (lines 6-7) — **no PWA plugin** (`vite-plugin-pwa` or similar) is configured, and it's not in `package.json` dependencies either.

**`web/dist/`** (already-built output, confirms the above): contains `favicon.svg`, `index.html`, `assets/*` (JS/CSS/font files) — no `manifest.json`, no service-worker file emitted.

**Conclusion:** the app is currently a plain SPA with correct viewport meta and nothing else PWA-related — no installability, no offline/caching layer, no theme-color for the mobile browser chrome/status bar. A PWA pass would need, at minimum: a web app manifest (name, short_name, icons at 192/512+maskable, theme_color, background_color, display:standalone, start_url), `<meta name="theme-color">` (ideally two, light/dark, matching `--surface`/`--paper` tokens), a real icon set (the existing brass-seal SVG is a good visual base to derive PNGs from), and a service worker (e.g. via `vite-plugin-pwa`) — which per the CLAUDE.md/memory context is a pending user request, and per the existing CSP-driven build comments in `vite.config.ts` (strict `script-src 'self'`, `font-src 'self'`, no `unsafe-inline`) any SW/manifest addition will need to respect the same CSP constraints already documented there. Also worth noting for that future work: the server's CSP and the app's own auth-cookie/token model mean any service-worker cache strategy must explicitly exclude `/api/*` and `/s/<token>` (per the existing PWA-related note already in project memory) — not evaluated further here since it's out of scope for this read-only audit.

---

## E. Test harness notes

- **Runner:** Vitest 4.1.10, configured in `web/vite.config.ts:26-30` — `environment: 'jsdom'`, `globals: true`, `setupFiles: ['./test/setup.ts']`.
- **Library:** `@testing-library/react` 16.3.2 + `@testing-library/jest-dom` 7.0.0 (matchers registered via `test/setup.ts:1`).
- **`test/setup.ts`** (23 lines) — installs a default non-reduced `window.matchMedia` mock (jsdom doesn't implement it; needed because `Seal.tsx` reads `prefers-reduced-motion`). Individual tests override it for the reduced-motion branch (see `test/seal.test.tsx`).
- **Test files present** (19 total, `web/test/`): `admin.test.tsx`, `api.test.ts`, `auth-context.test.tsx`, `button.test.tsx`, `dashboard.test.tsx`, `dialog-stack.test.tsx`, `drawer.test.tsx`, `login.test.tsx`, `meter-refresh.test.tsx`, `modal.test.tsx`, `public.test.tsx`, `router.test.tsx`, `seal.test.tsx`, `share.test.tsx`, `shell.test.tsx`, `statuschip.test.tsx`, `storage-meter.test.tsx`, `toast.test.tsx`. No dedicated responsive/viewport tests exist (jsdom has no real layout engine, so viewport-size assertions aren't meaningfully testable here anyway — any mobile-layout work should rely on manual/visual verification via `npm run dev` + browser devtools device toolbar, or `npm run build && npm run preview`, not new Vitest assertions on breakpoint classes... though asserting the *presence* of e.g. `md:hidden` on a card list vs. `hidden md:block` on a table is a reasonable smoke test pattern the existing suite already uses for other conditional classes).
- **Scripts** (`package.json:9-15`): `dev` (vite), `build` (vite build), `preview`, `test` (`vitest run`), `typecheck` (`tsc --noEmit`). No `lint` script exists (confirmed consistent with the standing project note: gates are `npm test` + `npm run typecheck` only, no ESLint configured).

---

## F. Prioritized punch-list (top ~12 concrete mobile improvements)

1. **Convert the Users admin table to a stacked card list below `md`** (C1) — highest-severity screen; 7 columns + up to 7 chip actions is unusable on a phone today.
2. **Convert the Drive register (file/folder table) to a stacked card list below `md`** (C2) — the app's primary screen; same overflow problem with up to 6 row actions.
3. **Raise all chip/icon-only button tap targets to ≥40px** (C6) — `ROW_ACTION`/`ROW_ACTION_DANGER` (Drive), `ADMIN_ACTION`/`ADMIN_ACTION_DANGER` (Users), Toast/UploadDrop/Modal close icons — a single shared utility class change covers most of these.
4. **Collapse row actions into an overflow/kebab menu** on the new card layouts (C1/C2) rather than trying to fit 6–7 buttons per card — reuse the existing but currently-unused `Drawer` component (C11) as the overflow surface if a full menu component isn't wanted.
5. **Convert Shares (admin), Trash, and Shared-view tables to the same card pattern** below `md` (C3) — same treatment as #1/#2, lower urgency (fewer columns/actions).
6. **Add `break-all` to the `SharedView` token cell** (C4) — one-line fix, `src/features/dashboard/share/SharedView.tsx:118-120`, matching the existing `AuditLog` precedent.
7. **Add `flex-wrap` (and truncate the username) on the `DashboardShell`/`AdminPanel` headers** (C7) — defends against overlap at narrow widths / long usernames.
8. **Design and build a proper mobile nav** (bottom tab bar, or a horizontally-scrollable strip) to replace/augment `DashboardShell`'s current "stack above content" `md:flex-row` fallback (C9), and give `AdminPanel` the same nav so mobile users aren't stranded without it (C8).
9. **Add PWA manifest** (`web/public/manifest.json` or `.webmanifest`) + `<link rel="manifest">` + icon set (derive 192/512/maskable PNGs from the existing brass-seal `favicon.svg`) (D).
10. **Add `<meta name="theme-color">`** matching the `--surface`/`--paper` tokens, ideally with a `media="(prefers-color-scheme: dark)"` pair for the dark variant (D).
11. **Add a service worker** (e.g. via `vite-plugin-pwa`) once the above manifest/icons land, taking care to exclude `/api/*` and `/s/<token>` from any cache strategy per the auth/token model, and to keep the CSP (`script-src 'self'`, no `unsafe-inline`) intact per the existing build comments in `vite.config.ts` (D).
12. **Re-verify Modal/ShareModal content at real 360px width on a device or devtools** (C10) — the modal shell itself is already sound; this is a lower-risk visual QA pass rather than a structural fix, worth doing once the above land.

Not included above but noted as already-good (no action needed): `UploadDrop`'s mobile-first file-picker design (C12), the public `/s/:token` flow's single-column layout (C12), and form input width/`dir`/`inputMode` handling app-wide (C13).
