/** Everything the browser remembers between visits. All access is defensive: storage may be blocked. */
import type { Avatar, CreateGameRequest } from '@buzzoff/shared';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode or storage full: the app still works for this session */
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

export const storage = {
  seat: (code: string) => read<PlayerSeat | null>(`buzzoff.seat.${code}`, null),
  setSeat: (code: string, seat: PlayerSeat | null) => write(`buzzoff.seat.${code}`, seat),

  profile: () => read<Profile | null>('buzzoff.profile', null),
  setProfile: (profile: Profile) => write('buzzoff.profile', profile),

  hostedGames: () => read<HostedGame[]>('buzzoff.hosted', []),
  addHostedGame(game: HostedGame) {
    write('buzzoff.hosted', [game, ...this.hostedGames().filter((g) => g.code !== game.code)].slice(0, 12));
  },
  removeHostedGame(code: string) {
    write('buzzoff.hosted', this.hostedGames().filter((g) => g.code !== code));
  },
  hostKey(code: string) {
    return this.hostedGames().find((g) => g.code === code)?.hostKey ?? null;
  },

  adminToken: () => read<string | null>('buzzoff.admin', null),
  setAdminToken: (token: string | null) => write('buzzoff.admin', token),

  lastSetup: () => read<LastSetup | null>('buzzoff.lastSetup', null),
  setLastSetup: (setup: LastSetup) => write('buzzoff.lastSetup', setup),

  /** The exact request a game was created with, so a rematch is one click. */
  gameSetup: (code: string) => read<CreateGameRequest | null>(`buzzoff.setup.${code}`, null),
  setGameSetup: (code: string, setup: CreateGameRequest | null) => write(`buzzoff.setup.${code}`, setup),

  muted: () => read<boolean>('buzzoff.muted', false),
  setMuted: (muted: boolean) => write('buzzoff.muted', muted),
};
