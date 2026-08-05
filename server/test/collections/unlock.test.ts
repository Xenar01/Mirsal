import { describe, expect, test } from 'vitest';
import { createUnlockGate, COLLECT_UNLOCK_COOKIE } from '../../src/collections/unlock.js';

const SECRET = 'x'.repeat(32);
const TOKEN = 'tok-abc';
const HASH = '$argon2id$fakehash';
const NOW = 1_700_000_000_000;

describe('createUnlockGate', () => {
  test('a freshly-issued cookie verifies for its token + password_hash', () => {
    const gate = createUnlockGate(SECRET);
    const cookie = gate.cookieValue(TOKEN, HASH, NOW);
    expect(gate.isUnlocked(cookie, TOKEN, HASH, NOW)).toBe(true);
    expect(gate.cookieName).toBe(COLLECT_UNLOCK_COOKIE);
    expect(gate.cookiePath(TOKEN)).toBe(`/api/collect/${TOKEN}`);
  });

  test('undefined / malformed cookie -> false', () => {
    const gate = createUnlockGate(SECRET);
    expect(gate.isUnlocked(undefined, TOKEN, HASH, NOW)).toBe(false);
    expect(gate.isUnlocked('no-dot', TOKEN, HASH, NOW)).toBe(false);
    expect(gate.isUnlocked('.sig', TOKEN, HASH, NOW)).toBe(false);
    expect(gate.isUnlocked('notanumber.sig', TOKEN, HASH, NOW)).toBe(false);
  });

  test('rotated/cleared password_hash invalidates a prior cookie', () => {
    const gate = createUnlockGate(SECRET);
    const cookie = gate.cookieValue(TOKEN, HASH, NOW);
    expect(gate.isUnlocked(cookie, TOKEN, 'different-hash', NOW)).toBe(false);
    expect(gate.isUnlocked(cookie, TOKEN, null, NOW)).toBe(false);
  });

  test('a different secret does not verify', () => {
    const cookie = createUnlockGate(SECRET).cookieValue(TOKEN, HASH, NOW);
    expect(createUnlockGate('y'.repeat(32)).isUnlocked(cookie, TOKEN, HASH, NOW)).toBe(false);
  });

  test('expired (older than 600s) and future issuedAt both -> false', () => {
    const gate = createUnlockGate(SECRET);
    const cookie = gate.cookieValue(TOKEN, HASH, NOW);
    expect(gate.isUnlocked(cookie, TOKEN, HASH, NOW + 601_000)).toBe(false); // aged out
    expect(gate.isUnlocked(cookie, TOKEN, HASH, NOW + 599_000)).toBe(true); // still fresh
    const future = gate.cookieValue(TOKEN, HASH, NOW + 10_000);
    expect(gate.isUnlocked(future, TOKEN, HASH, NOW)).toBe(false); // issued in the future
  });

  test('a tampered signature -> false', () => {
    const gate = createUnlockGate(SECRET);
    const cookie = gate.cookieValue(TOKEN, HASH, NOW);
    const tampered = `${cookie.slice(0, -1)}${cookie.at(-1) === 'A' ? 'B' : 'A'}`;
    expect(gate.isUnlocked(tampered, TOKEN, HASH, NOW)).toBe(false);
  });
});
