/**
 * Damascus wall-clock <-> UTC epoch-ms conversion for the share/auto-delete
 * schedulers (§4.5 / Global Constraints).
 *
 * The owner always picks a datetime in **Asia/Damascus**; every API deadline is
 * **epoch-ms UTC**. A browser `<input type="datetime-local">` yields a bare
 * wall-clock string (`YYYY-MM-DDTHH:mm`) with NO zone — and the box's own TZ is
 * not guaranteed to be Damascus — so we convert explicitly against the named
 * `Asia/Damascus` zone rather than trusting `Date`'s local parsing. Syria has
 * been a fixed UTC+3 year-round since it abolished DST in 2022, but we derive
 * the offset from `Intl` at the instant in question so a future zone change (or
 * a historical date) still converts correctly.
 */

const DAMASCUS_TZ = 'Asia/Damascus';

const INPUT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * The offset (ms) that `Asia/Damascus` is ahead of UTC at a given UTC instant.
 * Formats the instant into Damascus wall-clock parts, reads them back as if
 * they were UTC, and takes the difference — the standard zone-offset probe.
 */
function damascusOffsetMs(utcInstant: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: DAMASCUS_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(utcInstant));
  const map: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = Number(p.value);
  }
  // Intl can emit hour "24" for midnight in some engines — normalise to 0.
  const hour = map.hour === 24 ? 0 : map.hour;
  const asIfUtc = Date.UTC(map.year, map.month - 1, map.day, hour, map.minute, map.second);
  return asIfUtc - utcInstant;
}

/**
 * Converts a Damascus wall-clock `datetime-local` value to a UTC epoch-ms.
 * Returns `null` for a malformed/empty value (the caller shows an inline error
 * and never calls the API).
 */
export function damascusInputToUtcMs(value: string): number | null {
  const m = INPUT_RE.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  // Guess: treat the wall clock as UTC, then subtract the zone offset. A second
  // pass re-probes the offset at the candidate instant so a value that lands
  // near a (hypothetical) DST transition still resolves cleanly.
  const guessUtc = Date.UTC(y, mo - 1, d, h, mi);
  const candidate = guessUtc - damascusOffsetMs(guessUtc);
  return guessUtc - damascusOffsetMs(candidate);
}

/**
 * Converts a UTC epoch-ms back to a Damascus wall-clock `datetime-local`
 * string (`YYYY-MM-DDTHH:mm`, Western digits) for pre-filling an input. Returns
 * an empty string for a non-finite input.
 */
export function utcMsToDamascusInput(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return '';
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: DAMASCUS_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(epochMs));
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const hour = map.hour === '24' ? '00' : map.hour;
  return `${map.year}-${map.month}-${map.day}T${hour}:${map.minute}`;
}
