import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { randomToken, sha256 } from '../../src/util/ids.js';

test('randomToken: default 32 bytes decodes to 32 bytes and is URL-safe (no +/=)', () => {
  const token = randomToken();

  expect(token).not.toMatch(/[+/=]/);
  expect(Buffer.from(token, 'base64url').length).toBe(32);
});

test('randomToken: respects an explicit byte length', () => {
  const token = randomToken(16);

  expect(Buffer.from(token, 'base64url').length).toBe(16);
});

test('randomToken: two calls produce different tokens', () => {
  expect(randomToken()).not.toBe(randomToken());
});

test('sha256: matches node:crypto createHash("sha256") hex digest', () => {
  const input = 'some-raw-token-value';
  const expected = createHash('sha256').update(input).digest('hex');

  expect(sha256(input)).toBe(expected);
});

test('sha256: is deterministic for the same input', () => {
  expect(sha256('abc')).toBe(sha256('abc'));
});
