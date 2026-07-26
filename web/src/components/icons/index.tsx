import type { ReactNode } from 'react';

/*
 * Subject-grounded line-icon set (§4.7) — "Ink & Brass" dispatch register.
 *
 * A single coherent family: 24×24 canvas, 1.75 stroke, round caps + joins
 * (the shared "corner treatment"), stroke painted with `currentColor` so the
 * caller sets colour via text-* utilities. Deliberately NOT the stock Lucide
 * look — the brand glyphs carry dispatch cues (a dossier folder with a wax-seal
 * dot, a sealed envelope for share, a rubber stamp, an hourglass, a
 * calendar-stamp).
 *
 * Accessibility: pass `title` for a standalone, meaningful icon (renders
 * role="img" + <title>); omit it for a decorative icon that sits next to a
 * text label (renders aria-hidden="true"), which is the StatusChip / Button
 * case.
 */

export interface IconProps {
  /** Square edge length in px (width === height). Defaults to 24. */
  size?: number;
  className?: string;
  /** When given, the icon is exposed to AT as an image with this name. */
  title?: string;
}

function IconBase({
  size = 24,
  className,
  title,
  children,
}: IconProps & { children: ReactNode }) {
  const labelled = title !== undefined;
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
      className={className}
      role={labelled ? 'img' : undefined}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
    >
      {labelled ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

/* ── Brand-critical, subject-grounded glyphs (§4.7) ───────────────────── */

/** Dispatch dossier: a folder carrying a filing band + a small wax-seal dot. */
export function FolderDossier(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3 8.5c0-1.1.9-2 2-2h3.6l1.8 2H19c1.1 0 2 .9 2 2v6c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2V8.5Z" />
      <path d="M7 14.6h6" />
      <circle cx="16.4" cy="14.6" r="1.4" />
    </IconBase>
  );
}

/** Seal / send: a sealed envelope with a wax seal at the corner (= share). */
export function SealSend(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 7.5h10.5v9H4z" />
      <path d="M4 7.9l5.2 3.6 5.3-3.6" />
      <circle cx="17.5" cy="15" r="2.8" />
    </IconBase>
  );
}

/** Rubber stamp (= an active share). Domed handle, splayed base, ground line. */
export function Stamp(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M14.5 9V6.4a2.5 2.5 0 0 0-5 0V9l-2.3 3.2A2 2 0 0 0 8.8 15.4h6.4a2 2 0 0 0 1.6-3.2Z" />
      <path d="M5.5 19h13" />
    </IconBase>
  );
}

/** Hourglass (= auto-delete). Two mirrored frames meeting at the neck. */
export function Hourglass(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M6.5 3.5h11" />
      <path d="M6.5 20.5h11" />
      <path d="M8.5 3.5v3c0 1 .5 1.8 1.3 2.4L12 12l-2.2 3.1c-.8.6-1.3 1.4-1.3 2.4v3" />
      <path d="M15.5 3.5v3c0 1-.5 1.8-1.3 2.4L12 12l2.2 3.1c.8.6 1.3 1.4 1.3 2.4v3" />
    </IconBase>
  );
}

/** Calendar-stamp (= share expiry): a wall calendar with a seal impression. */
export function CalendarStamp(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="4" y="5.5" width="16" height="14.5" rx="2" />
      <path d="M4 9.5h16" />
      <path d="M8.5 3.5v3M15.5 3.5v3" />
      <circle cx="12" cy="14.8" r="2.4" />
    </IconBase>
  );
}

/** Dispatch sheet (= a file): a document with a folded corner + two rule lines. */
export function FileSheet(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M6.5 3.5h6.5l4.5 4.5v10.5a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z" />
      <path d="M13 3.5V8h4.5" />
      <path d="M8.5 13h7M8.5 16.2h4.5" />
    </IconBase>
  );
}

/* ── Utility glyphs used by the J1 primitives ─────────────────────────── */

/** Close (X) — Modal / Drawer / Toast dismiss control. */
export function Close(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </IconBase>
  );
}

/** Paused / stopped — two bars (a stopped share). */
export function Pause(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M9.5 5.5v13M14.5 5.5v13" />
    </IconBase>
  );
}

/** Copy — two overlapping sheets (copy the share link to the clipboard). */
export function Copy(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
    </IconBase>
  );
}
