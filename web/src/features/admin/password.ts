/**
 * Client-side generation of a strong initial/reset password (spec §3.1). The
 * create form generates this with a CSPRNG (`crypto.getRandomValues`) and
 * submits it; the server never echoes it back, so the reveal-once panel is the
 * only place it is ever shown. It is never persisted or logged in the client.
 */

// A 64-char URL-safe alphabet (a power of two) so each random byte maps to one
// character with no modulo bias. ASCII only — the reveal panel renders it in
// IBM Plex Mono inside a `<bdi dir="ltr">`.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Default length — comfortably clears the ≥8 UI policy with real entropy. */
export const GENERATED_PASSWORD_LENGTH = 16;

/**
 * Returns a fresh random password of `length` characters drawn uniformly from
 * {@link ALPHABET} via `crypto.getRandomValues`. Throws if no CSPRNG is
 * available rather than silently falling back to a weak source.
 */
export function generatePassword(length: number = GENERATED_PASSWORD_LENGTH): string {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') {
    throw new Error('secure RNG unavailable');
  }
  const bytes = new Uint8Array(length);
  cryptoObj.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    // ALPHABET.length is exactly 64, so `byte & 63` is unbiased.
    out += ALPHABET[bytes[i] & 63];
  }
  return out;
}
