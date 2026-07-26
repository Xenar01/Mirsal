/**
 * RFC 6266 `Content-Disposition` construction, shared by the authenticated
 * node download route and the public share download/zip routes. Centralised so
 * the CR/LF header-injection strip lives in exactly one place.
 */

/** ASCII-only fallback for the RFC 6266 `filename=` parameter (quoted-string safe). */
function asciiFallbackName(name: string): string {
  const out = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return out.length > 0 ? out : 'download';
}

/** Percent-encodes every UTF-8 byte outside RFC 5987's `attr-char` unreserved set. */
function percentEncodeUtf8(str: string): string {
  const bytes = Buffer.from(str, 'utf8');
  let out = '';
  for (const byte of bytes) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(ch)) {
      out += ch;
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

/**
 * Builds an RFC 6266 `Content-Disposition: attachment` header value. CR/LF
 * and other control characters are stripped from the name FIRST (header-
 * injection guard) before either encoding is derived.
 */
export function buildContentDisposition(rawName: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = rawName.replace(/[\r\n\x00-\x1F\x7F]/g, '');
  const ascii = asciiFallbackName(stripped);
  const encoded = percentEncodeUtf8(stripped);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
