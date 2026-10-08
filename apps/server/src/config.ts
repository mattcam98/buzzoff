import path from 'node:path';
import { z } from 'zod';

const optional = z.string().trim().optional().transform((v) => v || undefined);

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3210),
  /** Postgres connection string. Without it, games live in memory only. */
  DATABASE_URL: optional,
  /** When set, creating games and managing content requires this password. */
  BUZZOFF_ADMIN_PASSWORD: optional,
  /** The address players use to reach the server, e.g. https://buzz.example.com. Used for the join QR code. */
  PUBLIC_URL: optional,
  MEDIA_DIR: z.string().default('./data/media'),
  WEB_DIR: z.string().default(path.join(import.meta.dirname, '../../web/dist')),
  /** Number of reverse proxies in front of the app (e.g. 2 for Cloudflare plus Nginx Proxy Manager). Used to find the real client address. */
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(1),
  /** Hours an untouched game is kept before it is deleted. */
  ROOM_TTL_HOURS: z.coerce.number().min(1).max(24 * 30).default(24),
  MAX_UPLOAD_MB: z.coerce.number().min(1).max(500).default(25),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration — ${problems}`);
  }
  return parsed.data;
}

export const VERSION = '1.0.0';
