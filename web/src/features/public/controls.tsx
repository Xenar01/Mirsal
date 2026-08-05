import type { ReactNode } from 'react';

/*
 * Public-page action controls.
 *
 * `PrimaryLink` is the recipient's unambiguous primary CTA (Download / Download
 * all). It is an ANCHOR — a same-origin navigation triggers the browser's own
 * file handling (RFC-6266 attachment) and carries the path-scoped unlock cookie
 * (§3.5) — but it wears the exact §4.1 primary recipe as `Button variant=
 * "primary"`: a brass FILL with a `--brass-ink` label (never white-on-brass,
 * never brass-as-text). `data-variant="primary"` marks it as the primary action
 * for assertions and parity with the button primitive.
 */
export function PrimaryLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      data-variant="primary"
      className="inline-flex items-center justify-center gap-2 rounded-lg font-body text-sm ps-4 pe-4 py-2 min-h-9 bg-brass text-brass-ink"
    >
      {children}
    </a>
  );
}

/*
 * `PrimaryButton` is the same §4.1 primary recipe as `PrimaryLink` but rendered
 * as a `<button type="submit">` so it can drive a POST `<form>` — the counted
 * file download (§6) is a POST, so a passive GET (unfurler / scanner / prefetch)
 * can never burn or bypass a share's download cap. Identical brass FILL +
 * `--brass-ink` label and `data-variant="primary"` marker, so the recipient sees
 * (and assertions treat) it as the one unambiguous primary action.
 */
export function PrimaryButton({ children, type = 'submit' }: { children: ReactNode; type?: 'submit' | 'button' }) {
  return (
    <button
      type={type}
      data-variant="primary"
      className="inline-flex items-center justify-center gap-2 rounded-lg font-body text-sm ps-4 pe-4 py-2 min-h-9 bg-brass text-brass-ink"
    >
      {children}
    </button>
  );
}

/**
 * Download glyph — a sheet arrow into a tray, drawn to match the §4.7 icon
 * family (24×24, 1.75 stroke, round caps/joins, `currentColor`). Kept local to
 * the public feature so J1's shared icon set stays untouched. Decorative
 * (`aria-hidden`) — it always sits next to a text label.
 */
export function DownloadGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 4v10.5" />
      <path d="M7.5 10.5 12 15l4.5-4.5" />
      <path d="M5 19.5h14" />
    </svg>
  );
}
