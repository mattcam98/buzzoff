import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@buzzoff/shared';

/**
 * Server time in milliseconds. It is derived from the monotonic clock, so it
 * never jumps backwards within a process (which buzz ordering relies on), and
 * it is epoch-aligned so clients can turn deadlines into countdowns.
 */
export const clock = () => performance.timeOrigin + performance.now();

// ---------------------------------------------------------------- logging

type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS.info;
export const setLogLevel = (level: Level) => (threshold = LEVELS[level]);

function write(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

/** Structured JSON logs, one object per line. */
export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) =>
    write('error', msg, fields?.err instanceof Error ? { ...fields, err: fields.err.stack ?? fields.err.message } : fields),
};

// ---------------------------------------------------------------- secrets

/**
 * A fraction in [0, 1) from the operating system's secure generator. The engine draws every
 * dice roll and shuffle from this, so no outcome can be predicted or nudged from outside.
 */
const RANDOM_RANGE = 2 ** 48 - 1; // the widest range randomInt takes
export const random = () => randomInt(RANDOM_RANGE) / RANDOM_RANGE;

export const randomToken = (bytes = 24) => randomBytes(bytes).toString('base64url');
export const randomId = (bytes = 6) => randomBytes(bytes).toString('base64url');
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Tokens are stored hashed, so a database leak does not hand out live sessions. */
export const tokenMatches = (token: string | undefined, hash: string | undefined) =>
  !!token && !!hash && safeEqual(sha256(token), hash);

const derive = (password: string, salt: Buffer, length: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scrypt(password, salt, length, options, (err, key) => (err ? reject(err) : resolve(key))));

/** scrypt cost: 2^15 blocks of 8 KiB, about 32 MB and a twentieth of a second per guess. */
const SCRYPT = { logN: 15, r: 8, p: 1 };
const scryptOptions = (logN: number, r: number, p: number): ScryptOptions => ({ N: 2 ** logN, r, p, maxmem: 256 * 2 ** logN * r });

/**
 * Hash a password for storage. The cost parameters travel with the hash, so they can be raised later
 * without invalidating existing passwords. The work happens off the main thread: a game in progress
 * must never stall because someone is signing in.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, 32, scryptOptions(SCRYPT.logN, SCRYPT.r, SCRYPT.p));
  return ['scrypt', SCRYPT.logN, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, logN, r, p, salt, expected] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  const want = Buffer.from(expected, 'base64url');
  const cost = [Number(logN), Number(r), Number(p)] as const;
  // Refuse absurd parameters rather than let a tampered row tie up the server.
  if (!cost.every(Number.isInteger) || cost[0] < 10 || cost[0] > 20 || cost[1] < 1 || cost[1] > 16 || cost[2] < 1 || cost[2] > 4) return false;
  const got = await derive(password, Buffer.from(salt, 'base64url'), want.length, scryptOptions(...cost));
  return got.length === want.length && timingSafeEqual(got, want);
}

export function randomRoomCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  return code;
}

/**
 * The client's address as seen through `hops` trusted reverse proxies, using
 * the same rule as Express's numeric `trust proxy`: the last `hops` addresses
 * in the chain are ours, and the one before them is the client.
 */
export function clientAddress(remote: string, forwardedFor: string | string[] | undefined, hops: number): string {
  if (hops <= 0) return remote;
  const forwarded = String(forwardedFor ?? '').split(',').map((part) => part.trim()).filter(Boolean);
  const chain = [...forwarded, remote];
  return chain[Math.max(0, chain.length - 1 - hops)];
}

// ---------------------------------------------------------------- rate limiting

/** A token bucket: `burst` actions at once, refilling at `perSecond`. */
export class Bucket {
  private tokens: number;
  private last = performance.now();
  constructor(
    private perSecond: number,
    private burst: number,
  ) {
    this.tokens = burst;
  }
  take(): boolean {
    const now = performance.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
  get idleMs() {
    return performance.now() - this.last;
  }
}

/** Buckets keyed by caller (IP address, usually), pruned as they go idle. */
export class Limiter {
  private buckets = new Map<string, Bucket>();
  constructor(
    private perSecond: number,
    private burst: number,
  ) {}
  allow(key: string): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size > 5000) this.prune();
      bucket = new Bucket(this.perSecond, this.burst);
      this.buckets.set(key, bucket);
    }
    return bucket.take();
  }
  private prune() {
    const fullAfterMs = (this.burst / this.perSecond) * 1000;
    for (const [key, bucket] of this.buckets) if (bucket.idleMs > fullAfterMs) this.buckets.delete(key);
  }
}

/** Remembers the last `size` ids it has seen. */
export class RecentIds {
  private seen = new Set<string>();
  constructor(private size = 500) {}
  has(id: string): boolean {
    return this.seen.has(id);
  }
  add(id: string): void {
    this.seen.add(id);
    if (this.seen.size > this.size) this.seen.delete(this.seen.values().next().value!);
  }
}
