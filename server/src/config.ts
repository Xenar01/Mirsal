import { z } from 'zod';

/** Max upload size, enforced app-side (100 MB). */
export const MAX_FILE_BYTES = 104857600;
/** Trash/auto-delete grace period (7 days), in milliseconds. */
export const GRACE_MS = 604800000;

const configSchema = z.object({
  DB_PATH: z.string().min(1, 'DB_PATH is required'),
  STORAGE_DIR: z.string().min(1, 'STORAGE_DIR is required'),
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 characters'),
  CSRF_SECRET: z.string().min(16, 'CSRF_SECRET must be at least 16 characters'),
  PUBLIC_BASE_URL: z.string().url('PUBLIC_BASE_URL must be a valid URL'),
  // Bind address for the HTTP listener. Defaults to loopback so a direct
  // (non-container) run stays host-local. In the Docker image this is set to
  // 0.0.0.0 — the container is reachable only through the compose publish
  // `127.0.0.1:8084:8084`, which is what actually confines it to host loopback.
  HOST: z.string().min(1).default('127.0.0.1'),
  ARGON_MEMORY_KIB: z.coerce.number().int().positive().default(19456),
  ARGON_TIME: z.coerce.number().int().positive().default(2),
  ARGON_PARALLELISM: z.coerce.number().int().positive().default(1),
  ARGON_MAX_CONCURRENCY: z.coerce.number().int().positive().default(2),
});

export type Config = Readonly<z.infer<typeof configSchema>>;

/**
 * Parses and validates the server configuration from an env-like object.
 * Pure function of its `env` argument — reads nothing at module load time —
 * so callers (and tests) get full control and isolation.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${detail}`);
  }
  return Object.freeze(result.data);
}
