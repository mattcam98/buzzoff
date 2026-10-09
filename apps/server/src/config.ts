import path from 'node:path';
import { z } from 'zod';

const optional = z.string().trim().optional().transform((v) => v || undefined);

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3210),
  /** Postgres connection string. Without it, games live in memory only. */
  DATABASE_URL: optional,
  MEDIA_DIR: z.string().default('./data/media'),
  WEB_DIR: z.string().default(path.join(import.meta.dirname, '../../web/dist')),
  /** Number of reverse proxies in front of the app (e.g. 2 for Cloudflare plus Nginx Proxy Manager). Used to find the real client address. */
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(1),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /**
   * The first host password for a server that has none yet, so a new install is never left open.
   * Once a password exists it is changed in Settings and this is ignored.
   */
  BUZZOFF_ADMIN_PASSWORD: optional,
  // Settings that used to be configured here. They are read once, to carry an existing
  // install's values into the database, and have no effect after that.
  PUBLIC_URL: optional,
  ROOM_TTL_HOURS: optional,
  MAX_UPLOAD_MB: optional,
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  return parsed.data;
}

export const VERSION = '1.0.0';
