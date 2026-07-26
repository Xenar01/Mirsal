/**
 * Public-page date + text helpers (§4.5). Dates always render in
 * **Asia/Damascus** with **Western numerals**; the AR view reuses the
 * dashboard's ledger formatter, while the EN view gets an EN-readable long
 * form ("January 5, 2026").
 */
import { formatDate } from '../dashboard/format';

const EN_EXPIRY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Damascus',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

/** Formats a share-expiry instant for the current public language (Damascus zone, Western digits). */
export function formatExpiry(epochMs: number | null, lang: string): string {
  if (epochMs === null || !Number.isFinite(epochMs)) return '—';
  return lang === 'en' ? EN_EXPIRY.format(new Date(epochMs)) : formatDate(epochMs);
}

// Unicode bidi isolates (kept as code points so the source stays pure ASCII):
// LRI = Left-to-Right Isolate, PDI = Pop Directional Isolate.
const LRI = String.fromCharCode(0x2066);
const PDI = String.fromCharCode(0x2069);

/**
 * Wraps a string in a Left-to-Right Isolate (U+2066 … U+2069) — the
 * character-level equivalent of `<bdi dir="ltr">`. Used for a Latin/number run
 * (a date) interpolated INTO an Arabic sentence via i18next, where an element
 * wrapper isn't available, so the run can't scramble the surrounding RTL text.
 * The isolate characters are invisible; the visible copy stays verbatim.
 */
export function isolateLtr(value: string): string {
  return `${LRI}${value}${PDI}`;
}

/**
 * Derives a short uppercase "type" tag from a file name's extension
 * (e.g. `report.PDF` → `PDF`), or null when there's no usable extension. The
 * public file-share metadata endpoint intentionally does not expose a MIME
 * type, so the type shown to a recipient is derived client-side from the name
 * they can already see — no new server data, no oracle.
 */
export function fileTypeLabel(name: string): string | null {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return match ? match[1].toUpperCase() : null;
}
