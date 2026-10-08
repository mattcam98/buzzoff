/**
 * Authoritative game state. This lives only on the server; clients receive
 * redacted views (see views.ts). Everything here is plain JSON so a game can be
 * snapshotted to the database and restored after a restart.
 */
import type { Media, Survey } from './content';
import type { FastMoneyRoundDef, FinalRoundDef, GameRules, TriviaRoundDef } from './rules';
import type { MatchKind } from './normalize';

export const AVATAR_EMOJI = [
  '🐝', '🦊', '🐙', '🦖', '🐸', '🦄', '🐼', '🦉', '🐯', '🐧', '🦈', '🐢',
  '🦩', '🐲', '🦝', '🐨', '👾', '🤖', '👻', '🎃', '🍕', '🌮', '🍩', '🥑',
  '🚀', '⚡', '🔥', '🌈', '🎸', '🎲', '💎', '🧠',
] as const;

export const AVATAR_COLORS = [
  '#FFC400', '#FF4D8D', '#3DDCFF', '#7CFF6B', '#B58CFF', '#FF8A3D', '#4D7CFF', '#FF5C5C', '#2EE6A6', '#F2F2F2',
] as const;

export interface Avatar {
  emoji: (typeof AVATAR_EMOJI)[number];
  color: (typeof AVATAR_COLORS)[number];
}

export interface Player {
  id: string;
  name: string;
  avatar: Avatar;
  score: number;
  teamId: number | null;
  ready: boolean;
  eliminated: boolean;
  connected: boolean;
  joinedAt: number;
}

export interface PlayerStats {
  /** Buzzes the server registered while buzzers were armed (or just after someone won). */
  buzzes: number;
  buzzMsTotal: number;
  fastestMs: number | null;
  /** Times this player won the buzz. */
  buzzWins: number;
  correct: number;
  incorrect: number;
  earlyBuzzes: number;
  surveyPoints: number;
}

export const emptyStats = (): PlayerStats => ({
  buzzes: 0,
  buzzMsTotal: 0,
  fastestMs: null,
  buzzWins: 0,
  correct: 0,
  incorrect: 0,
  earlyBuzzes: 0,
  surveyPoints: 0,
});

// ---------------------------------------------------------------- trivia

export interface BoardClue {
  value: number;
  question: string;
  answer: string;
  accept: string[];
  notes?: string;
  media?: Media;
  difficulty?: number;
  wager: boolean;
  used: boolean;
  /** Who answered correctly, once played. */
  winnerId: string | null;
}

export interface BoardCategory {
  title: string;
  blurb?: string;
  singleAttempt: boolean;
  clues: BoardClue[];
}

export interface BuzzAttempt {
  playerId: string;
  /** Milliseconds between the buzzers being armed and the server receiving this buzz. */
  ms: number;
  /** The player's median server-measured round-trip time when they buzzed, if known. */
  rttMs: number | null;
  /** `ms` minus latency compensation. Only set in latency-adjusted mode. */
  adjustedMs: number | null;
  /** Arrival order on the server; breaks exact ties. */
  seq: number;
}

export interface Judgment {
  playerId: string;
  correct: boolean;
  delta: number;
}

export type ClueStage = 'wager' | 'reading' | 'open' | 'answering' | 'result';

export interface ActiveClue {
  cat: number;
  idx: number;
  value: number;
  stage: ClueStage;
  /** Incremented every time the buzzers are armed for this clue. */
  cycle: number;
  openedAt: number | null;
  /** End of the collection window in latency-adjusted mode. */
  windowEndsAt: number | null;
  /** How many attempts had arrived when the winner was decided; null until then. */
  decided: number | null;
  deadline: number | null;
  timerMs: number | null;
  attempts: BuzzAttempt[];
  answererId: string | null;
  /** Players who can no longer buzz on this clue. */
  excluded: string[];
  /** playerId -> server time until which their buzzes are rejected. */
  lockouts: Record<string, number>;
  /** Players who buzzed before the buzzers were armed. */
  early: string[];
  wager: { playerId: string; amount: number | null } | null;
  judgments: Judgment[];
  /** Nobody buzzed before the buzz timer ran out. */
  timedOut: boolean;
  /** The answer timer ran out; the host still decides the outcome. */
  answerTimeUp: boolean;
}

export interface TriviaRound {
  mode: 'trivia';
  def: TriviaRoundDef;
  stage: 'intro' | 'board' | 'clue' | 'done';
  board: BoardCategory[];
  /** The player who picks the next clue (and plays any wager clue). */
  controlId: string | null;
  clue: ActiveClue | null;
}

