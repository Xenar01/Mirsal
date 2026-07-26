import argon2, { type HashOptions } from 'argon2';
import { loadConfig, type Config } from '../config.js';
import { Semaphore } from '../util/semaphore.js';

/**
 * The subset of Config that createPasswordService actually depends on.
 * Kept narrower than the full Config so the factory (the testable core) can
 * be exercised with a plain literal in tests, without fabricating unrelated
 * required fields (DB_PATH, SESSION_SECRET, ...) that loadConfig demands.
 */
export type ArgonOptions = Pick<
  Config,
  'ARGON_MEMORY_KIB' | 'ARGON_TIME' | 'ARGON_PARALLELISM' | 'ARGON_MAX_CONCURRENCY'
>;

export interface PasswordService {
  hashPassword(password: string): Promise<string>;
  verifyPassword(hash: string, password: string): Promise<boolean>;
}

/**
 * Builds a password service backed by argon2id. Every hash/verify call is
 * funneled through a module-scoped Semaphore sized `ARGON_MAX_CONCURRENCY`,
 * bounding total concurrent argon2 memory use (protects the container from a
 * flood of public-endpoint hashing attempts — spec §8).
 */
export function createPasswordService(cfg: ArgonOptions): PasswordService {
  const semaphore = new Semaphore(cfg.ARGON_MAX_CONCURRENCY);
  const options: HashOptions = {
    type: argon2.argon2id,
    memoryCost: cfg.ARGON_MEMORY_KIB,
    timeCost: cfg.ARGON_TIME,
    parallelism: cfg.ARGON_PARALLELISM,
  };

  function hashPassword(password: string): Promise<string> {
    return semaphore.run(() => argon2.hash(password, options));
  }

  function verifyPassword(hash: string, password: string): Promise<boolean> {
    return semaphore.run(async () => {
      try {
        return await argon2.verify(hash, password);
      } catch {
        // Malformed/garbage hash string — treat as a failed verification,
        // never surface the throw to the caller.
        return false;
      }
    });
  }

  return { hashPassword, verifyPassword };
}

let defaultService: PasswordService | undefined;

function getDefaultService(): PasswordService {
  if (!defaultService) {
    defaultService = createPasswordService(loadConfig());
  }
  return defaultService;
}

/** Bare signature bound to a lazily-initialized default service (built from loadConfig() on first use). */
export function hashPassword(password: string): Promise<string> {
  return getDefaultService().hashPassword(password);
}

/** Bare signature bound to a lazily-initialized default service (built from loadConfig() on first use). */
export function verifyPassword(hash: string, password: string): Promise<boolean> {
  return getDefaultService().verifyPassword(hash, password);
}
