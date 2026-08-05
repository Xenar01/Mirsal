import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import type { ReadStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { loadConfig } from '../config.js';

export interface WriteResult {
  tempPath: string;
  bytes: number;
}

export interface BlobStore {
  blobPathFor(ownerId: string, nodeId: string): string;
  writeStreamToTemp(ownerId: string, stream: Readable, limitBytes: number): Promise<WriteResult>;
  commitTemp(tempPath: string, ownerId: string, nodeId: string): string;
  readBlob(storagePath: string): ReadStream;
  blobExists(storagePath: string): Promise<boolean>;
  deleteBlob(storagePath: string): void;
}

/**
 * Rejects any path segment that is empty, ".", "..", or contains a path
 * separator (forward/back slash) or a NUL byte. ownerId/nodeId are used as
 * literal path segments, so this is the traversal-safety boundary even though
 * both ids are server-generated (defense-in-depth, spec §8).
 */
function assertSafeSegment(segment: string, label: string): void {
  if (
    segment.length === 0 ||
    segment === '.' ||
    segment === '..' ||
    segment.includes('/') ||
    segment.includes('\\') ||
    segment.includes('\0')
  ) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(segment)}`);
  }
}

/**
 * Builds a blob store rooted at `storageDir`. This is the testable core —
 * the bare module-level exports below bind to a lazily-initialized default
 * instance built from loadConfig().
 */
export function createBlobStore({ storageDir }: { storageDir: string }): BlobStore {
  function blobPathFor(ownerId: string, nodeId: string): string {
    assertSafeSegment(ownerId, 'ownerId');
    assertSafeSegment(nodeId, 'nodeId');
    return path.join(storageDir, ownerId, nodeId);
  }

  /** Resolves `storagePath` under storageDir and throws if it would escape. */
  function assertUnderStorageDir(storagePath: string): string {
    const abs = path.resolve(storageDir, storagePath);
    const rel = path.relative(storageDir, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Path escapes storage dir: ${JSON.stringify(storagePath)}`);
    }
    return abs;
  }

  async function writeStreamToTemp(
    ownerId: string,
    stream: Readable,
    limitBytes: number
  ): Promise<WriteResult> {
    assertSafeSegment(ownerId, 'ownerId');
    const ownerDir = path.join(storageDir, ownerId);
    await mkdir(ownerDir, { recursive: true });
    const tempPath = path.join(ownerDir, `.tmp-${randomBytes(12).toString('hex')}`);

    let bytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > limitBytes) {
          callback(new Error('FILE_TOO_LARGE'));
          return;
        }
        callback(null, chunk);
      },
    });

    try {
      // pipeline() destroys every stream in the chain (and waits for them to
      // close) before settling, so on error the write stream's fd is already
      // closed by the time we unlink — no buffering the whole input first.
      await pipeline(stream, counter, createWriteStream(tempPath));
    } catch (err) {
      await unlink(tempPath).catch(() => {
        // Best-effort cleanup — ignore (e.g. file was never created).
      });
      throw err;
    }

    return { tempPath, bytes };
  }

  function commitTemp(tempPath: string, ownerId: string, nodeId: string): string {
    assertSafeSegment(ownerId, 'ownerId');
    assertSafeSegment(nodeId, 'nodeId');
    const ownerDir = path.join(storageDir, ownerId);
    mkdirSync(ownerDir, { recursive: true });
    const finalPath = path.join(ownerDir, nodeId);
    renameSync(tempPath, finalPath);
    return `${ownerId}/${nodeId}`;
  }

  function readBlob(storagePath: string): ReadStream {
    const abs = assertUnderStorageDir(storagePath);
    return createReadStream(abs);
  }

  /**
   * True if `storagePath`'s blob is present on disk. Cheap existence probe
   * (`stat`, no fd held) used to pre-flight a `/zip` subtree so a missing blob
   * (reverse-orphan) fails as a clean 404 instead of hanging the archiver on a
   * source stream that errors after headers are sent.
   */
  async function blobExists(storagePath: string): Promise<boolean> {
    const abs = assertUnderStorageDir(storagePath);
    try {
      await stat(abs);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  function deleteBlob(storagePath: string): void {
    const abs = assertUnderStorageDir(storagePath);
    try {
      unlinkSync(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  return { blobPathFor, writeStreamToTemp, commitTemp, readBlob, blobExists, deleteBlob };
}

let defaultStore: BlobStore | undefined;

function getDefaultStore(): BlobStore {
  if (!defaultStore) {
    defaultStore = createBlobStore({ storageDir: loadConfig().STORAGE_DIR });
  }
  return defaultStore;
}

/** Bare signature bound to a lazily-initialized default store (built from loadConfig() on first use). */
export function blobPathFor(ownerId: string, nodeId: string): string {
  return getDefaultStore().blobPathFor(ownerId, nodeId);
}

/** Bare signature bound to a lazily-initialized default store (built from loadConfig() on first use). */
export function writeStreamToTemp(
  ownerId: string,
  stream: Readable,
  limitBytes: number
): Promise<WriteResult> {
  return getDefaultStore().writeStreamToTemp(ownerId, stream, limitBytes);
}

/** Bare signature bound to a lazily-initialized default store (built from loadConfig() on first use). */
export function commitTemp(tempPath: string, ownerId: string, nodeId: string): string {
  return getDefaultStore().commitTemp(tempPath, ownerId, nodeId);
}

/** Bare signature bound to a lazily-initialized default store (built from loadConfig() on first use). */
export function readBlob(storagePath: string): ReadStream {
  return getDefaultStore().readBlob(storagePath);
}

/** Bare signature bound to a lazily-initialized default store (built from loadConfig() on first use). */
export function blobExists(storagePath: string): Promise<boolean> {
  return getDefaultStore().blobExists(storagePath);
}

/** Bare signature bound to a lazily-initialized default store (built from loadConfig() on first use). */
export function deleteBlob(storagePath: string): void {
  return getDefaultStore().deleteBlob(storagePath);
}
