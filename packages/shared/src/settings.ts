/**
 * Server-wide settings an administrator manages from inside the app, and what
 * the Settings page is told about sign-in. Nothing here is a secret: the
 * password itself never leaves the server, in any form.
 */
import { z } from 'zod';

/** Whole-number bounds, shared by the validation here and the form that edits them. */
export const SETTINGS_LIMITS = {
  roomTtlHours: { min: 1, max: 720, fallback: 24 },
  finishedTtlHours: { min: 1, max: 720, fallback: 6 },
  maxUploadMb: { min: 1, max: 500, fallback: 25 },
  sessionDays: { min: 1, max: 365, fallback: 30 },
} as const;

const bounded = (key: keyof typeof SETTINGS_LIMITS) => {
  const { min, max, fallback } = SETTINGS_LIMITS[key];
  return z.number().int().min(min).max(max).default(fallback);
};

const ORIGIN = /^(https?):\/\/([a-z0-9.-]+|\[[0-9a-f:]+\])(:\d{1,5})?\/?$/i;

/**
 * `https://buzz.example.com` from anything that is exactly an address (scheme, host, optional
 * port), otherwise null. Paths are refused because the app is always served from the root.
 */
export function publicOrigin(value: string): string | null {
  const match = ORIGIN.exec(value.trim());
  return match ? `${match[1]}://${match[2]}${match[3] ?? ''}`.toLowerCase() : null;
}

export const AppSettingsSchema = z.object({
  /** The address players type, shown in the lobby and encoded in the QR code. Null uses whatever address the TV was opened with. */
  publicUrl: z
    .string()
    .max(200)
    .refine((v) => publicOrigin(v) !== null, 'Enter just the address, like https://buzz.example.com')
    .transform((v) => publicOrigin(v)!)
    .nullable()
    .default(null),
  /** The format the New game page starts on. Null starts on whatever this browser played last. */
  defaultPresetId: z.string().min(1).max(40).nullable().default(null),
  /** Hours an untouched game is kept before it is deleted. */
  roomTtlHours: bounded('roomTtlHours'),
  /** Hours a finished game stays open for a rematch. */
  finishedTtlHours: bounded('finishedTtlHours'),
  /** Largest image, audio or video file a question may use. */
  maxUploadMb: bounded('maxUploadMb'),
  /** How long a host stays signed in on a device. */
  sessionDays: bounded('sessionDays'),
  /** Whether anyone who can reach the server may see the leaderboard, or only the host. */
  publicLeaderboard: z.boolean().default(false),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const PASSWORD_MIN_LENGTH = 8;
export const PasswordSchema = z.string().min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`).max(200);

export const ChangePasswordSchema = z.object({
  /** Required whenever a password is already set, even for someone who is signed in. */
  current: z.string().max(200).optional(),
  next: PasswordSchema,
});

/** A device signed in as host. `id` is a label only; it cannot be used to act as that session. */
export interface AdminSessionView {
  id: string;
  createdAt: number;
  expiresAt: number;
  ip: string;
  agent: string;
  current: boolean;
}

export type AuditAction =
  | 'login'
  | 'login.failed'
  | 'logout'
  | 'password.set'
  | 'password.changed'
  | 'password.imported'
  | 'password.reset'
  | 'sessions.revoked'
  | 'settings.changed'
  | 'settings.imported';

export interface AuditEntry {
  id: number;
  at: number;
  action: AuditAction;
  /** The address the request came from, or `server` for something the server did itself. */
  ip: string;
  detail: Record<string, unknown>;
}

export interface SettingsView {
  settings: AppSettings;
  passwordSet: boolean;
  sessions: AdminSessionView[];
  /** Facts about how the server was started. They are fixed until it restarts and are shown read-only. */
  server: {
    version: string;
    /** False when there is no database: settings then last only until the server restarts. */
    persistent: boolean;
    trustProxy: number;
  };
}
