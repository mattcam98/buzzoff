/** Creates, finds, restores and expires rooms. */
import {
  applySystem, assembleRounds, createGame, GameError, normalizeRoomCode,
  type ContentPool, type CreateGameRequest, type CreateGameResponse,
} from '@buzzoff/shared';
import type { Config } from './config';
import { Room, type AppServer } from './room';
import type { Store } from './store/types';
import { clock, log, randomRoomCode, randomToken, sha256 } from './util';

const FINISHED_TTL_MS = 6 * 3_600_000;
const SWEEP_INTERVAL_MS = 10 * 60_000;
const MAX_ROOMS = 500;

export class Rooms {
  private rooms = new Map<string, Room>();
  private sweeper: NodeJS.Timeout;

  constructor(
    private io: AppServer,
    private store: Store,
    private config: Config,
  ) {
    this.sweeper = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS).unref();
  }

  get(code: string): Room | undefined {
    return this.rooms.get(normalizeRoomCode(code));
  }

  private isExpired(updatedAt: number, finished: boolean) {
    const ttl = this.config.ROOM_TTL_HOURS * 3_600_000;
    return Date.now() - updatedAt > (finished ? Math.min(ttl, FINISHED_TTL_MS) : ttl);
  }

  /** Bring saved games back after a restart. They return paused, so no timer runs unattended. */
  async restore() {
    for (const saved of await this.store.loadGames()) {
      if (this.isExpired(saved.updatedAt, saved.state.phase === 'finished')) {
        await this.store.deleteGame(saved.code);
        continue;
      }
      const env = { now: clock(), rand: Math.random, rtt: () => null };
      const state = applySystem(saved.state, { t: 'recover', savedAt: saved.updatedAt }, env).state;
      this.rooms.set(saved.code, new Room(this.io, this.store, { ...saved, state }));
    }
    if (this.rooms.size) log.info('restored games', { count: this.rooms.size, codes: [...this.rooms.keys()] });
  }

  private async content(packIds: string[]): Promise<{ pool: ContentPool; titles: string[] }> {
    const packs = await Promise.all(packIds.map((id) => this.store.getPack(id)));
    const found = packs.filter((p) => p !== null);
    if (found.length !== packIds.length) throw new GameError('content', 'A selected pack no longer exists');
    return {
      pool: { categories: found.flatMap((p) => p.categories), surveys: found.flatMap((p) => p.surveys) },
      titles: found.map((p) => p.title),
    };
  }

  async create(req: CreateGameRequest): Promise<CreateGameResponse> {
    if (this.rooms.size >= MAX_ROOMS) throw new GameError('busy', 'This server is hosting too many games right now');
    const { pool, titles } = await this.content(req.packIds);
    const rounds = assembleRounds(req.rules, pool, req.picks, Math.random);

    // 160,000 possible codes; retry on the rare collision with a live room.
    let code = randomRoomCode();
    for (let attempt = 0; this.rooms.has(code); attempt++) {
      if (attempt > 50) throw new GameError('busy', 'Could not allocate a room code');
      code = randomRoomCode();
    }
    const hostKey = randomToken(32);
    const state = createGame({ code, rules: req.rules, rounds, packTitles: titles, now: clock() });
    const room = new Room(this.io, this.store, { code, state, secrets: { hostKeyHash: sha256(hostKey), players: {}, plays: 1 }, updatedAt: Date.now() });
    this.rooms.set(code, room);
    await room.flush();
    log.info('game created', { code, rules: req.rules.name, packs: titles });
    return { code, hostKey };
  }

  async rematch(room: Room, req: CreateGameRequest) {
    const { pool, titles } = await this.content(req.packIds);
    room.rematch(req.rules, assembleRounds(req.rules, pool, req.picks, Math.random), titles);
    log.info('rematch', { code: room.code });
  }

  async remove(code: string) {
    const room = this.rooms.get(code);
    if (!room) return;
    this.rooms.delete(code);
    await room.close('closed');
    await this.store.deleteGame(code);
  }

  private async sweep() {
    for (const [code, room] of this.rooms) {
      if (!this.isExpired(room.updatedAt, room.state.phase === 'finished')) continue;
      log.info('expiring idle game', { code });
      await this.remove(code).catch((err) => log.error('could not expire game', { code, err }));
    }
  }

  /** Flush every room to the store; used on shutdown. */
  async shutdown() {
    clearInterval(this.sweeper);
    await Promise.all([...this.rooms.values()].map((room) => room.close(null)));
  }
}
