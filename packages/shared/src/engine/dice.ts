/**
 * The roll for the first pick. Everyone taps to roll one die; the highest roll
 * takes the board. A tie is settled by the tied players rolling again, as many
 * times as it takes.
 *
 *   rolling ──everyone in / time──▶ landing ──▶ won ──▶ (the board)
 *      ▲                               │
 *      └──────────── tied ◀────────────┘  (only the tied players roll again)
 *
 * Every number comes from `ctx.rand` on the server. The pauses between phases
 * are there for the screens: a die takes a moment to tumble and be read.
 */
import type { DiceRoll, TriviaRound } from '../state';
import { fail, type Ctx } from './core';

/** How long players have to tap before the server rolls for them. */
const ROLL_MS = 12_000;
const REROLL_MS = 8_000;
/** Time for the last die to stop tumbling before the result is called. */
const LAND_MS = 1_800;
const TIE_MS = 2_400;
const WIN_MS = 3_500;

const waiting = (roll: DiceRoll) => roll.contenders.filter((id) => roll.rolls[id] === undefined);
const leaders = (roll: DiceRoll) => {
  const best = Math.max(...roll.contenders.map((id) => roll.rolls[id] ?? 0));
  return roll.contenders.filter((id) => roll.rolls[id] === best);
};

export function startRoll(r: TriviaRound, contenders: string[], ctx: Ctx, round = 1, out: Record<string, number> = {}): void {
  const ms = round === 1 ? ROLL_MS : REROLL_MS;
  r.stage = 'roll';
  r.roll = { round, phase: 'rolling', contenders, rolls: {}, out, winnerId: null, deadline: ctx.now + ms, timerMs: ms };
}

function roll(r: DiceRoll, playerId: string, ctx: Ctx): void {
  const value = 1 + Math.floor(ctx.rand() * 6);
  r.rolls[playerId] = value;
  ctx.events.push({ type: 'dice.rolled', playerId, value });
  if (waiting(r).length) return;
  r.phase = 'landing';
  r.deadline = ctx.now + LAND_MS;
  r.timerMs = null;
}

const rolling = (r: TriviaRound): DiceRoll => (r.roll?.phase === 'rolling' ? r.roll : fail('bad_stage', 'Nobody is rolling right now'));

export function rollDie(r: TriviaRound, playerId: string, ctx: Ctx): void {
  const dice = rolling(r);
  if (!dice.contenders.includes(playerId)) fail('not_yours', 'You are not in this roll');
  if (dice.rolls[playerId] !== undefined) fail('duplicate', 'You have already rolled');
  roll(dice, playerId, ctx);
}

/** Roll for everyone who has not: the host hurrying things along, or time running out. */
export function rollForRest(r: TriviaRound, ctx: Ctx): void {
  const dice = rolling(r);
  for (const id of waiting(dice)) roll(dice, id, ctx);
}

/** Leave the roll for the board, whoever ended up with it. */
export function endRoll(r: TriviaRound): void {
  r.roll = null;
  r.stage = 'board';
}

export function tickRoll(r: TriviaRound, ctx: Ctx): void {
  const dice = r.roll;
  if (!dice || dice.deadline === null || ctx.now < dice.deadline) return;
  // Everyone who was rolling may have left the game.
  if (!dice.contenders.length) return endRoll(r);
  if (dice.phase === 'rolling') return rollForRest(r, ctx);
  if (dice.phase === 'won') return endRoll(r);

  const top = leaders(dice);
  if (dice.phase === 'tied') {
    const beaten = Object.fromEntries(dice.contenders.filter((id) => !top.includes(id)).map((id) => [id, dice.rolls[id]]));
    return startRoll(r, top, ctx, dice.round + 1, { ...dice.out, ...beaten });
  }
  if (top.length > 1) {
    dice.phase = 'tied';
    dice.deadline = ctx.now + TIE_MS;
    ctx.events.push({ type: 'dice.tied', playerIds: top });
    return;
  }
  dice.phase = 'won';
  dice.winnerId = top[0];
  dice.deadline = ctx.now + WIN_MS;
  r.controlId = top[0];
  ctx.events.push({ type: 'dice.won', playerId: top[0] });
}

export function removeFromRoll(r: TriviaRound, playerId: string): void {
  const dice = r.roll;
  if (!dice) return;
  dice.contenders = dice.contenders.filter((id) => id !== playerId);
  delete dice.rolls[playerId];
  delete dice.out[playerId];
  if (dice.winnerId === playerId) dice.winnerId = null;
}
