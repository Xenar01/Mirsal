const MAX_NAME_LENGTH = 255;

/**
 * Sanitizes a client-supplied node name (upload filename or department label):
 * strips control chars, trims, caps length, rejects empty / path-separator /
 * `.` / `..`. Returns null if unusable. Names are display strings only —
 * storage paths are always `${ownerId}/${nodeId}`, never the client name.
 *
 * NOTE: `routes/nodes.ts` keeps its own private copy of this logic; a future
 * cleanup can DRY it onto this module (behavior is identical, covered by
 * nodes.test.ts). Kept separate here to avoid touching the deployed upload path.
 */
export function sanitizeNodeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  let name = raw.replace(/[\x00-\x1F\x7F]/g, '');
  name = name.trim();
  if (name.length === 0) return null;
  if (name.length > MAX_NAME_LENGTH) name = name.slice(0, MAX_NAME_LENGTH);
  if (name.includes('/') || name.includes('\\')) return null;
  if (name === '.' || name === '..') return null;
  return name;
}
