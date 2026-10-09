import type { AuditEntry, GameResult, GameState, Pack, Preset } from '@buzzoff/shared';

/** Credentials for a room. Only hashes are stored. */
interface RoomSecrets {
  hostKeyHash: string;
  /** playerId -> sha256 of that player's token. */
  players: Record<string, string>;
  /** How many games have been played in this room (it goes up on a rematch). */
  plays: number;
  /**
   * playerId -> the returning player in that seat, where their phone said who it was. It is kept
   * here rather than in the game state so that it never reaches a screen.
   */
  profiles?: Record<string, string>;
}

export interface SavedGame {
  code: string;
  state: GameState;
  secrets: RoomSecrets;
  updatedAt: number;
}

/** A device signed in as host. Only the hash of its token is ever stored. */
export interface AdminSession {
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  ip: string;
  agent: string;
}

/**
 * Persistence boundary. PostgresStore is the real thing; MemoryStore backs
 * tests and database-less development.
 */
export interface Store {
  init(): Promise<void>;
  close(): Promise<void>;

  listPacks(): Promise<Pack[]>;
  getPack(id: string): Promise<Pack | null>;
  savePack(pack: Pack): Promise<void>;
  deletePack(id: string): Promise<boolean>;

  listPresets(): Promise<Preset[]>;
  savePreset(preset: Preset): Promise<void>;
  deletePreset(id: string): Promise<boolean>;

  saveGame(game: SavedGame): Promise<void>;
  loadGames(): Promise<SavedGame[]>;
  deleteGame(code: string): Promise<void>;

  saveResult(result: GameResult): Promise<void>;
  /** Newest first. Without a limit, every result there is. */
  listResults(limit?: number): Promise<GameResult[]>;
  deleteResult(id: string): Promise<void>;

  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  deleteSetting(key: string): Promise<void>;

  listSessions(): Promise<AdminSession[]>;
  saveSession(session: AdminSession): Promise<void>;
  /** Delete every session, or every session except the one with this token hash. */
  deleteSessions(except?: string): Promise<void>;
  deleteSession(tokenHash: string): Promise<void>;

  /** Append to the audit log. Only the most recent entries are kept. */
  addAudit(entry: Omit<AuditEntry, 'id'>): Promise<void>;
  listAudit(limit: number): Promise<AuditEntry[]>;
}

export const AUDIT_KEEP = 1000;
