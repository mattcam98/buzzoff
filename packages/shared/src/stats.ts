/** Derived statistics and the permanent record of a finished game. */
import type { Avatar, GameState, PlayerStats } from './state';

/** Mean registered buzz time, or null if the player never buzzed. */
export const averageBuzzMs = (s: PlayerStats) => (s.buzzes ? s.buzzMsTotal / s.buzzes : null);

/** Share of judged answers that were correct (0–1), or null if none were judged. */
export const accuracy = (s: PlayerStats) => (s.correct + s.incorrect ? s.correct / (s.correct + s.incorrect) : null);

export interface ResultPlayer {
  /**
   * Who was in this seat, as an id that stays the same from game to game whatever name they pick
   * (see leaderboard.ts). Absent for games played before players were recognised, and for a phone
   * that kept no cookie.
   */
  profileId?: string;
  name: string;
  avatar: Avatar;
  score: number;
  team: string | null;
  eliminated: boolean;
  champion: boolean;
  stats: PlayerStats;
}

export interface GameResult {
  id: string;
  code: string;
  name: string;
  packTitles: string[];
  startedAt: number;
  finishedAt: number;
  rounds: string[];
  players: ResultPlayer[];
  teams: { name: string; score: number }[] | null;
}

/** `profiles` maps a seat (player id) to the returning player sitting in it, where the server knows. */
export function buildResult(g: GameState, id: string, profiles: Record<string, string> = {}): GameResult {
  const players = g.order
    .map((pid) => g.players[pid])
    .map((p): ResultPlayer => ({
      ...(profiles[p.id] ? { profileId: profiles[p.id] } : {}),
      name: p.name,
      avatar: p.avatar,
      score: p.score,
      team: p.teamId !== null ? (g.teamNames[p.teamId] ?? null) : null,
      eliminated: p.eliminated,
      champion: g.champions?.includes(p.id) ?? false,
      stats: g.stats[p.id],
    }))
    .sort((a, b) => Number(b.champion) - Number(a.champion) || b.score - a.score);
  return {
    id,
    code: g.code,
    name: g.rules.name,
    packTitles: g.packTitles,
    startedAt: g.createdAt,
    finishedAt: g.finishedAt ?? g.createdAt,
    rounds: g.rounds.map((r) => r.def.title),
    players,
    teams: g.rules.teams.enabled
      ? g.teamNames.map((name, i) => ({
          name,
          score: g.order.map((pid) => g.players[pid]).filter((p) => p.teamId === i).reduce((n, p) => n + p.score, 0),
        }))
      : null,
  };
}
