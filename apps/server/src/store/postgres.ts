import type { AuditAction, AuditEntry, GameResult, Pack, Preset } from '@buzzoff/shared';
import pg from 'pg';
import { log } from '../util';
import { AUDIT_KEEP, type AdminSession, type SavedGame, type Store } from './types';

/**
 * Postgres text cannot hold NUL and jsonb rejects unpaired surrogates. Either can arrive in anything a
 * person types (a player's name, an answer), and one in a game's state would fail every later save of it.
 */
const clean = (text: string) => text.toWellFormed().replaceAll('\u0000', '');
const json = (value: unknown) => JSON.stringify(value, (_key, v) => (typeof v === 'string' ? clean(v) : v));

/**
 * Schema migrations, applied in order inside a transaction. Append new
 * entries; never edit one that has shipped.
 *
 * Packs, presets, live games and results are stored as JSONB documents: each
 * is always read and written whole, and the shared zod schemas are their
 * source of truth, so mirroring them column-by-column would only add drift.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE packs (
    id          text PRIMARY KEY,
    title       text NOT NULL,
    data        jsonb NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE presets (
    id    text PRIMARY KEY,
    data  jsonb NOT NULL
  );
  CREATE TABLE games (
    code        text PRIMARY KEY,
    state       jsonb NOT NULL,
    secrets     jsonb NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE results (
    id           text PRIMARY KEY,
    finished_at  timestamptz NOT NULL,
    data         jsonb NOT NULL
  );
  CREATE INDEX results_finished_at ON results (finished_at DESC);
  CREATE TABLE settings (
    key    text PRIMARY KEY,
    value  text NOT NULL
  );
  `,
  `
  CREATE TABLE admin_sessions (
    token_hash  text PRIMARY KEY,
    created_at  timestamptz NOT NULL,
    expires_at  timestamptz NOT NULL,
    ip          text NOT NULL,
    agent       text NOT NULL
  );
  CREATE TABLE audit_log (
    id      bigserial PRIMARY KEY,
    at      timestamptz NOT NULL,
    action  text NOT NULL,
    ip      text NOT NULL,
    detail  jsonb NOT NULL
  );
  `,
];

export class PostgresStore implements Store {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10 });
    this.pool.on('error', (err) => log.error('database connection error', { err }));
  }

  /** Wait for the database (it may still be starting under Docker Compose), then migrate. */
  async init() {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.pool.query('SELECT 1');
        break;
      } catch (err) {
        if (attempt >= 30) throw err;
        log.warn('database not ready, retrying', { attempt });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialise concurrent boots so two instances cannot migrate at once.
      await client.query('SELECT pg_advisory_xact_lock(827349)');
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      const { rows } = await client.query<{ version: number }>('SELECT version FROM schema_migrations');
      const applied = new Set(rows.map((r) => r.version));
      for (const [i, sql] of MIGRATIONS.entries()) {
        if (applied.has(i + 1)) continue;
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [i + 1]);
        log.info('applied migration', { version: i + 1 });
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }

  private async rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pool.query(sql, params)).rows as T[];
  }

  async listPacks() {
    return (await this.rows<{ data: Pack }>('SELECT data FROM packs ORDER BY updated_at DESC')).map((r) => r.data);
  }
  async getPack(id: string) {
    return (await this.rows<{ data: Pack }>('SELECT data FROM packs WHERE id = $1', [id]))[0]?.data ?? null;
  }
  async savePack(pack: Pack) {
    await this.pool.query(
      `INSERT INTO packs (id, title, data, updated_at) VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))
       ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
      [pack.id, clean(pack.title), json(pack), pack.updatedAt],
    );
  }
  async deletePack(id: string) {
    return ((await this.pool.query('DELETE FROM packs WHERE id = $1', [id])).rowCount ?? 0) > 0;
  }

  async listPresets() {
    return (await this.rows<{ data: Preset }>('SELECT data FROM presets ORDER BY id')).map((r) => r.data);
  }
  async savePreset(preset: Preset) {
    await this.pool.query('INSERT INTO presets (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data', [
      preset.id,
      json(preset),
    ]);
  }
  async deletePreset(id: string) {
    return ((await this.pool.query('DELETE FROM presets WHERE id = $1', [id])).rowCount ?? 0) > 0;
  }

  /** State and credentials are written in one statement, so a game is never half-saved. */
  async saveGame(game: SavedGame) {
    await this.pool.query(
      `INSERT INTO games (code, state, secrets, updated_at) VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))
       ON CONFLICT (code) DO UPDATE SET state = EXCLUDED.state, secrets = EXCLUDED.secrets, updated_at = EXCLUDED.updated_at`,
      [game.code, json(game.state), json(game.secrets), game.updatedAt],
    );
  }
  async loadGames() {
    const rows = await this.rows<{ code: string; state: SavedGame['state']; secrets: SavedGame['secrets']; updated_at: Date }>(
      'SELECT code, state, secrets, updated_at FROM games',
    );
    return rows.map((r) => ({ code: r.code, state: r.state, secrets: r.secrets, updatedAt: r.updated_at.getTime() }));
  }
  async deleteGame(code: string) {
    await this.pool.query('DELETE FROM games WHERE code = $1', [code]);
  }

  async saveResult(result: GameResult) {
    await this.pool.query(
      `INSERT INTO results (id, finished_at, data) VALUES ($1, to_timestamp($2 / 1000.0), $3)
       ON CONFLICT (id) DO UPDATE SET finished_at = EXCLUDED.finished_at, data = EXCLUDED.data`,
      [result.id, result.finishedAt, json(result)],
    );
  }
  async listResults(limit: number) {
    return (await this.rows<{ data: GameResult }>('SELECT data FROM results ORDER BY finished_at DESC LIMIT $1', [limit])).map((r) => r.data);
  }
  async deleteResult(id: string) {
    await this.pool.query('DELETE FROM results WHERE id = $1', [id]);
  }

  async getSetting(key: string) {
    return (await this.rows<{ value: string }>('SELECT value FROM settings WHERE key = $1', [key]))[0]?.value ?? null;
  }
  async setSetting(key: string, value: string) {
    await this.pool.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
  }
  async deleteSetting(key: string) {
    await this.pool.query('DELETE FROM settings WHERE key = $1', [key]);
  }

  async listSessions() {
    const rows = await this.rows<{ token_hash: string; created_at: Date; expires_at: Date; ip: string; agent: string }>(
      'SELECT token_hash, created_at, expires_at, ip, agent FROM admin_sessions',
    );
    return rows.map((r) => ({ tokenHash: r.token_hash, createdAt: r.created_at.getTime(), expiresAt: r.expires_at.getTime(), ip: r.ip, agent: r.agent }));
  }
  async saveSession(session: AdminSession) {
    await this.pool.query(
      `INSERT INTO admin_sessions (token_hash, created_at, expires_at, ip, agent)
       VALUES ($1, to_timestamp($2 / 1000.0), to_timestamp($3 / 1000.0), $4, $5)
       ON CONFLICT (token_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
      [session.tokenHash, session.createdAt, session.expiresAt, clean(session.ip), clean(session.agent)],
    );
  }
  async deleteSessions(except?: string) {
    await this.pool.query('DELETE FROM admin_sessions WHERE token_hash <> $1', [except ?? '']);
  }
  async deleteSession(tokenHash: string) {
    await this.pool.query('DELETE FROM admin_sessions WHERE token_hash = $1', [tokenHash]);
  }

  async addAudit(entry: Omit<AuditEntry, 'id'>) {
    await this.pool.query(
      `WITH added AS (
         INSERT INTO audit_log (at, action, ip, detail) VALUES (to_timestamp($1 / 1000.0), $2, $3, $4) RETURNING id
       )
       DELETE FROM audit_log WHERE id <= (SELECT id FROM added) - $5`,
      [entry.at, entry.action, clean(entry.ip), json(entry.detail), AUDIT_KEEP],
    );
  }
  async listAudit(limit: number) {
    const rows = await this.rows<{ id: string; at: Date; action: AuditAction; ip: string; detail: Record<string, unknown> }>(
      'SELECT id, at, action, ip, detail FROM audit_log ORDER BY id DESC LIMIT $1',
      [limit],
    );
    return rows.map((r) => ({ id: Number(r.id), at: r.at.getTime(), action: r.action, ip: r.ip, detail: r.detail }));
  }
}
