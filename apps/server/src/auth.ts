/**
 * Who may host. There is one administrator, identified by a password that is
 * stored only as a scrypt hash. Signing in creates a session: a random token
 * the browser keeps, of which the server stores only a hash. Nothing kept in
 * the database can therefore be used to sign in, and a session can be ended
 * from the server at any time.
 */
import type { AdminSessionView } from '@buzzoff/shared';
import type { Audit, Settings } from './settings';
import type { AdminSession, Store } from './store/types';
import { hashPassword, log, randomToken, sha256, verifyPassword } from './util';

const PASSWORD_KEY = 'admin_password';
const DAY_MS = 24 * 3_600_000;

/** Where a request came from, recorded with the session and in the audit log. */
export interface Caller {
  ip: string;
  agent: string;
}

export class AdminAuth {
  private sessions = new Map<string, AdminSession>();

  private constructor(
    private store: Store,
    private settings: Settings,
    private audit: Audit,
    private passwordHash: string | null,
  ) {}

  /**
   * `initialPassword` comes from the environment and is used once, to give a
   * server its first password. After that the password lives in the database
   * and is changed from the Settings page.
   */
  static async load(store: Store, settings: Settings, audit: Audit, initialPassword: string | undefined): Promise<AdminAuth> {
    let hash = await store.getSetting(PASSWORD_KEY);
    if (!hash && initialPassword) {
      hash = await hashPassword(initialPassword);
      await store.setSetting(PASSWORD_KEY, hash);
      audit('password.imported', 'server');
    } else if (hash && initialPassword) {
      log.info('BUZZOFF_ADMIN_PASSWORD is ignored: this server already has a host password, managed in Settings. It can be removed from .env');
    }
    const auth = new AdminAuth(store, settings, audit, hash);
    for (const session of await store.listSessions()) auth.sessions.set(session.tokenHash, session);
    auth.prune();
    return auth;
  }

  /** Forget sessions that have run out. */
  private prune() {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.expiresAt > now) continue;
      this.sessions.delete(session.tokenHash);
      this.store.deleteSession(session.tokenHash).catch((err) => log.error('could not delete expired session', { err }));
    }
  }

  /** False while no password is set: anyone who can reach the server can then host and change settings. */
  get required() {
    return this.passwordHash !== null;
  }

  private session(token: string | undefined): AdminSession | null {
    const session = token ? this.sessions.get(sha256(token)) : undefined;
    return session && session.expiresAt > Date.now() ? session : null;
  }

  allows(token: string | undefined): boolean {
    return !this.required || this.session(token) !== null;
  }

  private async open(caller: Caller): Promise<string> {
    this.prune();
    const token = randomToken(32);
    const now = Date.now();
    const session: AdminSession = {
      tokenHash: sha256(token), createdAt: now, expiresAt: now + this.settings.current.sessionDays * DAY_MS,
      ip: caller.ip, agent: caller.agent.slice(0, 200),
    };
    await this.store.saveSession(session);
    this.sessions.set(session.tokenHash, session);
    return token;
  }

  async login(password: string, caller: Caller): Promise<string | null> {
    if (!this.passwordHash || !(await verifyPassword(password, this.passwordHash))) {
      this.audit('login.failed', caller.ip);
      return null;
    }
    this.audit('login', caller.ip);
    return this.open(caller);
  }

  async logout(token: string | undefined, caller: Caller) {
    const session = this.session(token);
    if (!session) return;
    this.sessions.delete(session.tokenHash);
    await this.store.deleteSession(session.tokenHash);
    this.audit('logout', caller.ip);
  }

  /**
   * Set or change the password. Changing it needs the current one even from a
   * signed-in browser, so a borrowed session cannot lock the owner out. Every
   * session ends; the caller gets a fresh one.
   */
  async setPassword(current: string | undefined, next: string, caller: Caller): Promise<string | null> {
    const changing = this.passwordHash !== null;
    if (this.passwordHash && !(await verifyPassword(current ?? '', this.passwordHash))) {
      this.audit('login.failed', caller.ip, { during: 'password change' });
      return null;
    }
    this.passwordHash = await hashPassword(next);
    await this.store.setSetting(PASSWORD_KEY, this.passwordHash);
    this.sessions.clear();
    await this.store.deleteSessions();
    this.audit(changing ? 'password.changed' : 'password.set', caller.ip);
    return this.open(caller);
  }

  /** Sign out every device except the one asking. */
  async revokeOthers(token: string | undefined, caller: Caller): Promise<number> {
    const keep = this.session(token)?.tokenHash;
    const ended = [...this.sessions.keys()].filter((hash) => hash !== keep);
    for (const hash of ended) this.sessions.delete(hash);
    await this.store.deleteSessions(keep);
    this.audit('sessions.revoked', caller.ip, { count: ended.length });
    return ended.length;
  }

  list(token: string | undefined): AdminSessionView[] {
    this.prune();
    const mine = this.session(token)?.tokenHash;
    return [...this.sessions.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((s) => ({ id: s.tokenHash.slice(0, 12), createdAt: s.createdAt, expiresAt: s.expiresAt, ip: s.ip, agent: s.agent, current: s.tokenHash === mine }));
  }
}

/** Forget the password and every session. Used by the `reset-admin-password` command when the password is lost. */
export async function resetAdminPassword(store: Store) {
  await store.deleteSetting(PASSWORD_KEY);
  await store.deleteSessions();
  await store.addAudit({ at: Date.now(), action: 'password.reset', ip: 'server', detail: {} });
}
