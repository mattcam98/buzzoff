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

/** Names are compared without case or spacing, so "Ann" and "a n n" are the same player. */
export const nameKey = (name: string) => name.toLowerCase().replace(/\s+/g, '');

/**
 * Who the show is still waiting on in the lobby: players whose phones are connected and who have
 * not tapped ready. A phone that has dropped out does not hold the room up.
 */
export const notReady = <P extends { connected: boolean; ready: boolean }>(players: P[]): P[] => players.filter((p) => p.connected && !p.ready);

/** The show can start once nobody is being waited on and at least one player has tapped ready. */
export const canStart = (players: { connected: boolean; ready: boolean }[]): boolean => !notReady(players).length && players.some((p) => p.ready);

export interface PlayerStats {
  /** Buzzes the server registered while buzzers were armed (or just after someone won). */
  buzzes: number;
  buzzMsTotal: number;
  fastestMs: number | null;
  /** Times this player won the buzz. */
  buzzWins: number;
  correct: number;
  incorrect: number;
  surveyPoints: number;
}

export const emptyStats = (): PlayerStats => ({
  buzzes: 0,
  buzzMsTotal: 0,
  fastestMs: null,
  buzzWins: 0,
  correct: 0,
  incorrect: 0,
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

/**
 * Buzzers open the moment a clue goes up. `reading` is the one time a clue is on
 * screen with them shut: while the game is paused. Resuming opens them again.
 */
export type ClueStage = 'wager' | 'reading' | 'open' | 'answering' | 'result';

export interface ActiveClue {
  cat: number;
  idx: number;
  value: number;
  stage: ClueStage;
  /** Incremented every time the buzzers open for this clue. */
  cycle: number;
  openedAt: number | null;
  /** End of the collection window in latency-adjusted mode. */
  windowEndsAt: number | null;
  /** How many attempts had arrived when the winner was decided; null until then. */
  decided: number | null;
  deadline: number | null;
  timerMs: number | null;
  /**
   * The question timer as it stood when someone buzzed in: time left and its full length.
   * It does not run while an answer is judged, and picks up from here if the buzzers reopen.
   * Null when the clue has no question timer.
   */
  held: { leftMs: number; totalMs: number } | null;
  attempts: BuzzAttempt[];
  answererId: string | null;
  /** Players who can no longer buzz on this clue. */
  excluded: string[];
  wager: { playerId: string; amount: number | null } | null;
  judgments: Judgment[];
  /** Nobody buzzed before the buzz timer ran out. */
  timedOut: boolean;
  /** The answer timer ran out; the host still decides the outcome. */
  answerTimeUp: boolean;
}

/** The dice roll that decides who picks first. See engine/dice.ts. */
export interface DiceRoll {
  /** 1 for the opening roll; one more for each tie-break. */
  round: number;
  phase: 'rolling' | 'landing' | 'tied' | 'won';
  /** Players still in it. After a tie, only the tied players. */
  contenders: string[];
  /** This round's rolls so far. */
  rolls: Record<string, number>;
  /** Players beaten in an earlier round, with the roll that put them out. */
  out: Record<string, number>;
  winnerId: string | null;
  /** While rolling: when the server rolls for anyone who has not. Otherwise: when the next phase begins. */
  deadline: number | null;
  timerMs: number | null;
}

export interface TriviaRound {
  mode: 'trivia';
  def: TriviaRoundDef;
  stage: 'intro' | 'roll' | 'board' | 'clue' | 'done';
  board: BoardCategory[];
  /** The player who picks the next clue (and plays any wager clue). */
  controlId: string | null;
  roll: DiceRoll | null;
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
  | { type: 'dice.rolled'; playerId: string; value: number }
  | { type: 'dice.tied'; playerIds: string[] }
  | { type: 'dice.won'; playerId: string }
  | { type: 'buzz.winner'; playerId: string }
  | { type: 'judged'; playerId: string; correct: boolean; delta: number }
  | { type: 'timeup'; what: 'buzz' | 'answer' | 'turn' }
  | { type: 'clue.result' }
  | { type: 'wager.locked'; playerId: string }
  | { type: 'round.ended'; index: number }
  | { type: 'fm.turn'; turn: number }
  | { type: 'fm.duplicate'; playerId: string }
  | { type: 'fm.reveal'; kind: 'answer' }
  | { type: 'fm.reveal'; kind: 'points'; points: number }
  | { type: 'fm.result'; won: boolean }
  | { type: 'final.stage'; stage: 'wager' | 'answering' | 'reveal' }
  | { type: 'final.shown'; playerId: string }
  | { type: 'game.finished' }
  | { type: 'cue'; name: CueName }
  | { type: 'paused'; paused: boolean };

export const CUE_NAMES = ['applause', 'drumroll', 'airhorn', 'sad', 'tada', 'suspense', 'confetti'] as const;
export type CueName = (typeof CUE_NAMES)[number];