// ---------------------------------------------------------------- fast money

export interface FmResponse {
  text: string;
  /** Index of the matched survey answer, or null for no match. */
  match: number | null;
  points: number;
  /** How the match was made; `host` means the host set it by hand. */
  matchedBy: MatchKind | 'host' | null;
}

export interface FmOutcome {
  /** Survey points per player. */
  totals: Record<string, number>;
  combined: number;
  /** `decider` stakes: who won the head-to-head. `points` stakes: who earned the target bonus. */
  winners: string[];
  /** Whether the target was reached; null when there is no target. */
  targetHit: boolean | null;
  bonus: number;
}

export interface FastMoneyRound {
  mode: 'fastMoney';
  def: FastMoneyRoundDef;
  stage: 'intro' | 'ready' | 'answering' | 'reveal' | 'result' | 'done';
  surveys: Survey[];
  /** Each turn is the set of players answering together. */
  turns: string[][];
  turn: number;
  deadline: number | null;
  timerMs: number | null;
  /** playerId -> one response per question. */
  responses: Record<string, FmResponse[]>;
  /** Players who finished their turn before the clock ran out. */
  finished: string[];
  /** Reveal progress through `fmCells()`: two steps (answer, points) per cell. */
  revealStep: number;
  outcome: FmOutcome | null;
}

// ---------------------------------------------------------------- final (everybody wagers)

export interface FinalRound {
  mode: 'final';
  def: FinalRoundDef;
  stage: 'intro' | 'wager' | 'answering' | 'reveal' | 'done';
  category: string;
  clue: { question: string; answer: string; accept: string[]; notes?: string; media?: Media };
  /** Players taking part, fixed when the round begins. */
  players: string[];
  wagers: Record<string, number>;
  answers: Record<string, string>;
  deadline: number | null;
  timerMs: number | null;
  /** Reveal order: lowest score first. */
  order: string[];
  /** Number of players whose answer has been shown. */
  shown: number;
  results: Record<string, { correct: boolean; delta: number }>;
}

export type RoundState = TriviaRound | FastMoneyRound | FinalRound;

// ---------------------------------------------------------------- game

export type GamePhase = 'lobby' | 'round' | 'standings' | 'finished';

export interface GameState {
  v: 1;
  code: string;
  createdAt: number;
  /** Bumped on every accepted change. */
  seq: number;
  rules: GameRules;
  packTitles: string[];
  phase: GamePhase;
  paused: boolean;
  pausedAt: number | null;
  lobbyLocked: boolean;
  roundIndex: number;
  rounds: RoundState[];
  players: Record<string, Player>;
  /** Join order. */
  order: string[];
  teamNames: string[];
  stats: Record<string, PlayerStats>;
  /** Players eliminated at the end of the most recent round. */
  lastEliminated: string[];
  /** Set when a decider round names the winner outright; otherwise the top score wins. */
  champions: string[] | null;
  finishedAt: number | null;
}

/** One-shot notifications that drive sounds and animations on clients. */
export type GameEvent =
  | { type: 'player.joined'; playerId: string }
  | { type: 'game.started' }
  | { type: 'round.intro'; index: number }
  | { type: 'round.started'; index: number }
  | { type: 'clue.selected'; wager: boolean }
  | { type: 'buzz.open' }
  | { type: 'buzz.early'; playerId: string }
  | { type: 'buzz.winner'; playerId: string }
  | { type: 'judged'; playerId: string; correct: boolean; delta: number }
  | { type: 'timeup'; what: 'buzz' | 'answer' | 'turn' }
  | { type: 'clue.result' }
  | { type: 'wager.locked'; playerId: string }
  | { type: 'round.ended'; index: number }
  | { type: 'fm.turn'; turn: number }
  | { type: 'fm.duplicate'; playerId: string }
  | { type: 'fm.reveal'; kind: 'answer' | 'points'; points: number }
  | { type: 'fm.result'; won: boolean }
  | { type: 'final.stage'; stage: 'wager' | 'answering' | 'reveal' }
  | { type: 'final.shown'; playerId: string }
  | { type: 'game.finished' }
  | { type: 'cue'; name: CueName }
  | { type: 'paused'; paused: boolean };

export const CUE_NAMES = ['applause', 'drumroll', 'airhorn', 'sad', 'tada', 'suspense', 'confetti'] as const;
export type CueName = (typeof CUE_NAMES)[number];
