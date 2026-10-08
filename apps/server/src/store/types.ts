import type { GameResult, GameState, Pack, Preset } from '@buzzoff/shared';

/** Credentials for a room. Only hashes are stored. */
export interface RoomSecrets {
  hostKeyHash: string;
  /** playerId -> sha256 of that player's token. */
  players: Record<string, string>;
  /** How many games have been played in this room (it goes up on a rematch). */
  plays: number;
}

export interface SavedGame {
  code: string;
  state: GameState;
  secrets: RoomSecrets;
  updatedAt: number;
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
  listResults(limit: number): Promise<GameResult[]>;
  deleteResult(id: string): Promise<void>;

  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
}
