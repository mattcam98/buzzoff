/**
 * Shared engine plumbing. The engine is pure: the clock, randomness and network
 * measurements all arrive through `Ctx`, which is what makes buzzer ordering
 * and every transition deterministic and unit-testable.
 */
import type { BuzzAck, HostAction, PlayerAction } from '../actions';
import type { GameEvent, GameState, Player, RoundState } from '../state';
import type { PlayerView, TimerView } from '../views';

export interface Ctx {
  /** Server time in ms. Monotonic within a server process; epoch-aligned so clients can render deadlines. */
  now: number;
  rand: () => number;
  /** Median server-measured round-trip time for a player, if known. */
  rtt: (playerId: string) => number | null;
  /** One-shot events produced by this transition. */
  events: GameEvent[];
}

/** A rejected action. `code` is stable for clients; `message` is safe to show. */
export class GameError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function fail(code: string, message: string): never {
  throw new GameError(code, message);
}

/**
 * A game mode. To add a new mode: define its round definition in rules.ts and
 * its state in state.ts, implement this interface, and register it in
 * engine/game.ts. Nothing else in the engine needs to change.
 */
export interface Mode<R extends RoundState, Pub, Secret> {
  /** Leave the intro and start play. */
  begin(g: GameState, r: R, ctx: Ctx): void;
  /** Handle a host action; return false if the action is not for this mode. */
  host(g: GameState, r: R, action: HostAction, ctx: Ctx): boolean;
  player(g: GameState, r: R, playerId: string, action: PlayerAction, ctx: Ctx): boolean;
  /** Only modes with a buzzer implement this. Returns whether state changed. */
  buzz?(g: GameState, r: R, playerId: string, ctx: Ctx): { ack: BuzzAck; changed: boolean };
  /** Fire anything whose deadline has passed. */
  tick(g: GameState, r: R, ctx: Ctx): void;
  /** Every server time at which `tick` needs to run. */
  deadlines(r: R): (number | null)[];
  /** The object holding this round's visible countdown, if one is running. */
  timer(r: R): { deadline: number | null; timerMs: number | null } | null;
  /** Move every stored server time by `deltaMs` (resume after pause, undo, restart). */
  shift(r: R, deltaMs: number): void;
  /** Stop anything that only makes sense in continuous time, such as an open buzzer. */
  interrupt(r: R): void;
  /** Start again whatever `interrupt` stopped, now that time is running. */
  resume(g: GameState, r: R, ctx: Pick<Ctx, 'now' | 'events'>): void;
  playerRemoved(g: GameState, r: R, playerId: string): void;
  publicView(g: GameState, r: R): Pub;
  hostView(g: GameState, r: R): Secret;
  /** This player's private controller state; anything omitted takes the default. */
  playerView(g: GameState, r: R, playerId: string): Partial<Omit<PlayerView, 'id'>>;
}

// ---------------------------------------------------------------- helpers

export const playersOf = (g: GameState): Player[] => g.order.map((id) => g.players[id]);
export const activePlayers = (g: GameState): Player[] => playersOf(g).filter((p) => !p.eliminated);

/** Highest score first; earlier joiners win ties so the order is stable. */
export const ranked = (players: Player[]): Player[] =>
  [...players].sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt);

export const requirePlayer = (g: GameState, id: string): Player =>
  g.players[id] ?? fail('no_player', 'That player is no longer in the game');

export function addScore(g: GameState, playerId: string, delta: number): void {
  const p = g.players[playerId];
  if (p) p.score += delta;
}

export function setTimer(target: { deadline: number | null; timerMs: number | null }, seconds: number, now: number): void {
  target.timerMs = seconds > 0 ? seconds * 1000 : null;
  target.deadline = seconds > 0 ? now + seconds * 1000 : null;
}

export const timerView = (t: { deadline: number | null; timerMs: number | null }): TimerView | null =>
  t.deadline !== null && t.timerMs !== null ? { endsAt: t.deadline, totalMs: t.timerMs } : null;

export const shiftTime = (t: number | null, delta: number) => (t === null ? null : t + delta);

/** A player may wager up to their score, or up to `cap` if they have less. */
export const maxWager = (score: number, cap: number) => Math.max(score, cap, 0);

export const round3 = (n: number) => Math.round(n * 1000) / 1000;
