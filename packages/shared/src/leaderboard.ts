/**
 * The all-time leaderboard. It is not stored anywhere: it is worked out from the results of
 * finished games (stats.ts), so History stays the one record of what happened, and removing a
 * game there takes it out of the standings too.
 *
 * Who is who. A seat in a result belongs to a person in one of two ways:
 *  - its `profileId`, which the server derives from a cookie it gives each phone. That stays the
 *    same whatever name or avatar the player picks next time.
 *  - failing that, the name they played under.
 * A name with no profile behind it is taken to be the one profile that has ever played under that
 * name. Anything less certain is left to the host, who can say that two entries are the same
 * person, or pull one back out (`PlayerLinks`).
 */
import { emptyStats, nameKey, type Avatar, type PlayerStats } from './state';
import { accuracy, averageBuzzMs, type GameResult, type ResultPlayer } from './stats';

/**
 * The host's word on who is who: `from → into`. An identity linked to itself is its own player,
 * whatever its name might otherwise match.
 */
export type PlayerLinks = Record<string, string>;

export interface LeaderboardGame {
  name: string;
  finishedAt: number;
  /** The name they used that night. */
  playedAs: string;
  score: number;
  place: number;
  /** How many players took part. */
  of: number;
  won: boolean;
}

/** One of the identities that make up an entry: a phone's profile, or a name nobody's profile claims. */
export interface LeaderboardIdentity {
  id: string;
  name: string;
  games: number;
}

export interface LeaderboardEntry {
  id: string;
  /** The name and avatar they played under most recently. */
  name: string;
  avatar: Avatar;
  /** Other names they have played under, most recent first. */
  aliases: string[];
  games: number;
  wins: number;
  /** Final scores added up. Formats score differently, so this says more about how much someone plays than how well. */
  points: number;
  best: number;
  /** Buzzer and answer statistics added up over every game. */
  stats: PlayerStats;
  lastPlayedAt: number;
  /** Their latest games, newest first. */
  recent: LeaderboardGame[];
  /** Everything counted as this player, the entry's own identity first. Only the host is sent this. */
  identities: LeaderboardIdentity[];
}

export interface Leaderboard {
  players: LeaderboardEntry[];
  /** Games that counted. */
  games: number;
}

/** What the API answers with: the standings, plus what it knows about whoever is asking. */
export interface LeaderboardView extends Leaderboard {
  /** The asker's own entry, if their phone has played here. */
  you: string | null;
  /** Whether the asker may merge and separate players. */
  canEdit: boolean;
}

export const RECENT_GAMES = 10;

const nameIdentity = (name: string) => `name:${nameKey(name)}`;
/** Whether an identity is a name nobody's phone vouches for, rather than a phone's profile. */
export const isNameIdentity = (identity: string) => identity.startsWith('name:');

/** Never scored, buzzed or answered. */
const idle = ({ score, stats }: ResultPlayer) => score === 0 && !stats.buzzes && !stats.correct && !stats.incorrect && !stats.surveyPoints;

interface Seat {
  player: ResultPlayer;
  /** Who the result itself says this is, before any linking. */
  raw: string;
}

/** The people in a game, each with the identity the result gives them. */
function seatsOf(result: GameResult): Seat[] {
  const taken = new Set<string>();
  const seats: Seat[] = [];
  for (const player of result.players) {
    let raw = player.profileId ?? nameIdentity(player.name);
    if (taken.has(raw)) {
      // One phone, two seats. A seat that did nothing is one somebody joined and then left behind
      // for another name; one that played is a second person on a shared phone, known by name.
      if (idle(player)) continue;
      raw = nameIdentity(player.name);
    }
    taken.add(raw);
    seats.push({ player, raw });
  }
  return seats;
}

/** Whoever finishes ahead: a champion before anyone who is not, then the higher score. */
const ahead = (a: ResultPlayer, b: ResultPlayer) => (a.champion !== b.champion ? a.champion : a.score > b.score);

function addStats(total: PlayerStats, s: PlayerStats): void {
  total.buzzes += s.buzzes;
  total.buzzMsTotal += s.buzzMsTotal;
  total.buzzWins += s.buzzWins;
  total.correct += s.correct;
  total.incorrect += s.incorrect;
  total.surveyPoints += s.surveyPoints;
  if (s.fastestMs !== null) total.fastestMs = total.fastestMs === null ? s.fastestMs : Math.min(total.fastestMs, s.fastestMs);
}

