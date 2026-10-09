/**
 * Everything a client may ask the server to do. These schemas are the
 * validated contract: the server parses every incoming action with them and
 * the engine only ever sees well-formed values.
 */
import { z } from 'zod';
import { AVATAR_COLORS, AVATAR_EMOJI, CUE_NAMES } from './state';

const id = z.string().min(1).max(40);
const int = z.number().int().min(-10_000_000).max(10_000_000);
const index = z.number().int().min(0).max(50);
function act<T extends string>(t: T): z.ZodObject<{ t: z.ZodLiteral<T> }>;
function act<T extends string, S extends z.ZodRawShape>(t: T, shape: S): z.ZodObject<{ t: z.ZodLiteral<T> } & S>;
function act(t: string, shape: z.ZodRawShape = {}) {
  return z.object({ t: z.literal(t), ...shape });
}

export const NameSchema = z
  .string()
  .transform((s) => s.replace(/\s+/g, ' ').trim())
  .pipe(z.string().min(1, 'Enter a name').max(16, 'Keep it to 16 characters'));

export const AvatarSchema = z.object({
  emoji: z.enum(AVATAR_EMOJI),
  color: z.enum(AVATAR_COLORS),
});

export const HostActionSchema = z.discriminatedUnion('t', [
  // session
  act('start'),
  act('lobby.lock', { locked: z.boolean() }),
  act('pause', { paused: z.boolean() }),
  act('undo'),
  act('round.begin'),
  act('round.end'),
  act('round.next'),
  act('game.end'),
  act('timer.extend', { sec: z.number().int().min(1).max(300) }),
  act('timer.stop'),
  act('cue', { name: z.enum(CUE_NAMES) }),
  act('music', { on: z.boolean() }),
  // contestants
  act('player.kick', { id }),
  act('player.rename', { id, name: NameSchema }),
  act('player.team', { id, teamId: z.number().int().min(0).max(5).nullable() }),
  act('player.eliminate', { id, eliminated: z.boolean() }),
  act('team.rename', { teamId: z.number().int().min(0).max(5), name: z.string().trim().min(1).max(24) }),
  act('teams.shuffle'),
  act('score.adjust', { id, delta: int }),
  act('score.set', { id, score: int }),
  act('claim.resolve', { claimId: id, approve: z.boolean() }),
  // trivia
  act('clue.select', { cat: index, idx: index }),
  act('buzz.reset'),
  act('judge', { correct: z.boolean() }),
  act('clue.reveal'),
  act('clue.continue'),
  act('clue.cancel'),
  act('control.set', { id }),
  act('roll.finish'),
  act('wager.set', { amount: z.number().int().min(0).max(10_000_000) }),
  // fast money
  act('fm.start'),
  act('fm.endTurn'),
  act('fm.override', { playerId: id, q: index, match: index.nullable() }),
  act('fm.setAnswer', { playerId: id, q: index, text: z.string().trim().max(80) }),
  act('fm.reveal'),
  act('fm.next'),
  // final
  act('final.advance'),
  act('final.show'),
  act('final.judge', { correct: z.boolean() }),
]);

export const PlayerActionSchema = z.discriminatedUnion('t', [
  act('ready', { ready: z.boolean() }),
  act('profile', { name: NameSchema, avatar: AvatarSchema }),
  act('team', { teamId: z.number().int().min(0).max(5) }),
  act('roll'),
  act('wager', { amount: z.number().int().min(0).max(10_000_000) }),
  act('fm.answer', { q: index, text: z.string().trim().max(80) }),
  act('fm.done'),
  act('final.answer', { text: z.string().trim().max(120) }),
]);

export type HostAction = z.infer<typeof HostActionSchema>;
export type PlayerAction = z.infer<typeof PlayerActionSchema>;

/** Why a buzz was or was not registered. Returned to the buzzing player only. */
export type BuzzStatus =
  | 'registered' // recorded; a winner may not be decided yet
  | 'duplicate' // already buzzed in this cycle
  | 'excluded' // already answered this clue, or eliminated
  | 'closed'; // nothing to buzz for

export interface BuzzAck {
  status: BuzzStatus;
  /** Server-recorded milliseconds since the buzzers opened. */
  ms?: number;
}
