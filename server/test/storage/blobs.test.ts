import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  blobPathFor,
  commitTemp,
  createBlobStore,
  deleteBlob,
  readBlob,
  writeStreamToTemp,
} from '../../src/storage/blobs.js';

function freshStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'mirsal-blob-'));
  return { dir, store: createBlobStore({ storageDir: dir }) };
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

test('blobPathFor builds <storageDir>/<ownerId>/<nodeId>', () => {
  const { dir, store } = freshStore();

  expect(store.blobPathFor('u1', 'n1')).toBe(path.join(dir, 'u1', 'n1'));
});

describe('blobPathFor traversal safety', () => {
  test('throws on ownerId of ".."', () => {
    const { store } = freshStore();
    expect(() => store.blobPathFor('..', 'n1')).toThrow();
  });

  test('throws on ownerId of "."', () => {
    const { store } = freshStore();
    expect(() => store.blobPathFor('.', 'n1')).toThrow();
  });

  test('throws on nodeId containing a slash', () => {
    const { store } = freshStore();
    expect(() => store.blobPathFor('u1', 'a/b')).toThrow();
  });

  test('throws on nodeId containing a backslash', () => {
    const { store } = freshStore();
    expect(() => store.blobPathFor('u1', 'a\\b')).toThrow();
  });

  test('throws on an empty segment', () => {
    const { store } = freshStore();
    expect(() => store.blobPathFor('', 'n1')).toThrow();
  });

  test('throws on a NUL byte in a segment', () => {
    const { store } = freshStore();
    expect(() => store.blobPathFor('u1', 'a\0b')).toThrow();
  });
});

describe('writeStreamToTemp', () => {
  test('writes a 10-byte stream to a temp file in the owner dir and reports 10 bytes', async () => {
    const { dir, store } = freshStore();

    const { tempPath, bytes } = await store.writeStreamToTemp('u1', Readable.from(Buffer.alloc(10)), 100);

    expect(bytes).toBe(10);
    expect(statSync(tempPath).size).toBe(10);
    expect(path.dirname(tempPath)).toBe(path.join(dir, 'u1'));
    expect(path.basename(tempPath).startsWith('.tmp-')).toBe(true);
  });

  test('rejects a stream exceeding limitBytes and leaves no leftover temp file', async () => {
    const { dir, store } = freshStore();

    await expect(store.writeStreamToTemp('u1', Readable.from(Buffer.alloc(200)), 100)).rejects.toThrow();

    const ownerDir = path.join(dir, 'u1');
    const leftovers = existsSync(ownerDir) ? readdirSync(ownerDir).filter((name) => name.startsWith('.tmp-')) : [];
    expect(leftovers).toEqual([]);
  });
});

describe('commitTemp', () => {
  test('renames the temp file into place and returns the relative storage_path', async () => {
    const { dir, store } = freshStore();
    const { tempPath } = await store.writeStreamToTemp('u1', Readable.from(Buffer.from('hello')), 100);

    const storagePath = store.commitTemp(tempPath, 'u1', 'n1');

    expect(storagePath).toBe('u1/n1');
    expect(existsSync(path.join(dir, 'u1', 'n1'))).toBe(true);
    expect(existsSync(tempPath)).toBe(false);
  });

  test('throws on a traversal ownerId without touching the filesystem', () => {
    const { store } = freshStore();
    expect(() => store.commitTemp('/tmp/whatever-nonexistent', '..', 'n1')).toThrow();
  });

  test('throws on a traversal nodeId ("../x")', () => {
    const { store } = freshStore();
    expect(() => store.commitTemp('/tmp/whatever-nonexistent', 'u1', '../x')).toThrow();
  });
});

describe('readBlob / deleteBlob', () => {
  test('readBlob streams back the committed file contents', async () => {
    const { store } = freshStore();
    const { tempPath } = await store.writeStreamToTemp('u1', Readable.from(Buffer.from('payload')), 100);
    store.commitTemp(tempPath, 'u1', 'n1');

    const content = await readAll(store.readBlob('u1/n1'));
    expect(content).toBe('payload');
  });

  test('readBlob throws on a storagePath that escapes storageDir', () => {
    const { store } = freshStore();
    expect(() => store.readBlob('../../etc/passwd')).toThrow();
  });

  test('deleteBlob on a missing file does not throw (idempotent)', () => {
    const { store } = freshStore();
    expect(() => store.deleteBlob('u1/does-not-exist')).not.toThrow();
  });

  test('deleteBlob removes an existing file, and a second call still does not throw', async () => {
    const { dir, store } = freshStore();
    const { tempPath } = await store.writeStreamToTemp('u1', Readable.from(Buffer.from('x')), 100);
    store.commitTemp(tempPath, 'u1', 'n1');
    expect(existsSync(path.join(dir, 'u1', 'n1'))).toBe(true);

    expect(() => store.deleteBlob('u1/n1')).not.toThrow();
    expect(existsSync(path.join(dir, 'u1', 'n1'))).toBe(false);
    expect(() => store.deleteBlob('u1/n1')).not.toThrow();
  });

  test('deleteBlob throws on a storagePath that escapes storageDir', () => {
    const { store } = freshStore();
    expect(() => store.deleteBlob('../../etc/passwd')).toThrow();
  });
});

// The bare blobPathFor/writeStreamToTemp/commitTemp/readBlob/deleteBlob exports are bound to a
// lazily-initialized default store built from loadConfig() on first use. loadConfig() requires a
// handful of unrelated fields (DB_PATH, SESSION_SECRET, ...) to be present on process.env before it
// will validate successfully, so this group provisions a throwaway env (including a real temp dir
// for STORAGE_DIR) for the duration of the test and restores it afterwards.
describe('bare exports (default store)', () => {
  const keys = ['DB_PATH', 'STORAGE_DIR', 'SESSION_SECRET', 'CSRF_SECRET', 'PUBLIC_BASE_URL'] as const;
  const originals: Record<string, string | undefined> = {};
  let dir: string;

  beforeAll(() => {
    for (const key of keys) {
      originals[key] = process.env[key];
    }
    dir = mkdtempSync(path.join(tmpdir(), 'mirsal-blob-default-'));
    process.env.DB_PATH = '/tmp/mirsal-test/db.sqlite';
    process.env.STORAGE_DIR = dir;
    process.env.SESSION_SECRET = 'a'.repeat(32);
    process.env.CSRF_SECRET = 'b'.repeat(32);
    process.env.PUBLIC_BASE_URL = 'https://mirsal.example.com';
  });

  afterAll(() => {
    for (const key of keys) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
  });

  test('round trip through the bare exports', async () => {
    const { tempPath, bytes } = await writeStreamToTemp('u1', Readable.from(Buffer.from('hi')), 100);
    expect(bytes).toBe(2);

    const storagePath = commitTemp(tempPath, 'u1', 'n1');
    expect(storagePath).toBe('u1/n1');
    expect(blobPathFor('u1', 'n1')).toBe(path.join(dir, 'u1', 'n1'));

    const content = await readAll(readBlob(storagePath));
    expect(content).toBe('hi');

    deleteBlob(storagePath);
    expect(existsSync(path.join(dir, 'u1', 'n1'))).toBe(false);
  });
});