interface Tally {
  entry: LeaderboardEntry;
  gameIds: Set<string>;
  /** Names played under, keyed without case or spacing; the latest use of each is last. */
  names: Map<string, string>;
  identities: Map<string, LeaderboardIdentity>;
}

function tally(results: GameResult[], links: PlayerLinks): { players: Map<string, Tally>; games: number } {
  // A game counts when it was a contest: two or more people, and something was played.
  const games = results
    .map((result) => ({ result, seats: seatsOf(result) }))
    .filter(({ seats }) => seats.length >= 2 && !seats.every((s) => idle(s.player)))
    .sort((a, b) => a.result.finishedAt - b.result.finishedAt);

  // A name with no profile behind it belongs to the one profile that has used it, as long as the
  // two were never in the same game.
  const gamesOf = new Map<string, Set<string>>();
  const profilesNamed = new Map<string, Set<string>>();
  const note = (map: Map<string, Set<string>>, key: string, value: string) => map.set(key, (map.get(key) ?? new Set()).add(value));
  for (const { result, seats } of games) {
    for (const { player, raw } of seats) {
      note(gamesOf, raw, result.id);
      if (raw === player.profileId) note(profilesNamed, nameIdentity(player.name), raw);
    }
  }
  const byName = new Map<string, string>();
  for (const [name, profiles] of profilesNamed) {
    const [profile] = profiles;
    const loose = gamesOf.get(name);
    if (profiles.size === 1 && loose && [...loose].every((id) => !gamesOf.get(profile)!.has(id))) byName.set(name, profile);
  }

  const rootOf = (raw: string) => {
    let id = raw;
    for (const seen = new Set<string>(); !seen.has(id); ) {
      seen.add(id);
      const next = Object.hasOwn(links, id) ? links[id] : byName.get(id);
      if (next === undefined || next === id) break;
      id = next;
    }
    return id;
  };

  const players = new Map<string, Tally>();
  for (const { result, seats } of games) {
    // Two seats in one game are two people, whatever the links say: the second keeps its own identity.
    const roots = seats.map((s) => rootOf(s.raw));
    const ids = seats.map((s, i) => {
      if (roots[i] === s.raw) return s.raw;
      const owned = seats.some((o, j) => roots[j] === roots[i] && o.raw === roots[j]);
      return !owned && roots.indexOf(roots[i]) === i ? roots[i] : s.raw;
    });
    // Winning takes someone to beat: when everybody is a champion, nobody is.
    const contested = seats.some((s) => !s.player.champion);

    seats.forEach(({ player, raw }, i) => {
      const id = ids[i];
      const t =
        players.get(id) ??
        players
          .set(id, {
            entry: {
              id, name: player.name, avatar: player.avatar, aliases: [], games: 0, wins: 0, points: 0, best: player.score,
              stats: emptyStats(), lastPlayedAt: 0, recent: [], identities: [],
            },
            gameIds: new Set(),
            names: new Map(),
            identities: new Map(),
          })
          .get(id)!;
      const { entry } = t;
      const won = contested && player.champion;
      entry.name = player.name;
      entry.avatar = player.avatar;
      entry.games += 1;
      entry.wins += Number(won);
      entry.points += player.score;
      entry.best = Math.max(entry.best, player.score);
      entry.lastPlayedAt = result.finishedAt;
      addStats(entry.stats, player.stats);
      entry.recent.unshift({
        name: result.name, finishedAt: result.finishedAt, playedAs: player.name, score: player.score,
        place: 1 + seats.filter((o) => ahead(o.player, player)).length, of: seats.length, won,
      });
      if (entry.recent.length > RECENT_GAMES) entry.recent.pop();

      t.gameIds.add(result.id);
      t.names.delete(nameKey(player.name));
      t.names.set(nameKey(player.name), player.name);
      const part = t.identities.get(raw) ?? t.identities.set(raw, { id: raw, name: player.name, games: 0 }).get(raw)!;
      part.name = player.name;
      part.games += 1;
    });
  }

  for (const [id, { entry, names, identities }] of players) {
    entry.aliases = [...names.values()].reverse().slice(1);
    entry.identities = [...identities.values()].sort((a, b) => Number(b.id === id) - Number(a.id === id) || b.games - a.games);
  }
  return { players, games: games.length };
}

export function buildLeaderboard(results: GameResult[], links: PlayerLinks = {}): Leaderboard {
  const { players, games } = tally(results, links);
  return { players: [...players.values()].map((t) => t.entry), games };
}

