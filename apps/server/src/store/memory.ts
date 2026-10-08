import type { GameResult, Pack, Preset } from '@buzzoff/shared';
import type { SavedGame, Store } from './types';

const copy = <T>(value: T): T => structuredClone(value);

/** Keeps everything in process memory. Nothing survives a restart. */
export class MemoryStore implements Store {
  private packs = new Map<string, Pack>();
  private presets = new Map<string, Preset>();
  private games = new Map<string, SavedGame>();
  private results = new Map<string, GameResult>();
  private settings = new Map<string, string>();

  async init() {}
  async close() {}

  async listPacks() {
    return [...this.packs.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(copy);
  }
  async getPack(id: string) {
    const pack = this.packs.get(id);
    return pack ? copy(pack) : null;
  }
  async savePack(pack: Pack) {
    this.packs.set(pack.id, copy(pack));
  }
  async deletePack(id: string) {
    return this.packs.delete(id);
  }

  async listPresets() {
    return [...this.presets.values()].map(copy);
  }
  async savePreset(preset: Preset) {
    this.presets.set(preset.id, copy(preset));
  }
  async deletePreset(id: string) {
    return this.presets.delete(id);
  }

  async saveGame(game: SavedGame) {
    this.games.set(game.code, copy(game));
  }
  async loadGames() {
    return [...this.games.values()].map(copy);
  }
  async deleteGame(code: string) {
    this.games.delete(code);
  }

  async saveResult(result: GameResult) {
    this.results.set(result.id, copy(result));
  }
  async listResults(limit: number) {
    return [...this.results.values()].sort((a, b) => b.finishedAt - a.finishedAt).slice(0, limit).map(copy);
  }
  async deleteResult(id: string) {
    this.results.delete(id);
  }

  async getSetting(key: string) {
    return this.settings.get(key) ?? null;
  }
  async setSetting(key: string, value: string) {
    this.settings.set(key, value);
  }
}
