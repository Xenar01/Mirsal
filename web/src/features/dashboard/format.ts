/**
 * Ledger-column formatting for the dispatch register (§4.5 / §4.6).
 *
 * Both helpers emit **Western 0–9 numerals only** — mono ledger data
 * (IBM Plex Mono carries ASCII only) that the register always renders inside a
 * `<bdi dir="ltr">` so it never scrambles in the RTL Arabic rows.
 */

/** Hard app-wide upload cap: 100 MB (spec §14 / global constraints). */
export const MAX_FILE_BYTES = 104_857_600;

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * Human-readable byte size with an ASCII unit, e.g. `0 B`, `2 KB`, `12.5 MB`.
 * Binary (1024) steps. Values ≥10 or whole numbers print with no decimal;
 * otherwise one decimal place. Never returns Arabic-Indic digits.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const exp = Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  if (exp === 0) return `${bytes} B`;
  const value = bytes / 1024 ** exp;
  const text = value >= 10 || Number.isInteger(value) ? String(Math.round(value)) : value.toFixed(1);
  return `${text} ${BYTE_UNITS[exp]}`;
}

/**
 * Fixed-zone timestamp formatter — dates render in **Asia/Damascus** (§4.5)
 * with Western numerals via the `en-CA` locale (yields `YYYY-MM-DD, HH:mm`).
 * Built once and reused. Returns `—` for a missing/invalid timestamp.
 */
const DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Damascus',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatDate(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return '—';
  return DATE_FORMAT.format(new Date(epochMs));
}