/** Why two entries cannot be counted as one person, or null if they can. */
export function mergeProblem(results: GameResult[], links: PlayerLinks, from: string, into: string): string | null {
  const { players } = tally(results, links);
  const a = players.get(from);
  const b = players.get(into);
  if (!a || !b) return 'That player is no longer on the leaderboard';
  if (a === b) return 'Pick two different players';
  if ([...a.gameIds].some((id) => b.gameIds.has(id))) return `${a.entry.name} and ${b.entry.name} played in the same game, so they cannot be the same person`;
  return null;
}

// ---------------------------------------------------------------- ranking

/** Share of games won (0–1). */
export const winRate = (e: Pick<LeaderboardEntry, 'games' | 'wins'>) => (e.games ? e.wins / e.games : null);
export const averageScore = (e: Pick<LeaderboardEntry, 'games' | 'points'>) => (e.games ? e.points / e.games : null);
/** Share of this player's registered buzzes that were the first in (0–1), or null if they never buzzed. */
export const firstInRate = (s: PlayerStats) => (s.buzzes ? s.buzzWins / s.buzzes : null);

/** The ways the standings can be ordered. */
export const LENSES = ['wins', 'winRate', 'points', 'accuracy', 'buzzer'] as const;
export type Lens = (typeof LENSES)[number];

interface LensSpec {
  /** What a player needs some of before a rate means anything, and how much. */
  unit: 'game' | 'answer' | 'buzz';
  sample: (e: LeaderboardEntry) => number;
  needs: number;
  /** Compared left to right; higher is better. Players level on all of them share a rank. */
  keys: (e: LeaderboardEntry) => number[];
}

const games = (e: LeaderboardEntry) => e.games;

/**
 * Counts (wins, points) rank everybody. Rates need a minimum of play first, as in any sport's
 * averages: one win from one game is not the best record in the room.
 */
const LENS: Record<Lens, LensSpec> = {
  wins: { unit: 'game', sample: games, needs: 1, keys: (e) => [e.wins, winRate(e) ?? 0] },
  winRate: { unit: 'game', sample: games, needs: 3, keys: (e) => [winRate(e) ?? 0, e.wins] },
  points: { unit: 'game', sample: games, needs: 1, keys: (e) => [e.points, averageScore(e) ?? 0] },
  accuracy: { unit: 'answer', sample: (e) => e.stats.correct + e.stats.incorrect, needs: 10, keys: (e) => [accuracy(e.stats) ?? 0, e.stats.correct] },
  buzzer: {
    unit: 'buzz', sample: (e) => e.stats.buzzes, needs: 10,
    keys: (e) => [firstInRate(e.stats) ?? 0, e.stats.buzzWins, -(averageBuzzMs(e.stats) ?? Infinity)],
  },
};

export interface RankedEntry {
  entry: LeaderboardEntry;
  /** Null for someone who has not played enough to be ranked this way. */
  rank: number | null;
  /** Someone else holds the same rank. */
  tied: boolean;
}

export interface Ranking {
  rows: RankedEntry[];
  /** How much play it takes to be ranked this way. */
  minimum: number;
  unit: LensSpec['unit'];
}

/**
 * Order the players one way. Those who have played enough come first, ranked, with equals
 * sharing a rank (1, 2, 2, 4); the rest follow in the same order, unranked. The minimum is never
 * more than the busiest player has managed, so a new league ranks everyone from its first night.
 */
export function rankPlayers(players: LeaderboardEntry[], lens: Lens): Ranking {
  const spec = LENS[lens];
  const minimum = Math.max(1, Math.min(spec.needs, Math.max(0, ...players.map(spec.sample))));
  const rows = players.map((entry) => ({ entry, keys: spec.keys(entry), ranked: spec.sample(entry) >= minimum }));
  const byKeys = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i] - a[i];
    return 0;
  };
  rows.sort((a, b) => Number(b.ranked) - Number(a.ranked) || byKeys(a.keys, b.keys) || b.entry.lastPlayedAt - a.entry.lastPlayedAt || a.entry.name.localeCompare(b.entry.name));

  const level = (i: number, j: number) => !!rows[i] && !!rows[j] && rows[i].ranked && rows[j].ranked && byKeys(rows[i].keys, rows[j].keys) === 0;
  let rank = 0;
  return {
    minimum,
    unit: spec.unit,
    rows: rows.map(({ entry, ranked }, i) => {
      if (!ranked) return { entry, rank: null, tied: false };
      if (!level(i, i - 1)) rank = i + 1;
      return { entry, rank, tied: level(i, i - 1) || level(i, i + 1) };
    }),
  };
}
