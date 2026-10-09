/** Creates, finds, restores and expires rooms. */
import {
  applySystem, assembleRounds, createGame, GameError, normalizeRoomCode,
  type ContentPool, type CreateGameRequest, type CreateGameResponse,
} from '@buzzoff/shared';
import type { Results } from './results';
import { Room, type AppServer } from './room';
import type { Settings } from './settings';
import type { Store } from './store/types';
import { clock, log, random, randomRoomCode, randomToken, sha256 } from './util';

const SWEEP_INTERVAL_MS = 10 * 60_000;
const MAX_ROOMS = 500;

export class Rooms {
  private rooms = new Map<string, Room>();
  private sweeper: NodeJS.Timeout;

  constructor(
    private io: AppServer,
    private store: Store,
    private results: Results,
    private settings: Settings,
  ) {
    this.sweeper = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS).unref();
  }

  get(code: string): Room | undefined {
    return this.rooms.get(normalizeRoomCode(code));
  }

  private isExpired(updatedAt: number, finished: boolean) {
    const { roomTtlHours, finishedTtlHours } = this.settings.current;
    return Date.now() - updatedAt > (finished ? finishedTtlHours : roomTtlHours) * 3_600_000;
  }

  /** Bring saved games back after a restart. They return paused, so no timer runs unattended. */
  async restore() {
    for (const saved of await this.store.loadGames()) {
      if (this.isExpired(saved.updatedAt, saved.state.phase === 'finished')) {
        await this.store.deleteGame(saved.code);
        continue;
      }
      try {
        const env = { now: clock(), rand: random, rtt: () => null };
        const state = applySystem(saved.state, { t: 'recover', savedAt: saved.updatedAt }, env).state;
        this.rooms.set(saved.code, new Room(this.io, this.store, this.results, { ...saved, state }));
      } catch (err) {
        // One unreadable game must not keep every other game, or the server, from coming back.
        log.error('could not restore game', { code: saved.code, err });
      }
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
    const rounds = assembleRounds(req.rules, pool, req.picks, random);

    // 160,000 possible codes; retry on the rare collision with a live room.
    let code = randomRoomCode();
    for (let attempt = 0; this.rooms.has(code); attempt++) {
      if (attempt > 50) throw new GameError('busy', 'Couldn’t find a free room code. Try again.');
      code = randomRoomCode();
    }
    const hostKey = randomToken(32);
    const state = createGame({ code, rules: req.rules, rounds, packTitles: titles, packIds: req.packIds, now: clock() });
    const secrets = { hostKeyHash: sha256(hostKey), players: {}, plays: 1, profiles: {} };
    const room = new Room(this.io, this.store, this.results, { code, state, secrets, updatedAt: Date.now() });
    this.rooms.set(code, room);
    await room.flush();
    log.info('game created', { code, rules: req.rules.name, packs: titles });
    return { code, hostKey };
  }

  async rematch(room: Room, req: CreateGameRequest) {
    const { pool, titles } = await this.content(req.packIds);
    room.rematch(req.rules, assembleRounds(req.rules, pool, req.picks, random), titles, req.packIds);
    log.info('rematch', { code: room.code });
  }

  /** Swap one category of the round being introduced for another from the game's packs, as they are now. */
  async reroll(room: Room, cat: number) {
    const packIds = room.state.packIds;
    if (!packIds?.length) throw new GameError('content', 'This game was set up before categories could be changed');
    const { pool } = await this.content(packIds);
    room.reroll(cat, pool.categories);
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
