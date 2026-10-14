/** Everything the browser remembers between visits. All access is defensive: storage may be blocked. */
import type { Avatar, CreateGameRequest } from '@buzzoff/shared';

/**
 * Where the browser refuses storage (private modes, some in-app browsers), what would have been
 * kept is held here instead. It lasts until the page is closed, which is enough to take a seat and play.
 */
const memory = new Map<string, string>();

function read<T>(key: string, fallback: T): T {
  try {
    const raw = memory.get(key) ?? localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  const gone = value === null || value === undefined;
  memory.delete(key);
  try {
    if (gone) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    if (!gone) memory.set(key, JSON.stringify(value));
  }
}

export interface PlayerSeat {
  playerId: string;
  token: string;
}
export interface HostedGame {
  code: string;
  hostKey: string;
  name: string;
  createdAt: number;
}
export interface Profile {
  name: string;
  avatar: Avatar;
}
/** What the last game was created from, so "play again" needs no setup. */
export interface LastSetup {
  packIds: string[];
  presetId: string;
}

/** How many rooms a browser remembers hosting. What it kept for an older one goes when the room does. */
const HOSTED_LIMIT = 12;

export const storage = {
  seat: (code: string) => read<PlayerSeat | null>(`buzzoff.seat.${code}`, null),
  setSeat(code: string, seat: PlayerSeat | null) {
    write(`buzzoff.seat.${code}`, seat);
    if (seat) write('buzzoff.room', code);
    else if (read<string | null>('buzzoff.room', null) === code) write('buzzoff.room', null);
  },
  /** The room this phone last took a seat in and still holds it, so the front door can offer the way back. */
  room() {
    const code = read<string | null>('buzzoff.room', null);
    return code && this.seat(code) ? code : null;
  },

  profile: () => read<Profile | null>('buzzoff.profile', null),
  setProfile: (profile: Profile) => write('buzzoff.profile', profile),

  hostedGames: () => read<HostedGame[]>('buzzoff.hosted', []),
  addHostedGame(game: HostedGame) {
    const games = [game, ...this.hostedGames().filter((g) => g.code !== game.code)];
    for (const dropped of games.slice(HOSTED_LIMIT)) this.setGameSetup(dropped.code, null);
    write('buzzoff.hosted', games.slice(0, HOSTED_LIMIT));
  },
  removeHostedGame(code: string) {
    write('buzzoff.hosted', this.hostedGames().filter((g) => g.code !== code));
    this.setGameSetup(code, null);
  },
  hostKey(code: string) {
    return this.hostedGames().find((g) => g.code === code)?.hostKey ?? null;
  },

  adminToken: () => read<string | null>('buzzoff.admin', null),
  setAdminToken: (token: string | null) => write('buzzoff.admin', token),

  lastSetup: () => read<LastSetup | null>('buzzoff.lastSetup', null),
  setLastSetup: (setup: LastSetup) => write('buzzoff.lastSetup', setup),

  /** Whether a shared screen opened in this browser draws the lit floor behind the game. On unless switched off there. */
  stageLights: () => read<boolean>('buzzoff.stageLights', true),
  setStageLights: (on: boolean) => write('buzzoff.stageLights', on),

  /** The exact request a game was created with, so a rematch is one click. */
  gameSetup: (code: string) => read<CreateGameRequest | null>(`buzzoff.setup.${code}`, null),
  setGameSetup: (code: string, setup: CreateGameRequest | null) => write(`buzzoff.setup.${code}`, setup),
};
