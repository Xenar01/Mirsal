import { createHash, randomBytes } from 'node:crypto';

/** Generates a URL-safe (base64url, no padding) CSPRNG token of `bytes` random bytes. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Hex-encoded SHA-256 digest of `input`. Used to hash tokens before storage. */
export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
